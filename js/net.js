// P2P 連線層：host 當 hub，把每則訊息轉發給除了來源以外的所有人。
// 觀戰者因此不需要跟 guest 直連，只要掛在 host 上就能看到全部戰況。

const ID_PREFIX = 'bship-';
// 拿掉 0/O/1/I 這種肉眼會看錯的字，房間碼是要用嘴巴唸給朋友聽的。
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const makeRoomCode = () =>
  Array.from({ length: 6 }, () =>
    ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

export const peerIdFor = code => ID_PREFIX + code.toUpperCase();

function loadPeerJS() {
  if (window.Peer) return Promise.resolve();
  const sources = [
    'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js',
    'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js',
  ];
  return new Promise((resolve, reject) => {
    const tryNext = i => {
      if (i >= sources.length) return reject(new Error('PeerJS 載入失敗'));
      const el = document.createElement('script');
      el.src = sources[i];
      el.onload = () => resolve();
      el.onerror = () => { el.remove(); tryNext(i + 1); };
      document.head.appendChild(el);
    };
    tryNext(0);
  });
}

export function createNet({ onMessage, onStatus, onPeersChanged }) {
  const state = {
    role: null,        // 'host' | 'guest' | 'spectator'
    code: null,
    peer: null,
    conns: new Map(),  // connId -> { conn, role, name }
    hostConn: null,    // 非 host 用：通往 host 的那條連線
    selfName: '',
    closed: false,
  };

  const peersSnapshot = () => [...state.conns.values()]
    .map(c => ({ id: c.conn.peer, role: c.role, name: c.name }));

  const notifyPeers = () => onPeersChanged?.(peersSnapshot());

  function deliver(envelope, fromConnId) {
    // host 是 hub：先轉發，再自己處理，讓所有人看到的順序一致。
    if (state.role === 'host') {
      for (const [id, entry] of state.conns) {
        if (id !== fromConnId && entry.conn.open) entry.conn.send(envelope);
      }
    }
    onMessage?.(envelope);
  }

  function wireConn(conn, knownRole) {
    const entry = { conn, role: knownRole ?? 'unknown', name: '' };
    state.conns.set(conn.peer, entry);

    conn.on('data', raw => {
      if (!raw || typeof raw !== 'object') return;
      if (raw.type === '__hello') {
        entry.role = raw.role;
        entry.name = raw.name || '';
        notifyPeers();
        onStatus?.({ kind: 'peer-joined', role: raw.role, name: entry.name, id: conn.peer });
        // host 幫新來的人補一份「現在誰在場」。
        if (state.role === 'host') {
          conn.send({ type: '__welcome', peers: peersSnapshot(), hostName: state.selfName });
        }
        return;
      }
      if (raw.type === '__welcome') {
        notifyPeers();
        onStatus?.({ kind: 'welcomed', peers: raw.peers, hostName: raw.hostName });
        return;
      }
      deliver(raw, conn.peer);
    });

    conn.on('open', () => {
      conn.send({ type: '__hello', role: state.role, name: state.selfName });
      notifyPeers();
    });

    conn.on('close', () => {
      state.conns.delete(conn.peer);
      notifyPeers();
      onStatus?.({ kind: 'peer-left', role: entry.role, name: entry.name });
    });

    conn.on('error', err => onStatus?.({ kind: 'conn-error', error: err }));
    return entry;
  }

  async function makePeer(id) {
    await loadPeerJS();
    return new Promise((resolve, reject) => {
      const peer = id ? new window.Peer(id) : new window.Peer();
      const fail = err => reject(err);
      peer.once('open', () => { peer.off('error', fail); resolve(peer); });
      peer.once('error', fail);
    });
  }

  return {
    get role() { return state.role; },
    get code() { return state.code; },
    get peers() { return peersSnapshot(); },
    setName(name) { state.selfName = name; },

    // 開房：用房間碼當 peer id，朋友才有辦法只憑碼連進來。
    async host(code, name) {
      state.role = 'host';
      state.code = code;
      state.selfName = name;
      state.peer = await makePeer(peerIdFor(code));
      state.peer.on('connection', conn => wireConn(conn));
      state.peer.on('error', err => onStatus?.({ kind: 'peer-error', error: err }));
      state.peer.on('disconnected', () => {
        if (!state.closed) state.peer.reconnect();
      });
      onStatus?.({ kind: 'hosting', code });
      return code;
    },

    // 進房：guest 是玩家，spectator 只看不打。
    async join(code, name, asSpectator = false) {
      state.role = asSpectator ? 'spectator' : 'guest';
      state.code = code.toUpperCase();
      state.selfName = name;
      state.peer = await makePeer(null);
      state.peer.on('error', err => onStatus?.({ kind: 'peer-error', error: err }));
      state.peer.on('disconnected', () => {
        if (!state.closed) state.peer.reconnect();
      });
      const conn = state.peer.connect(peerIdFor(state.code), { reliable: true });
      state.hostConn = conn;
      wireConn(conn, 'host');
      onStatus?.({ kind: 'joining', code: state.code });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('連線逾時，房間可能不存在或房主已離線')), 15000);
        conn.on('open', () => { clearTimeout(timer); resolve(); });
        conn.on('error', err => { clearTimeout(timer); reject(err); });
      });
    },

    // 送出一則遊戲訊息。host 廣播給全場；其他人送給 host，由 host 轉發。
    send(payload) {
      const envelope = { ...payload, __from: state.role, __name: state.selfName };
      if (state.role === 'host') {
        for (const entry of state.conns.values()) {
          if (entry.conn.open) entry.conn.send(envelope);
        }
      } else if (state.hostConn?.open) {
        state.hostConn.send(envelope);
      }
      return envelope;
    },

    // 只送給特定一個人（host 專用，例如補送狀態給剛進來的觀戰者）。
    sendTo(peerId, payload) {
      const entry = state.conns.get(peerId);
      if (entry?.conn.open) {
        entry.conn.send({ ...payload, __from: state.role, __name: state.selfName });
      }
    },

    destroy() {
      state.closed = true;
      for (const entry of state.conns.values()) entry.conn.close();
      state.conns.clear();
      state.peer?.destroy();
    },
  };
}
