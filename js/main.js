// 流程層：狀態機 + 網路訊息路由 + 使用者互動。
import {
  key, canPlace, emptyFleet, randomFleet, isFleetPlaced, occupancy,
  receiveFire, fleetDestroyed, remainingShips, newTracker, recordShot,
  nextTurn, cellsOf, SHIP_TYPES,
} from './game.js';
import { createNet, makeRoomCode } from './net.js';
import { sfx, setSoundEnabled, isSoundEnabled, unlockAudio } from './audio.js';
import { initBossMode } from './boss.js';
import {
  $, buildBoard, paintMyBoard, paintEnemyBoard, renderDock,
  logLine, toast, setScreen, esc, cellName,
} from './ui.js';

// ── 狀態 ─────────────────────────────────────────────
const S = {
  role: null,              // 'host' | 'guest' | 'spectator'
  name: '',
  phase: 'lobby',          // lobby | setup | battle | over
  variant: 'classic',      // classic | hit-again
  turn: null,              // 'host' | 'guest' | null(等待結果中)
  names: { host: '', guest: '' },
  ready: { host: false, guest: false },
  myFleet: emptyFleet(),
  incoming: new Map(),     // 對方打我：'x,y' -> 'hit' | 'miss'
  enemy: newTracker(),     // 我打對方的紀錄
  enemyReveal: null,       // 終局揭曉的敵方艦隊
  lastMyShot: null,
  lastEnemyShot: null,
  selectedShip: null,
  dir: 'h',
  dragging: false,
  dragOrigin: null,
  hoverCell: null,
  over: null,              // 'win' | 'lose'
  rematch: { me: false, them: false },
  // 觀戰者視角：兩邊海域各一份紀錄
  spec: { host: newTracker(), guest: newTracker() },
  specLast: { host: null, guest: null },
  specReveal: { host: null, guest: null },
  peerCount: 1,
};

const opposite = side => (side === 'host' ? 'guest' : 'host');
const isPlayer = () => S.role === 'host' || S.role === 'guest';
const isMyTurn = () => isPlayer() && S.phase === 'battle' && S.turn === S.role;
const nameOf = side => S.names[side] || (side === 'host' ? '房主' : '挑戰者');

let net = null;
let boards = { setup: null, enemy: null, mine: null };
let boss = null;

// ── 網路事件 ─────────────────────────────────────────
function onStatus(ev) {
  switch (ev.kind) {
    case 'peer-joined':
      if (S.role === 'host') {
        if (ev.role === 'guest') {
          // 已經有另一位 guest 在場（不算剛進來的這位）就是滿房。
          const otherGuest = net.peers.some(p => p.role === 'guest' && p.id !== ev.id);
          if (otherGuest) {
            net.sendTo(ev.id, { type: 'room-full' });
            return;
          }
          S.names.guest = ev.name;
          sfx('join');
          toast(`${ev.name || '挑戰者'} 進房了`, 'good');
          sysLog(`<b>${esc(ev.name || '挑戰者')}</b> 進入房間`);
          net.sendTo(ev.id, { type: 'rules', variant: S.variant, hostName: S.name });
          // 對手在戰局中途斷線又回來：舊局作廢，直接開新局。
          if (S.phase === 'battle' || S.phase === 'over') {
            sysLog('對手重新進房，開新的一局');
            resetForRematch();
          }
        } else if (ev.role === 'spectator') {
          toast(`${ev.name || '路人'} 來觀戰`, '');
          sysLog(`<b>${esc(ev.name || '路人')}</b> 進來觀戰`);
          net.sendTo(ev.id, specSnapshot());
        }
      }
      break;
    case 'welcomed':
      S.names.host = ev.hostName || S.names.host;
      break;
    case 'peer-left':
      if (S.role === 'host' && ev.role === 'guest') {
        S.names.guest = '';
        S.ready.guest = false;
        sysLog(`<b>${esc(ev.name || '挑戰者')}</b> 離線了`);
        toast('對手斷線了', 'bad');
        if (S.phase === 'battle') pauseForDisconnect();
      } else if (S.role !== 'host' && ev.role === 'host') {
        toast('房主離線，這局沒法繼續', 'bad');
        sysLog('房主離線了');
        if (S.phase === 'battle') pauseForDisconnect();
      } else if (ev.role === 'spectator') {
        sysLog(`${esc(ev.name || '路人')} 離開觀戰`);
      }
      break;
    case 'peer-error':
    case 'conn-error':
      console.warn(ev.error);
      break;
  }
  render();
}

const hasGuest = () => net.peers.some(p => p.role === 'guest');

function onPeersChanged(peers) {
  S.peerCount = peers.length + 1;
  render();
}

function onMessage(msg) {
  const from = msg.__from;
  switch (msg.type) {
    case 'room-full':
      alert('這間房已經有兩位玩家了，可以用觀戰身分進來看。');
      leaveRoom();
      return;

    case 'rules':
      S.variant = msg.variant;
      S.names.host = msg.hostName || S.names.host;
      $('chkHitAgain').checked = S.variant === 'hit-again';
      break;

    case 'ready':
      if (from === 'host' || from === 'guest') {
        S.ready[from] = true;
        S.names[from] = msg.name || S.names[from];
        sysLog(`<b>${esc(nameOf(from))}</b> 部署完成`);
        if (S.role === 'host') tryStart();
      }
      break;

    case 'start':
      startBattle(msg.first, msg.variant);
      break;

    case 'fire':
      // 觀戰者不用理 fire：結果緊接著就從被打的那方回報過來。
      if (isPlayer() && from === opposite(S.role)) handleIncomingFire(msg);
      break;

    case 'result':
      if (isPlayer() && from === opposite(S.role)) handleShotResult(msg);
      else if (S.role === 'spectator') specResult(msg);
      break;

    case 'reveal':
      if (S.role === 'spectator') S.specReveal[from] = msg.fleet;
      else if (from === opposite(S.role)) S.enemyReveal = msg.fleet;
      break;

    case 'chat':
      chatLine(msg.__name || from, msg.text, false);
      sfx('chat');
      break;

    case 'rematch':
      if (isPlayer() && from === opposite(S.role)) {
        S.rematch.them = true;
        $('rematchNote').hidden = false;
        $('rematchNote').textContent = `${nameOf(from)} 想再來一局`;
        if (S.rematch.me) resetForRematch();
      }
      break;

    case 'rematch-go':
      // host 廣播的正式重開，觀戰者靠這個清盤。
      if (S.role === 'spectator') resetForRematch();
      break;

    case 'spec-sync':
      if (S.role === 'spectator') applySpecSnapshot(msg);
      break;
  }
  render();
}

// ── 開房 / 進房 ───────────────────────────────────────
async function hostRoom() {
  const name = pickName();
  const code = makeRoomCode();
  showLobbyError('');
  setBusy(true);
  try {
    net = createNet({ onMessage, onStatus, onPeersChanged });
    await net.host(code, name);
    S.role = 'host';
    S.name = name;
    S.names.host = name;
    S.phase = 'setup';
    location.hash = code;
    enterSetup();
    sysLog(`房間 <b>${code}</b> 已開，把連結丟給朋友吧`);
  } catch (err) {
    showLobbyError(describeError(err));
    net?.destroy();
    net = null;
  } finally {
    setBusy(false);
  }
}

async function joinRoom() {
  const name = pickName();
  const code = $('inpCode').value.trim().toUpperCase();
  const spectate = $('chkSpectate').checked;
  if (code.length !== 6) return showLobbyError('房間碼是 6 個字');
  showLobbyError('');
  setBusy(true);
  try {
    net = createNet({ onMessage, onStatus, onPeersChanged });
    await net.join(code, name, spectate);
    S.role = spectate ? 'spectator' : 'guest';
    S.name = name;
    if (!spectate) S.names.guest = name;
    location.hash = code;
    if (spectate) {
      S.phase = 'battle';
      enterBattle();
      sysLog('以觀戰身分進入，等待戰況同步…');
    } else {
      S.phase = 'setup';
      enterSetup();
      sysLog(`已加入房間 <b>${code}</b>`);
    }
  } catch (err) {
    showLobbyError(describeError(err));
    net?.destroy();
    net = null;
  } finally {
    setBusy(false);
  }
}

function pickName() {
  const raw = $('inpName').value.trim();
  const name = raw || `上將${Math.floor(Math.random() * 900 + 100)}`;
  try { localStorage.setItem('bship-name', name); } catch {}
  return name;
}

function describeError(err) {
  const t = err?.type || '';
  if (t === 'peer-unavailable') return '找不到這個房間，確認一下房間碼？';
  if (t === 'unavailable-id') return '這個房間碼撞號了，再開一次。';
  if (t === 'network' || t === 'server-error') return '連不上配對伺服器，檢查一下網路。';
  return err?.message || '連線失敗';
}

function showLobbyError(text) {
  const el = $('lobbyError');
  el.hidden = !text;
  el.textContent = text;
}

function setBusy(on) {
  $('btnHost').disabled = on;
  $('btnJoin').disabled = on;
}

function leaveRoom() {
  net?.destroy();
  history.replaceState(null, '', location.pathname);
  location.reload();
}

// ── 擺船階段 ─────────────────────────────────────────
function enterSetup() {
  setScreen('screenSetup');
  $('roomCode').textContent = net.code;
  $('rulesBox').classList.toggle('locked', S.role !== 'host');
  $('rulesNote').textContent = S.role === 'host'
    ? '房主決定規則，開戰前都能改。'
    : '規則由房主決定。';
  render();
}

function selectShip(id) {
  const ship = S.myFleet.find(s => s.id === id);
  if (!ship) return;
  S.selectedShip = id;
  if (ship.x != null) S.dir = ship.dir;
  render();
}

function liftShip(id) {
  const ship = S.myFleet.find(s => s.id === id);
  if (!ship) return;
  ship.x = null; ship.y = null;
  S.selectedShip = id;
}

function placeSelected(x, y) {
  const ship = S.myFleet.find(s => s.id === S.selectedShip);
  if (!ship) return false;
  if (!canPlace(S.myFleet, ship, x, y, S.dir)) return false;
  ship.x = x; ship.y = y; ship.dir = S.dir;
  // 自動跳到下一艘還沒放的船，少點幾下。
  const next = S.myFleet.find(s => s.x == null);
  S.selectedShip = next ? next.id : null;
  if (next) S.dir = 'h';
  return true;
}

function rotate() {
  S.dir = S.dir === 'h' ? 'v' : 'h';
  const ship = S.myFleet.find(s => s.id === S.selectedShip);
  // 已經放好的船，旋轉要就地轉；轉不進去就退回原方向。
  if (ship && ship.x != null) {
    const backup = ship.dir;
    ship.dir = S.dir;
    if (!canPlace(S.myFleet, ship, ship.x, ship.y, S.dir)) {
      ship.dir = backup; S.dir = backup;
      toast('這個方向擺不下', 'bad');
    }
  }
  render();
}

function setupCellAt(target) {
  const cell = target?.closest?.('.cell');
  if (!cell || !boards.setup) return null;
  return { x: +cell.dataset.x, y: +cell.dataset.y };
}

function bindSetupInteractions() {
  const dock = $('shipDock');
  const board = $('setupBoard');

  dock.addEventListener('pointerdown', e => {
    const li = e.target.closest('.dock-item');
    if (!li) return;
    e.preventDefault();
    unlockAudio();
    const ship = S.myFleet.find(s => s.id === li.dataset.shipId);
    if (ship?.x != null) liftShip(ship.id);
    selectShip(li.dataset.shipId);
    S.dragging = true;
  });

  board.addEventListener('pointerdown', e => {
    const pos = setupCellAt(e.target);
    if (!pos) return;
    e.preventDefault();
    unlockAudio();
    const occ = occupancy(S.myFleet).get(key(pos.x, pos.y));
    if (S.selectedShip && !occ) {
      if (placeSelected(pos.x, pos.y)) sfx('turn');
      else toast('放不下，換個位置', 'bad');
    } else if (occ) {
      // 點在船上：拿起來。記住起點，純點擊（沒拖動）就讓船留在手上，
      // 拖到別處放開才算移動。
      liftShip(occ.ship.id);
      S.dir = occ.ship.dir;
      S.dragging = true;
      S.dragOrigin = key(pos.x, pos.y);
    }
    render();
  });

  board.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (S.phase === 'setup') rotate();
  });

  document.addEventListener('pointermove', e => {
    if (S.phase !== 'setup') return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const pos = setupCellAt(el);
    const k = pos ? key(pos.x, pos.y) : null;
    if (k !== S.hoverCell) {
      S.hoverCell = k;
      paintSetupBoard();
    }
  });

  document.addEventListener('pointerup', e => {
    if (!S.dragging) return;
    S.dragging = false;
    const origin = S.dragOrigin;
    S.dragOrigin = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const pos = setupCellAt(el);
    if (pos && S.selectedShip && key(pos.x, pos.y) !== origin) {
      if (placeSelected(pos.x, pos.y)) sfx('turn');
    }
    render();
  });

  document.addEventListener('keydown', e => {
    if (S.phase !== 'setup') return;
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') rotate();
  });

  $('btnRotate').addEventListener('click', rotate);
  $('btnRandom').addEventListener('click', () => {
    unlockAudio();
    S.myFleet = randomFleet();
    S.selectedShip = null;
    sfx('turn');
    render();
  });
  $('btnClear').addEventListener('click', () => {
    S.myFleet = emptyFleet();
    S.selectedShip = S.myFleet[0].id;
    S.dir = 'h';
    render();
  });
  $('chkHitAgain').addEventListener('change', e => {
    if (S.role !== 'host') return;
    S.variant = e.target.checked ? 'hit-again' : 'classic';
    net.send({ type: 'rules', variant: S.variant, hostName: S.name });
  });
  $('btnReady').addEventListener('click', markReady);
}

function markReady() {
  if (!isFleetPlaced(S.myFleet)) return;
  S.ready[S.role] = true;
  $('btnReady').disabled = true;
  $('btnReady').textContent = '已準備，等對手…';
  net.send({ type: 'ready', name: S.name });
  sysLog('你已部署完成');
  if (S.role === 'host') tryStart();
  render();
}

function tryStart() {
  if (S.role !== 'host' || S.phase !== 'setup') return;
  if (!(S.ready.host && S.ready.guest)) return;
  const first = Math.random() < 0.5 ? 'host' : 'guest';
  net.send({ type: 'start', first, variant: S.variant });
  startBattle(first, S.variant);
}

function paintSetupBoard() {
  if (!boards.setup) return;
  paintMyBoard(boards.setup, S.myFleet, new Map(), null);
  const ship = S.myFleet.find(s => s.id === S.selectedShip);
  if (!ship || !S.hoverCell) return;
  const [hx, hy] = S.hoverCell.split(',').map(Number);
  const ok = canPlace(S.myFleet, ship, hx, hy, S.dir);
  for (const c of cellsOf({ ...ship, x: hx, y: hy, dir: S.dir })) {
    boards.setup.get(key(c.x, c.y))?.classList.add(ok ? 'preview-ok' : 'preview-bad');
  }
}

// ── 對戰階段 ─────────────────────────────────────────
function startBattle(first, variant) {
  S.variant = variant;
  S.turn = first;
  S.phase = 'battle';
  S.over = null;
  S.rematch = { me: false, them: false };
  enterBattle();
  sysLog(`開戰！<b>${esc(nameOf(first))}</b> 先手${variant === 'hit-again' ? '（命中可連射）' : ''}`);
  sfx('join');
  render();
}

function enterBattle() {
  setScreen('screenBattle');
  $('roomCode').textContent = net.code;
  $('overlay').hidden = true;
  render();
}

function fire(x, y) {
  if (!isMyTurn()) return;
  if (S.enemy.shots.has(key(x, y))) return;
  unlockAudio();
  S.turn = null;  // 等結果回來前先鎖住，免得手抖連點
  net.send({ type: 'fire', x, y });
  sfx('fire');
  render();
}

function handleIncomingFire(msg) {
  if (S.phase !== 'battle') return;
  const { x, y } = msg;
  const k = key(x, y);
  if (S.incoming.has(k)) return; // 重複封包直接吃掉
  const res = receiveFire(S.myFleet, x, y);
  S.incoming.set(k, res.hit ? 'hit' : 'miss');
  S.lastEnemyShot = k;
  const dead = fleetDestroyed(S.myFleet);
  net.send({ type: 'result', x, y, hit: res.hit, sunk: res.sunk, dead });
  S.turn = dead ? null : nextTurn(opposite(S.role), S.role, res.hit, S.variant);

  const who = `<b>${esc(nameOf(opposite(S.role)))}</b>`;
  if (res.sunk) {
    logLine($('battleLog'), `${who} 擊沉了你的 <b>${res.sunk.name}</b>！（${cellName(x, y)}）`, 'sunk');
    sfx('sunk');
  } else if (res.hit) {
    logLine($('battleLog'), `${who} 命中 ${cellName(x, y)}`, 'hit');
    sfx('hit');
  } else {
    logLine($('battleLog'), `${who} 打到 ${cellName(x, y)} 落空`, 'miss');
    sfx('miss');
  }
  if (dead) {
    net.send({ type: 'reveal', fleet: S.myFleet });
    endGame('lose');
  } else if (S.turn === S.role) {
    sfx('turn');
  }
}

function handleShotResult(msg) {
  if (S.phase !== 'battle') return;
  const k = key(msg.x, msg.y);
  if (S.enemy.shots.has(k)) return; // 重複封包
  recordShot(S.enemy, msg);
  S.lastMyShot = k;
  S.turn = msg.dead ? null : nextTurn(S.role, opposite(S.role), msg.hit, S.variant);

  if (msg.sunk) {
    logLine($('battleLog'), `你擊沉了對方的 <b>${esc(msg.sunk.name)}</b>！（${cellName(msg.x, msg.y)}）`, 'sunk');
    sfx('sunk');
  } else if (msg.hit) {
    logLine($('battleLog'), `你命中 ${cellName(msg.x, msg.y)}`, 'hit');
    sfx('hit');
  } else {
    logLine($('battleLog'), `你打 ${cellName(msg.x, msg.y)} 落空`, 'miss');
    sfx('miss');
  }
  if (msg.dead) {
    net.send({ type: 'reveal', fleet: S.myFleet });
    endGame('win');
  }
}

function endGame(result) {
  S.over = result;
  S.phase = 'over';
  S.turn = null;
  const win = result === 'win';
  $('overMark').textContent = win ? '🏆' : '💥';
  $('overTitle').textContent = win ? '勝利' : '艦隊全滅';
  $('overSub').textContent = win
    ? `你把 ${nameOf(opposite(S.role))} 的艦隊全部送進海底。`
    : `${nameOf(opposite(S.role))} 把你打得片甲不留。`;
  $('rematchNote').hidden = !S.rematch.them;
  $('btnRematch').disabled = false;
  $('btnRematch').textContent = '再來一局';
  $('overlay').hidden = false;
  sysLog(win ? '<b>你贏了！</b>' : '<b>你輸了。</b>');
  sfx(win ? 'win' : 'lose');
  render();
}

function pauseForDisconnect() {
  S.turn = null;
  render();
}

function requestRematch() {
  if (S.rematch.me) return;
  S.rematch.me = true;
  $('btnRematch').disabled = true;
  $('btnRematch').textContent = '等待對手…';
  net.send({ type: 'rematch' });
  if (S.rematch.them) resetForRematch();
}

function resetForRematch() {
  S.myFleet = emptyFleet();
  S.incoming = new Map();
  S.enemy = newTracker();
  S.enemyReveal = null;
  S.lastMyShot = null;
  S.lastEnemyShot = null;
  S.ready = { host: false, guest: false };
  S.rematch = { me: false, them: false };
  S.over = null;
  S.turn = null;
  S.selectedShip = S.myFleet[0].id;
  S.dir = 'h';
  S.spec = { host: newTracker(), guest: newTracker() };
  S.specLast = { host: null, guest: null };
  S.specReveal = { host: null, guest: null };
  $('overlay').hidden = true;
  $('btnReady').disabled = false;
  $('btnReady').textContent = '準備完成';
  $('battleLog').innerHTML = '';
  if (S.role === 'host') net.send({ type: 'rematch-go' });
  if (isPlayer()) {
    S.phase = 'setup';
    enterSetup();
    sysLog('新的一局，重新部署艦隊');
  } else {
    S.phase = 'battle';
    sysLog('雙方重新部署中…');
    render();
  }
}

// ── 觀戰 ─────────────────────────────────────────────
function specResult(msg) {
  const side = msg.__from;           // 被打的那方
  const shooter = opposite(side);
  recordShot(S.spec[side], msg);
  S.specLast[side] = key(msg.x, msg.y);
  S.turn = msg.dead ? null : nextTurn(shooter, side, msg.hit, S.variant);
  const who = `<b>${esc(nameOf(shooter))}</b>`;
  if (msg.sunk) {
    logLine($('battleLog'), `${who} 擊沉 ${esc(nameOf(side))} 的 <b>${esc(msg.sunk.name)}</b>`, 'sunk');
    sfx('sunk');
  } else if (msg.hit) {
    logLine($('battleLog'), `${who} 命中 ${cellName(msg.x, msg.y)}`, 'hit');
    sfx('hit');
  } else {
    logLine($('battleLog'), `${who} 打 ${cellName(msg.x, msg.y)} 落空`, 'miss');
    sfx('miss');
  }
  if (msg.dead) {
    S.phase = 'over';
    $('turnText').textContent = `${nameOf(shooter)} 獲勝！`;
    sysLog(`<b>${esc(nameOf(shooter))}</b> 獲勝`);
    sfx('win');
  }
}

const serializeTracker = t => ({
  shots: [...t.shots.entries()],
  sunkShips: t.sunkShips,
});
const deserializeTracker = raw => ({
  shots: new Map(raw?.shots || []),
  sunkShips: raw?.sunkShips || [],
});

// host 把「目前公開的戰況」打包給剛進來的觀戰者。
// host 自己知道：對方打我的紀錄（incoming + 我方艦隊）、我打對方的紀錄（enemy）。
function specSnapshot() {
  const hostSide = newTracker();
  const occ = occupancy(S.myFleet);
  for (const [k, kind] of S.incoming) {
    if (kind === 'miss') { hostSide.shots.set(k, 'miss'); continue; }
    const ship = occ.get(k)?.ship;
    hostSide.shots.set(k, ship && ship.hits.length === ship.size ? 'sunk' : 'hit');
  }
  hostSide.sunkShips = S.myFleet
    .filter(s => s.x != null && s.hits.length === s.size)
    .map(s => ({ id: s.id, name: s.name, cells: cellsOf(s) }));
  return {
    type: 'spec-sync',
    phase: S.phase,
    variant: S.variant,
    turn: S.turn,
    names: S.names,
    host: serializeTracker(hostSide),
    guest: serializeTracker(S.enemy),
    hostReveal: S.phase === 'over' ? S.myFleet : null,
    guestReveal: S.phase === 'over' ? S.enemyReveal : null,
  };
}

function applySpecSnapshot(msg) {
  // 觀戰者只有「看戰況」一種畫面；雙方還在擺船時就當空盤顯示。
  S.phase = msg.phase === 'over' ? 'over' : 'battle';
  S.variant = msg.variant;
  S.turn = msg.turn;
  S.names = { ...S.names, ...msg.names };
  S.spec.host = deserializeTracker(msg.host);
  S.spec.guest = deserializeTracker(msg.guest);
  S.specReveal = { host: msg.hostReveal, guest: msg.guestReveal };
  sysLog('戰況已同步');
}

// ── 聊天 / 戰報 ──────────────────────────────────────
function sysLog(html) {
  logLine($('battleLog'), html, 'sys');
}

function chatLine(who, text, self) {
  logLine($('chatLog'), `<b>${esc(who)}</b>　${esc(text)}`, self ? 'self' : '');
  if ($('chatPane').hidden && !self) $('tabChat').classList.add('badge');
}

function bindChat() {
  $('chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text || !net) return;
    $('chatInput').value = '';
    net.send({ type: 'chat', text });
    chatLine(S.name, text, true);
  });

  const switchTab = tab => {
    const chat = tab === 'chat';
    $('chatPane').hidden = !chat;
    $('battleLog').hidden = chat;
    $('tabChat').classList.toggle('active', chat);
    $('tabLog').classList.toggle('active', !chat);
    if (chat) { $('tabChat').classList.remove('badge'); $('chatInput').focus(); }
  };
  $('tabLog').addEventListener('click', () => switchTab('log'));
  $('tabChat').addEventListener('click', () => switchTab('chat'));
}

// ── 渲染 ─────────────────────────────────────────────
function render() {
  $('peerCount').textContent = `👥 ${S.peerCount}`;
  // 上班模式的暗號：輪到我 = 狀態列多一個 error。
  boss?.setSignal(isMyTurn());

  if (S.phase === 'setup') {
    renderDock($('shipDock'), S.myFleet, S.selectedShip);
    paintSetupBoard();
    const placed = isFleetPlaced(S.myFleet);
    $('btnReady').disabled = !placed || S.ready[S.role];
    const other = opposite(S.role);
    const otherHere = S.role === 'host' ? hasGuest() : true;
    $('setupStatus').textContent = !otherHere
      ? '等待對手進房…'
      : S.ready[other]
        ? `${nameOf(other)} 已就緒，就差你了`
        : `${nameOf(other)} 還在部署`;
    $('setupHint').textContent = placed
      ? '全艦隊已就位。點船可以重新調整。'
      : '選一艘船，再點棋盤放下。按 R 或右鍵旋轉。';
    return;
  }

  if (S.phase === 'battle' || S.phase === 'over') {
    if (S.role === 'spectator') return renderSpectator();

    const me = S.role, them = opposite(S.role);
    $('enemyTitle').textContent = `${nameOf(them)} 的海域`;
    $('myTitle').textContent = '我方海域';
    $('enemyFleetStatus').textContent =
      `已擊沉 ${S.enemy.sunkShips.length} / ${SHIP_TYPES.length} 艘`;
    $('myFleetStatus').textContent =
      `剩餘 ${remainingShips(S.myFleet)} / ${SHIP_TYPES.length} 艘`;

    paintEnemyBoard(boards.enemy, S.enemy, S.lastMyShot, S.enemyReveal);
    paintMyBoard(boards.mine, S.myFleet, S.incoming, S.lastEnemyShot);

    const banner = $('turnBanner');
    banner.className = 'turn-banner';
    if (S.phase === 'over') {
      banner.classList.add('over');
      $('turnText').textContent = S.over === 'win' ? '你贏了 🏆' : '艦隊全滅 💥';
    } else if (S.turn === me) {
      banner.classList.add('mine');
      $('turnText').textContent = '輪到你了，選一格開火';
    } else if (S.turn === them) {
      banner.classList.add('theirs');
      $('turnText').textContent = `等 ${nameOf(them)} 出手…`;
    } else {
      banner.classList.add('theirs');
      $('turnText').textContent = '砲彈飛行中…';
    }
    $('enemyBoard').classList.toggle('live', isMyTurn());
    $('enemyLock').hidden = isMyTurn() || S.phase === 'over';
    $('enemyLock').querySelector('span').textContent =
      S.turn === them ? `等 ${nameOf(them)} 出手…` : '砲彈飛行中…';
  }
}

function renderSpectator() {
  $('enemyTitle').textContent = `${nameOf('host')} 的海域`;
  $('myTitle').textContent = `${nameOf('guest')} 的海域`;
  $('enemyFleetStatus').textContent = `被擊沉 ${S.spec.host.sunkShips.length} / ${SHIP_TYPES.length} 艘`;
  $('myFleetStatus').textContent = `被擊沉 ${S.spec.guest.sunkShips.length} / ${SHIP_TYPES.length} 艘`;
  paintEnemyBoard(boards.enemy, S.spec.host, S.specLast.host, S.specReveal.host);
  paintEnemyBoard(boards.mine, S.spec.guest, S.specLast.guest, S.specReveal.guest);
  $('enemyBoard').classList.remove('live');
  $('enemyLock').hidden = true;
  const banner = $('turnBanner');
  banner.className = 'turn-banner theirs';
  if (S.phase === 'over') {
    banner.className = 'turn-banner over';
  } else if (S.turn) {
    $('turnText').textContent = `輪到 ${nameOf(S.turn)}`;
  } else {
    $('turnText').textContent = '觀戰中';
  }
}

// ── 啟動 ─────────────────────────────────────────────
function init() {
  boards.setup = buildBoard($('setupBoard'));
  boards.enemy = buildBoard($('enemyBoard'));
  boards.mine = buildBoard($('myBoard'));

  try {
    const saved = localStorage.getItem('bship-name');
    if (saved) $('inpName').value = saved;
  } catch {}

  const hashCode = location.hash.replace('#', '').trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(hashCode)) {
    $('inpCode').value = hashCode;
    $('inpCode').closest('.join-row').style.boxShadow = '0 0 0 3px rgba(52,226,208,.18)';
  }

  $('btnHost').addEventListener('click', () => { unlockAudio(); hostRoom(); });
  $('btnJoin').addEventListener('click', () => { unlockAudio(); joinRoom(); });
  $('inpCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  $('inpName').addEventListener('keydown', e => {
    if (e.key === 'Enter') ($('inpCode').value ? joinRoom() : hostRoom());
  });

  $('btnShare').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}#${net.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('邀請連結已複製', 'good');
    } catch {
      prompt('複製這個連結給朋友：', url);
    }
  });

  $('btnSound').addEventListener('click', () => {
    const on = !isSoundEnabled();
    setSoundEnabled(on);
    $('btnSound').textContent = on ? '🔊' : '🔇';
    $('btnSound').setAttribute('aria-pressed', String(on));
    if (on) unlockAudio();
  });

  // 進上班模式先靜音，出來照原本的設定還原。
  let soundBeforeBoss = true;
  boss = initBossMode({
    onEnter() {
      soundBeforeBoss = isSoundEnabled();
      setSoundEnabled(false);
    },
    onExit() {
      setSoundEnabled(soundBeforeBoss);
      if (soundBeforeBoss) unlockAudio();
    },
  });
  $('btnBoss').addEventListener('click', () => boss.enter());

  $('btnLeave').addEventListener('click', () => {
    if (S.phase === 'lobby' || confirm('確定離開房間？')) leaveRoom();
  });
  $('btnBackLobby').addEventListener('click', leaveRoom);
  $('btnRematch').addEventListener('click', requestRematch);

  $('enemyBoard').addEventListener('click', e => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    fire(+cell.dataset.x, +cell.dataset.y);
  });

  bindSetupInteractions();
  bindChat();

  S.selectedShip = S.myFleet[0].id;
  setScreen('screenLobby');
  window.addEventListener('beforeunload', () => net?.destroy());
}

init();
