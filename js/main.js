// 流程層：狀態機 + 網路訊息路由 + 使用者互動。
import {
  key, inBounds, canPlace, emptyFleet, randomFleet, isFleetPlaced, occupancy,
  receiveFire, fleetDestroyed, remainingShips, newTracker, recordShot,
  cellsOf, SHIP_TYPES,
} from './game.js';
import {
  AUG, AUGMENTS, TIER_NAME, PICK_EVERY, rollOffers, crossCells, squareCells,
  nearShip, sonarPresent, randomDecoy, randomShipCell, isUndamaged,
  relocateUndamaged, decoyAsShip, resolveCell,
} from './hex.js';
import { createNet, makeRoomCode } from './net.js';
import { sfx, setSoundEnabled, isSoundEnabled, unlockAudio } from './audio.js';
import { initBossMode } from './boss.js';
import { initExcelMode } from './excel.js';
import {
  $, buildBoard, paintMyBoard, paintEnemyBoard, renderDock,
  logLine, toast, setScreen, esc, cellName,
} from './ui.js';

// ── 狀態 ─────────────────────────────────────────────
const freshAug = () => ({ owned: [], used: {} });

const S = {
  role: null,              // 'host' | 'guest' | 'spectator'
  name: '',
  phase: 'lobby',          // lobby | setup | battle | over
  variant: 'classic',      // classic | hit-again
  mayhem: false,           // 海克斯大亂鬥
  turn: null,              // 'host' | 'guest' | null(等待結果中)
  names: { host: '', guest: '' },
  ready: { host: false, guest: false },
  myFleet: emptyFleet(),
  incoming: new Map(),     // 對方打我：'x,y' -> 'hit' | 'miss' | 'armor'
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
  gameId: 0,               // 每開一局 +1，讓 Excel 模式的終局對話框每局只跳一次
  seq: 0,                  // 我發出的 fire 序號，結果會回帶，用來丟重複封包
  lastSeq: 0,              // 我收到的 result 最大序號
  lastInSeq: 0,            // 我收到的 fire 最大序號（守方去重）
  // ── 大亂鬥（兩邊都看得到的公開狀態） ──
  aug: { host: freshAug(), guest: freshAug() },
  shotsFired: { host: 0, guest: 0 },   // 開火次數，決定何時選強化
  turnShots: { host: 0, guest: 0 },    // 這一輪已開幾槍（背水一戰用）
  extra: { host: 0, guest: 0 },        // 額外射擊次數（幽靈艦被擊沉時給防守方）
  pickedAt: new Set(),                 // 已經在哪些開火次數選過了
  pending: null,                       // 正在選的三個強化 id
  mode: null,                          // null | sonar | cross | blink | blink-place
  blink: null,                         // 躍遷中撿起的船原位（取消用）
  missStreak: 0,                       // 機率補償：連續落空
  // ── 大亂鬥（只有我自己知道的防守狀態） ──
  decoy: null,                         // { cells, hits }
  armorHits: new Map(),
};

const opposite = side => (side === 'host' ? 'guest' : 'host');
const isPlayer = () => S.role === 'host' || S.role === 'guest';
const isMyTurn = () => isPlayer() && S.phase === 'battle' && S.turn === S.role;
const nameOf = side => S.names[side] || (side === 'host' ? '房主' : '挑戰者');
const has = (side, id) => S.mayhem && !!S.aug[side]?.owned.includes(id);
const usedUp = (side, id) => !!S.aug[side]?.used[id];
// 這格能不能再打：沒打過、或只是裝甲彈開 / 情報標記。
const canTarget = (tracker, k) => {
  const v = tracker.shots.get(k);
  return !v || v === 'armor' || v === 'intel';
};

let net = null;
let boards = { setup: null, enemy: null, mine: null };
let boss = null;   // 假 VSCode（純遮羞布）
let excel = null;  // 假 Excel（可以在裡面打）

// ── 網路事件 ─────────────────────────────────────────
function onStatus(ev) {
  switch (ev.kind) {
    case 'peer-joined':
      if (S.role === 'host') {
        if (ev.role === 'guest') {
          const otherGuest = net.peers.some(p => p.role === 'guest' && p.id !== ev.id);
          if (otherGuest) {
            net.sendTo(ev.id, { type: 'room-full' });
            return;
          }
          S.names.guest = ev.name;
          sfx('join');
          toast(`${ev.name || '挑戰者'} 進房了`, 'good');
          sysLog(`<b>${esc(ev.name || '挑戰者')}</b> 進入房間`);
          net.sendTo(ev.id, rulesMsg());
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
const rulesMsg = () => ({ type: 'rules', variant: S.variant, mayhem: S.mayhem, hostName: S.name });

function onPeersChanged(peers) {
  S.peerCount = peers.length + 1;
  render();
}

function onMessage(msg) {
  const from = msg.__from;
  const fromOpp = isPlayer() && from === opposite(S.role);
  switch (msg.type) {
    case 'room-full':
      alert('這間房已經有兩位玩家了，可以用觀戰身分進來看。');
      leaveRoom();
      return;

    case 'rules':
      S.variant = msg.variant;
      S.mayhem = !!msg.mayhem;
      S.names.host = msg.hostName || S.names.host;
      $('chkHitAgain').checked = S.variant === 'hit-again';
      $('chkMayhem').checked = S.mayhem;
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
      startBattle(msg.first, msg.variant, !!msg.mayhem);
      break;

    case 'fire':
      if (fromOpp) handleIncomingFire(msg);
      break;

    case 'result':
      if (fromOpp) handleShotResult(msg);
      else if (S.role === 'spectator') specResult(msg);
      break;

    case 'reveal':
      if (S.role === 'spectator') S.specReveal[from] = msg.fleet;
      else if (fromOpp) S.enemyReveal = msg.fleet;
      break;

    case 'chat':
      chatLine(msg.__name || from, msg.text, false);
      sfx('chat');
      break;

    case 'rematch':
      if (fromOpp) {
        S.rematch.them = true;
        $('rematchNote').hidden = false;
        $('rematchNote').textContent = `${nameOf(from)} 想再來一局`;
        if (S.rematch.me) resetForRematch();
      }
      break;

    case 'rematch-go':
      if (S.role === 'spectator') resetForRematch();
      break;

    case 'spec-sync':
      if (S.role === 'spectator') applySpecSnapshot(msg);
      break;

    // ── 大亂鬥 ──
    case 'picking':
      if (from === 'host' || from === 'guest') sysLog(`<b>${esc(nameOf(from))}</b> 正在選擇海克斯強化…`);
      break;

    case 'pick':
      // 重複封包不能讓同一個強化列兩次。
      if ((from === 'host' || from === 'guest') && AUG[msg.id] && !S.aug[from].owned.includes(msg.id)) {
        S.aug[from].owned.push(msg.id);
        logLine($('battleLog'), `<b>${esc(nameOf(from))}</b> 選了 ⚡ <b>${AUG[msg.id].name}</b>`, 'sys');
        if (fromOpp && msg.id === 'intel') { /* 對方會另外送 intel-req */ }
      }
      break;

    case 'intel-req':
      if (fromOpp) {
        const c = randomShipCell(S.myFleet);
        net.send({ type: 'intel', x: c?.x ?? null, y: c?.y ?? null });
        sysLog('對方的內線情報拿到了你一格船位');
      }
      break;

    case 'intel':
      if (fromOpp && msg.x != null) {
        const k = key(msg.x, msg.y);
        if (canTarget(S.enemy, k)) S.enemy.shots.set(k, 'intel');
        logLine($('battleLog'), `📡 內線情報：<b>${cellName(msg.x, msg.y)}</b> 有船`, 'sys');
        sfx('turn');
      }
      break;

    case 'sonar':
      if (fromOpp) {
        const present = sonarPresent(defense(), msg.x, msg.y);
        net.send({ type: 'sonar-result', x: msg.x, y: msg.y, present });
        logLine($('battleLog'), `<b>${esc(nameOf(from))}</b> 用聲納掃了 ${cellName(msg.x, msg.y)} 一帶：${present ? '有船' : '沒船'}`, 'sys');
        setTurn(S.role);
      }
      break;

    case 'sonar-result':
      if (fromOpp) {
        for (const c of squareCells(msg.x, msg.y)) {
          const k = key(c.x, c.y);
          if (canTarget(S.enemy, k)) S.enemy.sonar.set(k, msg.present ? 'yes' : 'no');
        }
        logLine($('battleLog'), `🔊 聲納 ${cellName(msg.x, msg.y)} 周圍 3×3：<b>${msg.present ? '有船' : '沒船'}</b>`, msg.present ? 'hit' : 'miss');
        sfx(msg.present ? 'hit' : 'miss');
        setTurn(opposite(S.role));
      } else if (S.role === 'spectator') {
        logLine($('battleLog'), `<b>${esc(nameOf(opposite(from)))}</b> 聲納掃描 ${cellName(msg.x, msg.y)}：${msg.present ? '有船' : '沒船'}`, 'sys');
        setTurn(from);
      }
      break;

    case 'blink':
    case 'rebuild':
      if (from === 'host' || from === 'guest') {
        const what = msg.type === 'blink' ? '緊急躍遷，有一艘船換位了' : '艦隊重組，未受損的船全部換位';
        logLine($('battleLog'), `<b>${esc(nameOf(from))}</b> 發動${what}`, 'sys');
        if (from !== S.role) setTurn(opposite(from));
        sfx('turn');
      }
      break;

    case 'kamikaze-hit':
      // from = 被我擊沉後自爆反擊的一方，(x,y) 是我方一格被必中的船位；
      // 訊息由「我」（被反擊者）發出、對方（擁有同歸於盡者）接收記錄。
      if (fromOpp && S.phase === 'battle') {
        const k = key(msg.x, msg.y);
        recordShot(S.enemy, { x: msg.x, y: msg.y, hit: true, sunk: msg.sunk });
        S.lastMyShot = k;
        logLine($('battleLog'), `💥 同歸於盡反擊命中 <b>${cellName(msg.x, msg.y)}</b>${msg.sunk ? `，擊沉 <b>${esc(msg.sunk.name)}</b>` : ''}`, msg.sunk ? 'sunk' : 'hit');
        sfx(msg.sunk ? 'sunk' : 'hit');
        if (msg.dead) { net.send({ type: 'reveal', fleet: S.myFleet }); endGame('win'); }
      } else if (S.role === 'spectator') {
        recordShot(S.spec[from], { x: msg.x, y: msg.y, hit: true, sunk: msg.sunk });
        logLine($('battleLog'), `💥 ${esc(nameOf(opposite(from)))} 的同歸於盡反擊命中 ${cellName(msg.x, msg.y)}`, 'hit');
      }
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

// 擺船／躍遷共用：躍遷時還要避開假船與所有已被打過的格子，
// 不然船躲到對方的落空標記底下就永遠打不到了。
function placementBlockers() {
  if (S.phase !== 'battle') return [];
  const out = [];
  if (S.decoy) out.push({ id: '__decoy', ...decoyAsShip(S.decoy) });
  for (const k of S.incoming.keys()) {
    const [x, y] = k.split(',').map(Number);
    out.push({ id: '__shot' + k, x, y, dir: 'h', size: 1 });
  }
  return out;
}

function placeSelected(x, y) {
  const ship = S.myFleet.find(s => s.id === S.selectedShip);
  if (!ship) return false;
  if (!canPlace([...S.myFleet, ...placementBlockers()], ship, x, y, S.dir)) return false;
  ship.x = x; ship.y = y; ship.dir = S.dir;
  if (S.phase === 'setup') {
    const next = S.myFleet.find(s => s.x == null);
    S.selectedShip = next ? next.id : null;
    if (next) S.dir = 'h';
  }
  return true;
}

function rotate() {
  S.dir = S.dir === 'h' ? 'v' : 'h';
  const ship = S.myFleet.find(s => s.id === S.selectedShip);
  if (ship && ship.x != null) {
    const backup = ship.dir;
    ship.dir = S.dir;
    if (!canPlace([...S.myFleet, ...placementBlockers()], ship, ship.x, ship.y, S.dir)) {
      ship.dir = backup; S.dir = backup;
      toast('這個方向擺不下', 'bad');
    }
  }
  render();
}

function cellAt(target, boardEl) {
  const cell = target?.closest?.('.cell');
  if (!cell || !boardEl.contains(cell)) return null;
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
    const pos = cellAt(e.target, board);
    if (!pos) return;
    e.preventDefault();
    unlockAudio();
    const occ = occupancy(S.myFleet).get(key(pos.x, pos.y));
    if (S.selectedShip && !occ) {
      if (placeSelected(pos.x, pos.y)) sfx('turn');
      else toast('放不下，換個位置', 'bad');
    } else if (occ) {
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
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (S.phase === 'setup') {
      const pos = cellAt(el, board);
      const k = pos ? key(pos.x, pos.y) : null;
      if (k !== S.hoverCell) { S.hoverCell = k; paintSetupBoard(); }
    } else if (S.mode === 'blink-place') {
      const pos = cellAt(el, $('myBoard'));
      const k = pos ? key(pos.x, pos.y) : null;
      if (k !== S.hoverCell) { S.hoverCell = k; paintBattleMine(); }
    }
  });

  document.addEventListener('pointerup', e => {
    if (!S.dragging) return;
    S.dragging = false;
    const origin = S.dragOrigin;
    S.dragOrigin = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const pos = cellAt(el, board);
    if (pos && S.selectedShip && key(pos.x, pos.y) !== origin) {
      if (placeSelected(pos.x, pos.y)) sfx('turn');
    }
    render();
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key !== 'r' && e.key !== 'R') return;
    if (S.phase === 'setup' || S.mode === 'blink-place') rotate();
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
    net.send(rulesMsg());
  });
  $('chkMayhem').addEventListener('change', e => {
    if (S.role !== 'host') return;
    S.mayhem = e.target.checked;
    net.send(rulesMsg());
    render();
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
  net.send({ type: 'start', first, variant: S.variant, mayhem: S.mayhem });
  startBattle(first, S.variant, S.mayhem);
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
function startBattle(first, variant, mayhem) {
  S.variant = variant;
  S.mayhem = mayhem;
  S.phase = 'battle';
  S.over = null;
  S.rematch = { me: false, them: false };
  S.gameId++;
  resetMayhem();
  enterBattle();
  const tags = [variant === 'hit-again' && '命中可連射', mayhem && '⚡ 海克斯大亂鬥'].filter(Boolean);
  sysLog(`開戰！<b>${esc(nameOf(first))}</b> 先手${tags.length ? `（${tags.join('、')}）` : ''}`);
  sfx('join');
  setTurn(first);
  render();
}

function resetMayhem() {
  S.aug = { host: freshAug(), guest: freshAug() };
  S.shotsFired = { host: 0, guest: 0 };
  S.turnShots = { host: 0, guest: 0 };
  S.extra = { host: 0, guest: 0 };
  S.pickedAt = new Set();
  S.pending = null;
  S.mode = null;
  S.blink = null;
  S.missStreak = 0;
  S.decoy = null;
  S.armorHits = new Map();
  S.seq = 0;
  S.lastSeq = 0;
  S.lastInSeq = 0;
}

function enterBattle() {
  setScreen('screenBattle');
  $('roomCode').textContent = net.code;
  $('overlay').hidden = true;
  $('pickModal').hidden = true;
  render();
}

// 我方防守判定用的資料包。
const defense = () => ({
  fleet: S.myFleet, decoy: S.decoy, armor: has(S.role, 'armor'), armorHits: S.armorHits,
});

// 某一方還剩幾艘真船（幽靈艦不算）。三種身分都算得出來，回合判定才會一致。
function remainingOf(side) {
  if (side === S.role) return remainingShips(S.myFleet);
  const tracker = S.role === 'spectator' ? S.spec[side] : S.enemy;
  return SHIP_TYPES.length - tracker.sunkShips.filter(s => !s.decoy).length;
}

// 換誰：三種身分用同一套算，狀態全是公開的。
function advanceTurn(shooter, agg) {
  const defender = opposite(shooter);
  let next;
  if (agg.decoySunk) {
    S.extra[defender] += 1;
    next = defender;
  } else if (agg.hit && (S.variant === 'hit-again' || has(shooter, 'press'))) {
    next = shooter;
  } else if (S.extra[shooter] > 0) {
    S.extra[shooter] -= 1;
    next = shooter;
  } else if (has(shooter, 'laststand') && remainingOf(shooter) === 1 && S.turnShots[shooter] < 2) {
    next = shooter;
  } else {
    next = defender;
  }
  if (next !== shooter) S.turnShots[shooter] = 0;
  return next;
}

function setTurn(side) {
  S.turn = side;
  if (side && side !== S.role) S.turnShots[side] = S.turnShots[side] || 0;
}

// 該不該跳強化選單：輪到我、第 0/6/12… 次開火前、這個次數還沒選過。
function checkPick() {
  if (!S.mayhem || !isMyTurn() || S.pending) return;
  const n = S.shotsFired[S.role];
  if (n % PICK_EVERY !== 0 || S.pickedAt.has(n)) return;
  S.pickedAt.add(n);
  const me = S.role;
  const exclude = [];
  if (S.variant === 'hit-again') exclude.push('press');
  if (!S.myFleet.some(isUndamaged)) exclude.push('blink', 'rebuild');
  const carrier = S.myFleet.find(s => s.id === 'carrier');
  if (!carrier || carrier.hits.length >= carrier.size) exclude.push('armor');
  const offers = rollOffers(S.aug[me].owned, exclude);
  if (!offers.length) return;
  S.pending = offers;
  net.send({ type: 'picking' });
  sfx('join');
  renderPick();
}

function choosePick(id) {
  if (!S.pending || !S.pending.includes(id)) return;
  const me = S.role;
  S.pending = null;
  S.aug[me].owned.push(id);
  net.send({ type: 'pick', id });
  logLine($('battleLog'), `你選了 ⚡ <b>${AUG[id].name}</b>`, 'sys');
  sfx('turn');
  if (id === 'intel') net.send({ type: 'intel-req' });
  if (id === 'ghost') {
    S.decoy = randomDecoy(S.myFleet, placementBlockers());
    if (S.decoy) sysLog('幽靈艦已就位（虛線那艘），對手看不出來');
    else { sysLog('海域太滿，幽靈艦找不到地方停'); toast('沒空位放幽靈艦了', 'bad'); }
  }
  $('pickModal').hidden = true;
  render();
}

// 主動技能
function useActive(id) {
  if (!isMyTurn() || S.pending || !has(S.role, id) || usedUp(S.role, id)) return;
  cancelMode();
  switch (id) {
    case 'sonar':
    case 'cross':
      S.mode = id;
      break;
    case 'blink':
      if (!S.myFleet.some(isUndamaged)) return toast('沒有完全未受損的船可以躍遷', 'bad');
      S.mode = 'blink';
      break;
    case 'rebuild': {
      if (!S.myFleet.some(isUndamaged)) return toast('沒有完全未受損的船', 'bad');
      if (!confirm('艦隊重組：所有未受損的船隨機換位，並消耗這一回合。確定？')) return;
      const n = relocateUndamaged(S.myFleet, placementBlockers());
      S.aug[S.role].used.rebuild = true;
      net.send({ type: 'rebuild' });
      sysLog(`艦隊重組完成，${n} 艘船換了位置`);
      sfx('turn');
      setTurn(opposite(S.role));
      break;
    }
  }
  render();
}

function cancelMode() {
  if (S.mode === 'blink-place' && S.blink) {
    const ship = S.myFleet.find(s => s.id === S.blink.id);
    if (ship) { ship.x = S.blink.x; ship.y = S.blink.y; ship.dir = S.blink.dir; }
  }
  S.mode = null;
  S.blink = null;
  S.selectedShip = null;
  S.hoverCell = null;
}

// 躍遷：第一下點船（撿起），第二下點目標（放下並消耗回合）。
function blinkClick(x, y) {
  if (S.mode === 'blink') {
    const occ = occupancy(S.myFleet).get(key(x, y));
    if (!occ) return;
    if (!isUndamaged(occ.ship)) return toast('受損的船不能躍遷，選有光暈的那幾艘', 'bad');
    S.blink = { id: occ.ship.id, x: occ.ship.x, y: occ.ship.y, dir: occ.ship.dir };
    liftShip(occ.ship.id);
    S.dir = occ.ship.dir;
    S.mode = 'blink-place';
  } else if (S.mode === 'blink-place') {
    if (!placeSelected(x, y)) return toast('這裡放不下（不能疊船、不能放在被打過的格子）', 'bad');
    S.aug[S.role].used.blink = true;
    S.mode = null;
    S.blink = null;
    S.selectedShip = null;
    S.hoverCell = null;
    net.send({ type: 'blink' });
    sysLog('緊急躍遷完成');
    sfx('turn');
    setTurn(opposite(S.role));
  }
  render();
}

function doSonar(x, y) {
  S.aug[S.role].used.sonar = true;
  S.mode = null;
  S.turn = null;
  net.send({ type: 'sonar', x, y });
  logLine($('battleLog'), `你對 ${cellName(x, y)} 周圍發射聲納…`, 'sys');
  sfx('fire');
  render();
}

function fire(x, y) {
  if (!isMyTurn() || S.pending) return;
  if (S.mode === 'sonar') return doSonar(x, y);
  if (S.mode === 'cross') {
    const cells = crossCells(x, y).filter(c => canTarget(S.enemy, key(c.x, c.y)));
    // 五格都打過了：別默默吃掉這次寶貴的機會，換個位置
    if (!cells.length) return toast('這個十字全都打過了，換一格', 'bad');
    S.aug[S.role].used.cross = true;
    S.mode = null;
    return fireCells(cells, 'cross');
  }
  if (S.mode) return;
  const k = key(x, y);
  if (!canTarget(S.enemy, k)) return;
  const cells = [{ x, y }];
  let kind = 'shot';
  if (has(S.role, 'gambler') && S.missStreak >= 4) {
    const pool = [];
    for (let yy = 0; yy < 10; yy++) for (let xx = 0; xx < 10; xx++) {
      const kk = key(xx, yy);
      if (kk !== k && canTarget(S.enemy, kk)) pool.push({ x: xx, y: yy });
    }
    for (let i = 0; i < 2 && pool.length; i++) {
      cells.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    kind = 'carpet';
  }
  fireCells(cells, kind);
}

function fireCells(cells, kind) {
  unlockAudio();
  S.turn = null;
  S.shotsFired[S.role] += 1;
  S.seq += 1;
  net.send({ type: 'fire', cells, kind, seq: S.seq });
  if (kind === 'cross') logLine($('battleLog'), '💣 十字爆破！', 'sys');
  if (kind === 'carpet') logLine($('battleLog'), '🎰 機率補償：地毯式轟炸 3 格', 'sys');
  sfx('fire');
  render();
}

function handleIncomingFire(msg) {
  if (S.phase !== 'battle') return;
  // 序號去重：裝甲格可以被合法地打第二次，所以不能只靠「這格打過沒」判斷重複封包。
  if (msg.seq != null) {
    if (msg.seq <= S.lastInSeq) return;
    S.lastInSeq = msg.seq;
  }
  const raw = Array.isArray(msg.cells) ? msg.cells : [{ x: msg.x, y: msg.y }];
  const cells = raw.filter(c => inBounds(c.x, c.y) && (S.incoming.get(key(c.x, c.y)) ?? 'armor') === 'armor');
  if (!cells.length) return; // 重複封包
  const def = defense();
  const shooter = opposite(S.role);
  const results = cells.map(c => {
    const r = resolveCell(def, c.x, c.y);
    const k = key(c.x, c.y);
    S.incoming.set(k, r.armor ? 'armor' : r.hit ? 'hit' : 'miss');
    if (!r.hit && !r.armor && has(shooter, 'radar')) r.near = nearShip(def, c.x, c.y);
    S.lastEnemyShot = k;
    return r;
  });
  const dead = fleetDestroyed(S.myFleet);
  S.turnShots[shooter] += 1;
  net.send({ type: 'result', cells: results, kind: msg.kind || 'shot', seq: msg.seq, dead });
  const agg = { hit: results.some(r => r.hit), decoySunk: results.some(r => r.sunk?.decoy) };
  setTurn(dead ? null : advanceTurn(shooter, agg));

  const who = `<b>${esc(nameOf(shooter))}</b>`;
  if (msg.kind === 'cross') logLine($('battleLog'), `${who} 發射十字爆破！`, 'sys');
  if (msg.kind === 'carpet') logLine($('battleLog'), `${who} 地毯式轟炸！`, 'sys');
  let loudest = 'miss';
  for (const r of results) {
    const at = cellName(r.x, r.y);
    if (r.sunk?.decoy) {
      logLine($('battleLog'), `${who} 擊沉了你的<b>幽靈艦</b>（${at}）— 白打了，你多一發`, 'sys');
      loudest = 'sunk';
    } else if (r.sunk) {
      logLine($('battleLog'), `${who} 擊沉了你的 <b>${r.sunk.name}</b>！（${at}）`, 'sunk');
      loudest = 'sunk';
    } else if (r.armor) {
      logLine($('battleLog'), `${who} 打到 ${at}，🛡 裝甲彈開`, 'miss');
    } else if (r.hit) {
      logLine($('battleLog'), `${who} 命中 ${at}`, 'hit');
      if (loudest === 'miss') loudest = 'hit';
    } else {
      logLine($('battleLog'), `${who} 打到 ${at} 落空`, 'miss');
    }
  }
  sfx(loudest);
  if (dead) {
    net.send({ type: 'reveal', fleet: S.myFleet });
    endGame('lose');
  } else if (S.turn === S.role) {
    sfx('turn');
  }
}

function handleShotResult(msg) {
  if (S.phase !== 'battle') return;
  if (msg.seq != null) {
    if (msg.seq <= S.lastSeq) return; // 重複封包
    S.lastSeq = msg.seq;
  }
  const results = Array.isArray(msg.cells) ? msg.cells : [msg];
  const me = S.role, them = opposite(me);
  for (const r of results) {
    const k = key(r.x, r.y);
    if (r.armor) S.enemy.shots.set(k, 'armor');
    else recordShot(S.enemy, r);
    if (r.sunk?.decoy) for (const c of r.sunk.cells) S.enemy.shots.set(key(c.x, c.y), 'decoy');
    if (r.near !== undefined) S.enemy.near.set(k, r.near);
    S.lastMyShot = k;
  }
  const anyHit = results.some(r => r.hit);
  if (msg.kind === 'carpet') S.missStreak = 0;
  else S.missStreak = anyHit ? 0 : S.missStreak + 1;
  S.turnShots[me] += 1;
  const agg = { hit: anyHit, decoySunk: results.some(r => r.sunk?.decoy) };
  setTurn(msg.dead ? null : advanceTurn(me, agg));

  let loudest = 'miss';
  for (const r of results) {
    const at = cellName(r.x, r.y);
    if (r.sunk?.decoy) {
      logLine($('battleLog'), `你擊沉的是<b>幽靈艦</b>（${at}）— 假的，對方多一發`, 'sys');
      loudest = 'sunk';
    } else if (r.sunk) {
      logLine($('battleLog'), `你擊沉了對方的 <b>${esc(r.sunk.name)}</b>！（${at}）`, 'sunk');
      loudest = 'sunk';
    } else if (r.armor) {
      logLine($('battleLog'), `${at} 🛡 裝甲彈開，再打一次才算數`, 'miss');
    } else if (r.hit) {
      logLine($('battleLog'), `你命中 ${at}`, 'hit');
      if (loudest === 'miss') loudest = 'hit';
    } else {
      const hint = r.near === undefined ? '' : r.near ? '　📡 1 格內有船' : '　📡 2 格以上沒船';
      logLine($('battleLog'), `你打 ${at} 落空${hint}`, 'miss');
    }
  }
  sfx(loudest);

  if (msg.dead) {
    net.send({ type: 'reveal', fleet: S.myFleet });
    endGame('win');
    return;
  }
  // 同歸於盡：我擊沉了對方的真船，而對方有這個強化 → 我自己隨機一格船位被必中。
  const realSunk = results.filter(r => r.sunk && !r.sunk.decoy);
  if (realSunk.length && has(them, 'kamikaze')) {
    for (const _ of realSunk) {
      const c = randomShipCell(S.myFleet);
      if (!c) break;
      const res = receiveFire(S.myFleet, c.x, c.y);
      const k = key(c.x, c.y);
      S.incoming.set(k, 'hit');
      S.lastEnemyShot = k;
      const deadMe = fleetDestroyed(S.myFleet);
      net.send({ type: 'kamikaze-hit', x: c.x, y: c.y, sunk: res.sunk, dead: deadMe });
      logLine($('battleLog'), `💥 對方自爆反擊，命中你的 <b>${cellName(c.x, c.y)}</b>${res.sunk ? `，擊沉 <b>${res.sunk.name}</b>` : ''}`, res.sunk ? 'sunk' : 'hit');
      sfx(res.sunk ? 'sunk' : 'hit');
      if (deadMe) {
        net.send({ type: 'reveal', fleet: S.myFleet });
        endGame('lose');
        return;
      }
    }
  }
}

function endGame(result) {
  S.over = result;
  S.phase = 'over';
  S.turn = null;
  S.mode = null;
  S.pending = null;
  $('pickModal').hidden = true;
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
  resetMayhem();
  $('overlay').hidden = true;
  $('pickModal').hidden = true;
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
  const results = Array.isArray(msg.cells) ? msg.cells : [msg];
  for (const r of results) {
    const k = key(r.x, r.y);
    if (r.armor) S.spec[side].shots.set(k, 'armor');
    else recordShot(S.spec[side], r);
    if (r.sunk?.decoy) for (const c of r.sunk.cells) S.spec[side].shots.set(key(c.x, c.y), 'decoy');
    S.specLast[side] = k;
  }
  S.turnShots[shooter] += 1;
  const agg = { hit: results.some(r => r.hit), decoySunk: results.some(r => r.sunk?.decoy) };
  setTurn(msg.dead ? null : advanceTurn(shooter, agg));
  const who = `<b>${esc(nameOf(shooter))}</b>`;
  let loudest = 'miss';
  for (const r of results) {
    const at = cellName(r.x, r.y);
    if (r.sunk?.decoy) { logLine($('battleLog'), `${who} 擊沉了 ${esc(nameOf(side))} 的幽靈艦（假的）`, 'sys'); loudest = 'sunk'; }
    else if (r.sunk) { logLine($('battleLog'), `${who} 擊沉 ${esc(nameOf(side))} 的 <b>${esc(r.sunk.name)}</b>`, 'sunk'); loudest = 'sunk'; }
    else if (r.armor) logLine($('battleLog'), `${who} 打到 ${at}，裝甲彈開`, 'miss');
    else if (r.hit) { logLine($('battleLog'), `${who} 命中 ${at}`, 'hit'); if (loudest === 'miss') loudest = 'hit'; }
    else logLine($('battleLog'), `${who} 打 ${at} 落空`, 'miss');
  }
  sfx(loudest);
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
  ...newTracker(),
  shots: new Map(raw?.shots || []),
  sunkShips: raw?.sunkShips || [],
});

function specSnapshot() {
  const hostSide = newTracker();
  const occ = occupancy(S.myFleet);
  for (const [k, kind] of S.incoming) {
    if (kind === 'miss') { hostSide.shots.set(k, 'miss'); continue; }
    if (kind === 'armor') { hostSide.shots.set(k, 'armor'); continue; }
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
    mayhem: S.mayhem,
    aug: { host: { owned: S.aug.host.owned }, guest: { owned: S.aug.guest.owned } },
    turn: S.turn,
    names: S.names,
    host: serializeTracker(hostSide),
    guest: serializeTracker(S.enemy),
    hostReveal: S.phase === 'over' ? S.myFleet : null,
    guestReveal: S.phase === 'over' ? S.enemyReveal : null,
  };
}

function applySpecSnapshot(msg) {
  S.phase = msg.phase === 'over' ? 'over' : 'battle';
  S.variant = msg.variant;
  S.mayhem = !!msg.mayhem;
  if (msg.aug) S.aug = { host: { ...freshAug(), ...msg.aug.host }, guest: { ...freshAug(), ...msg.aug.guest } };
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
    $('chatPane').hidden = tab !== 'chat';
    $('battleLog').hidden = tab !== 'log';
    $('hexPane').hidden = tab !== 'hex';
    $('tabChat').classList.toggle('active', tab === 'chat');
    $('tabLog').classList.toggle('active', tab === 'log');
    $('tabHex').classList.toggle('active', tab === 'hex');
    if (tab === 'chat') { $('tabChat').classList.remove('badge'); $('chatInput').focus(); }
    if (tab === 'hex') $('tabHex').classList.remove('badge');
  };
  $('tabLog').addEventListener('click', () => switchTab('log'));
  $('tabChat').addEventListener('click', () => switchTab('chat'));
  $('tabHex').addEventListener('click', () => switchTab('hex'));
}

// ── 渲染 ─────────────────────────────────────────────
function render() {
  $('peerCount').textContent = `👥 ${S.peerCount}`;
  boss?.setSignal(isMyTurn());
  checkPick();
  excel?.update();

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
    $('mayhemNote').hidden = !S.mayhem;
    return;
  }

  if (S.phase === 'battle' || S.phase === 'over') {
    $('tabHex').hidden = !S.mayhem;
    if (S.role === 'spectator') return renderSpectator();

    const me = S.role, them = opposite(S.role);
    $('enemyTitle').textContent = `${nameOf(them)} 的海域`;
    $('myTitle').textContent = '我方海域';
    $('enemyFleetStatus').textContent =
      `已擊沉 ${S.enemy.sunkShips.filter(s => !s.decoy).length} / ${SHIP_TYPES.length} 艘`;
    $('myFleetStatus').textContent =
      `剩餘 ${remainingShips(S.myFleet)} / ${SHIP_TYPES.length} 艘`;

    paintEnemyBoard(boards.enemy, S.enemy, S.lastMyShot, S.enemyReveal);
    paintBattleMine();

    const banner = $('turnBanner');
    banner.className = 'turn-banner';
    if (S.phase === 'over') {
      banner.classList.add('over');
      $('turnText').textContent = S.over === 'win' ? '你贏了 🏆' : '艦隊全滅 💥';
    } else if (S.turn === me) {
      banner.classList.add('mine');
      $('turnText').textContent = S.pending ? '先選一個海克斯強化' : '輪到你了，選一格開火';
    } else if (S.turn === them) {
      banner.classList.add('theirs');
      $('turnText').textContent = `等 ${nameOf(them)} 出手…`;
    } else {
      banner.classList.add('theirs');
      $('turnText').textContent = '砲彈飛行中…';
    }
    const live = isMyTurn() && !S.pending && (S.mode === null || S.mode === 'sonar' || S.mode === 'cross');
    $('enemyBoard').classList.toggle('live', live);
    $('enemyBoard').classList.toggle('mode-sonar', S.mode === 'sonar');
    $('enemyBoard').classList.toggle('mode-cross', S.mode === 'cross');
    $('enemyLock').hidden = isMyTurn() || S.phase === 'over';
    $('enemyLock').querySelector('span').textContent =
      S.turn === them ? `等 ${nameOf(them)} 出手…` : '砲彈飛行中…';
    $('myBoard').classList.toggle('live', S.mode === 'blink' || S.mode === 'blink-place');
    renderModeBar();
    renderHexPane();
  }
}

// 我方海域（對戰中）：船 + 假船 + 來襲紀錄 + 躍遷預覽。
function paintBattleMine() {
  paintMyBoard(boards.mine, S.myFleet, S.incoming, S.lastEnemyShot, S.decoy);
  // 躍遷選船時直接標出「哪幾艘能動」，不要讓人一艘艘點去試。
  if (S.mode === 'blink') {
    for (const ship of S.myFleet) {
      if (!isUndamaged(ship)) continue;
      for (const c of cellsOf(ship)) boards.mine.get(key(c.x, c.y))?.classList.add('blink-ok');
    }
  }
  if (S.mode !== 'blink-place' || !S.hoverCell) return;
  const ship = S.myFleet.find(s => s.id === S.selectedShip);
  if (!ship) return;
  const [hx, hy] = S.hoverCell.split(',').map(Number);
  const ok = canPlace([...S.myFleet, ...placementBlockers()], ship, hx, hy, S.dir);
  for (const c of cellsOf({ ...ship, x: hx, y: hy, dir: S.dir })) {
    boards.mine.get(key(c.x, c.y))?.classList.add(ok ? 'preview-ok' : 'preview-bad');
  }
}

function renderModeBar() {
  const bar = $('modeBar');
  const text = {
    'sonar': '🔊 聲納：點敵方海域一格，掃描它周圍 3×3（消耗回合）',
    'cross': '💣 十字爆破：點敵方海域一格，同時打上下左右 5 格',
    'blink': '🌀 緊急躍遷：點我方海域一艘「完全未受損」的船',
    'blink-place': '🌀 躍遷：點目標位置放下，R 旋轉（不能放在被打過的格子）',
  }[S.mode];
  bar.hidden = !text;
  $('modeText').textContent = text || '';
}

function renderHexPane() {
  const pane = $('hexPane');
  if (!S.mayhem) { pane.innerHTML = ''; return; }
  const me = S.role, them = opposite(me);
  const card = (side, id) => {
    const a = AUG[id];
    const mine = side === me;
    const used = usedUp(side, id);
    const canUse = mine && a.kind === 'active' && !used && isMyTurn() && !S.pending;
    return `<li class="hex-card tier-${a.tier} ${used ? 'used' : ''}">
      <div class="hex-card-head"><span class="hex-tier">${TIER_NAME[a.tier]}</span><b>${a.name}</b>
        ${a.kind === 'active' ? `<span class="hex-kind">${used ? '已用' : '主動'}</span>` : `<span class="hex-kind">${a.kind === 'passive' ? '被動' : '即時'}</span>`}</div>
      <p>${a.desc}</p>
      ${mine && a.kind === 'active' && !used ? `<button class="btn btn-sm ${canUse ? 'btn-primary' : ''}" data-use="${id}" ${canUse ? '' : 'disabled'}>${S.mode === id || (id === 'blink' && S.mode?.startsWith('blink')) ? '選擇中…' : '使用'}</button>` : ''}
    </li>`;
  };
  const list = side => S.aug[side].owned.length
    ? `<ul class="hex-list">${S.aug[side].owned.map(id => card(side, id)).join('')}</ul>`
    : '<p class="hex-empty">還沒有強化</p>';
  const next = PICK_EVERY - (S.shotsFired[me] % PICK_EVERY);
  pane.innerHTML = `
    <div class="hex-sec"><h4>我的強化 <span class="hex-next">再開 ${next % PICK_EVERY === 0 ? PICK_EVERY : next} 槍可再選</span></h4>${list(me)}</div>
    <div class="hex-sec"><h4>${esc(nameOf(them))} 的強化</h4>${list(them)}</div>`;
}

function renderPick() {
  const modal = $('pickModal');
  if (!S.pending) { modal.hidden = true; return; }
  $('pickCards').innerHTML = S.pending.map(id => {
    const a = AUG[id];
    return `<button class="pick-card tier-${a.tier}" data-pick="${id}">
      <span class="hex-tier">${TIER_NAME[a.tier] === a.cat ? a.cat : `${TIER_NAME[a.tier]} · ${a.cat}`}</span>
      <b>${a.name}</b>
      <span class="pick-kind">${{ active: '主動 · 每局一次', passive: '被動', instant: '立即生效' }[a.kind]}</span>
      <p>${a.desc}</p>
    </button>`;
  }).join('');
  modal.hidden = false;
  $('tabHex').classList.add('badge');
}

function renderSpectator() {
  $('enemyTitle').textContent = `${nameOf('host')} 的海域`;
  $('myTitle').textContent = `${nameOf('guest')} 的海域`;
  $('enemyFleetStatus').textContent = `被擊沉 ${S.spec.host.sunkShips.filter(s => !s.decoy).length} / ${SHIP_TYPES.length} 艘`;
  $('myFleetStatus').textContent = `被擊沉 ${S.spec.guest.sunkShips.filter(s => !s.decoy).length} / ${SHIP_TYPES.length} 艘`;
  paintEnemyBoard(boards.enemy, S.spec.host, S.specLast.host, S.specReveal.host);
  paintEnemyBoard(boards.mine, S.spec.guest, S.specLast.guest, S.specReveal.guest);
  $('enemyBoard').classList.remove('live');
  $('enemyLock').hidden = true;
  $('modeBar').hidden = true;
  const banner = $('turnBanner');
  banner.className = 'turn-banner theirs';
  if (S.phase === 'over') {
    banner.className = 'turn-banner over';
  } else if (S.turn) {
    $('turnText').textContent = `輪到 ${nameOf(S.turn)}`;
  } else {
    $('turnText').textContent = '觀戰中';
  }
  if (S.mayhem) {
    const list = side => S.aug[side].owned.length
      ? `<ul class="hex-list">${S.aug[side].owned.map(id => `<li class="hex-card tier-${AUG[id].tier}"><div class="hex-card-head"><span class="hex-tier">${TIER_NAME[AUG[id].tier]}</span><b>${AUG[id].name}</b></div><p>${AUG[id].desc}</p></li>`).join('')}</ul>`
      : '<p class="hex-empty">還沒有強化</p>';
    $('hexPane').innerHTML = `<div class="hex-sec"><h4>${esc(nameOf('host'))}</h4>${list('host')}</div><div class="hex-sec"><h4>${esc(nameOf('guest'))}</h4>${list('guest')}</div>`;
  }
}

// 大廳背景影片：11MB 不是每個人都該付的代價，所以省流量模式、
// 偏好減少動態、或窄螢幕就只留 poster 靜圖。
function setupLobbyVideo() {
  const video = $('lobbyVideo');
  if (!video) return;
  const saveData = navigator.connection?.saveData;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (saveData || reduce || innerWidth < 560) return;

  video.addEventListener('canplay', () => video.classList.add('ready'), { once: true });
  video.addEventListener('error', () => video.remove(), { once: true });
  video.src = 'assets/lobby.mp4';
  video.play().catch(() => { /* 瀏覽器擋自動播放就維持 poster */ });

  // 離開大廳後別讓它在背後空轉吃電。
  const stopWhenHidden = () => {
    const inLobby = !$('screenLobby').hidden;
    if (inLobby && video.paused) video.play().catch(() => {});
    else if (!inLobby && !video.paused) video.pause();
  };
  new MutationObserver(stopWhenHidden)
    .observe($('screenLobby'), { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else stopWhenHidden();
  });
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

  setupLobbyVideo();

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

  let soundBeforeWork = true;
  const workHooks = {
    onEnter() {
      soundBeforeWork = isSoundEnabled();
      setSoundEnabled(false);
    },
    onExit() {
      setSoundEnabled(soundBeforeWork);
      if (soundBeforeWork) unlockAudio();
    },
  };
  boss = initBossMode(workHooks);
  excel = initExcelMode({
    ...workHooks,
    getState: () => ({
      role: S.role,
      phase: S.phase,
      turn: S.turn,
      myTurn: isMyTurn(),
      myFleet: S.myFleet,
      incoming: S.incoming,
      enemy: S.enemy,
      enemyReveal: S.enemyReveal,
      decoy: S.decoy,
      spec: S.spec,
      specReveal: S.specReveal,
      over: S.over,
      gameId: S.gameId,
      readyMe: !!S.ready[S.role],
      selectedShip: S.myFleet.find(s => s.id === S.selectedShip) || null,
      placed: isFleetPlaced(S.myFleet),
      placedCount: S.myFleet.filter(s => s.x != null).length,
      remaining: remainingShips(S.myFleet),
      mayhem: S.mayhem,
      mode: S.mode,
      pending: S.pending,
      myAug: isPlayer() ? S.aug[S.role] : freshAug(),
      blockers: placementBlockers(),
    }),
    onFire: fire,
    onReady: markReady,
    onPlace(x, y, dir) {
      if (S.phase === 'battle') {
        if (S.mode === 'blink' || S.mode === 'blink-place') { S.dir = dir; blinkClick(x, y); }
        return;
      }
      if (!S.selectedShip) {
        const next = S.myFleet.find(s => s.x == null);
        if (!next) return;
        S.selectedShip = next.id;
      }
      S.dir = dir;
      if (placeSelected(x, y)) sfx('turn');
      render();
    },
    onLift(x, y) {
      if (S.phase === 'battle') return;
      const occ = occupancy(S.myFleet).get(key(x, y));
      if (!occ) return;
      liftShip(occ.ship.id);
      S.dir = occ.ship.dir;
      render();
    },
    onRandom() {
      S.myFleet = randomFleet();
      S.selectedShip = null;
      render();
    },
    onRematch: requestRematch,
    onPick: choosePick,
    onUse: useActive,
    onCancelMode() { cancelMode(); render(); },
  });
  $('btnExcel').addEventListener('click', () => { boss.exit(); excel.enter(); });
  $('btnBoss').addEventListener('click', () => { excel.exit(); boss.enter(); });

  // 使用教學
  const help = $('helpModal');
  const openHelp = (sec = 'start') => { showHelpSection(sec); help.hidden = false; };
  const closeHelp = () => { help.hidden = true; };
  function showHelpSection(sec) {
    for (const b of $('helpNav').querySelectorAll('button')) b.classList.toggle('active', b.dataset.sec === sec);
    for (const s of $('helpContent').querySelectorAll('section')) s.hidden = s.dataset.sec !== sec;
    $('helpContent').scrollTop = 0;
  }
  $('helpNav').addEventListener('click', e => {
    const b = e.target.closest('button[data-sec]');
    if (b) showHelpSection(b.dataset.sec);
  });
  $('btnHelp').addEventListener('click', () => openHelp());
  $('btnHelpLobby').addEventListener('click', () => openHelp());
  $('btnHelpClose').addEventListener('click', closeHelp);
  help.addEventListener('click', e => { if (e.target === help) closeHelp(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!help.hidden) closeHelp();
      else if (S.mode && !excel.active && !boss.active) { cancelMode(); render(); }
      else if (boss.active) boss.exit();
      else if (excel.active) excel.exit();
      else excel.enter();
      return;
    }
    if (e.key === '?' && e.target.tagName !== 'INPUT' && !boss.active && !excel.active) {
      e.preventDefault();
      help.hidden ? openHelp() : closeHelp();
    }
  });

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
  $('myBoard').addEventListener('click', e => {
    const cell = e.target.closest('.cell');
    if (!cell || !S.mode?.startsWith('blink')) return;
    blinkClick(+cell.dataset.x, +cell.dataset.y);
  });
  $('myBoard').addEventListener('contextmenu', e => {
    if (S.mode !== 'blink-place') return;
    e.preventDefault();
    rotate();
  });
  $('hexPane').addEventListener('click', e => {
    const b = e.target.closest('button[data-use]');
    if (b) useActive(b.dataset.use);
  });
  $('pickCards').addEventListener('click', e => {
    const b = e.target.closest('button[data-pick]');
    if (b) choosePick(b.dataset.pick);
  });
  $('btnCancelMode').addEventListener('click', () => { cancelMode(); render(); });

  // 在遊戲中把另一個邀請連結貼進網址列，只換 #房間碼 瀏覽器不會重載，
  // 畫面會像壞掉一樣沒反應。攔下來問一句再重載。
  window.addEventListener('hashchange', () => {
    const code = location.hash.replace('#', '').trim().toUpperCase();
    if (!net || !code || code === net.code) return;
    if (confirm(`要離開現在這局，加入房間 ${code} 嗎？`)) location.reload();
    else location.hash = net.code;
  });

  bindSetupInteractions();
  bindChat();

  S.selectedShip = S.myFleet[0].id;
  setScreen('screenLobby');
  window.addEventListener('beforeunload', () => net?.destroy());
}

init();
