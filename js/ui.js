// DOM 渲染層：只負責把狀態畫出來，不做任何規則判斷、不碰網路。
import { SIZE, key, cellsOf, occupancy } from './game.js';

const COLS = 'ABCDEFGHIJ';
export const cellName = (x, y) => COLS[x] + (y + 1);

export const $ = id => document.getElementById(id);

// 建出 11x11（含座標軸）並回傳 "x,y" -> button 的對照表。
export function buildBoard(el) {
  el.innerHTML = '';
  const cells = new Map();
  const frag = document.createDocumentFragment();

  frag.appendChild(document.createElement('div')).className = 'axis';
  for (let x = 0; x < SIZE; x++) {
    const label = document.createElement('div');
    label.className = 'axis axis-col';
    label.textContent = COLS[x];
    frag.appendChild(label);
  }

  for (let y = 0; y < SIZE; y++) {
    const label = document.createElement('div');
    label.className = 'axis';
    label.textContent = y + 1;
    frag.appendChild(label);
    for (let x = 0; x < SIZE; x++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.dataset.x = x;
      cell.dataset.y = y;
      cell.setAttribute('aria-label', cellName(x, y));
      cells.set(key(x, y), cell);
      frag.appendChild(cell);
    }
  }
  el.appendChild(frag);
  return cells;
}

const resetCells = cells => {
  for (const cell of cells.values()) cell.className = 'cell';
};

// 畫上一艘船，含頭尾圓角。
function paintShip(cells, ship, extraClass = '') {
  const list = cellsOf(ship);
  list.forEach((c, i) => {
    const el = cells.get(key(c.x, c.y));
    if (!el) return;
    el.classList.add('ship');
    if (ship.dir === 'v') el.classList.add('vert');
    if (i === 0) el.classList.add('edge-start');
    if (i === list.length - 1) el.classList.add('edge-end');
    if (extraClass) el.classList.add(extraClass);
  });
}

// 我方海域：自己的船 + 假船 + 對方打過的每一發。
export function paintMyBoard(cells, fleet, incoming, lastShot, decoy = null) {
  resetCells(cells);
  for (const ship of fleet) {
    if (ship.x != null) paintShip(cells, ship, ship.ghost ? 'ghost-ship' : '');
  }
  if (decoy) {
    const c = decoy.cells;
    const dir = c.length > 1 && c[1].x !== c[0].x ? 'h' : 'v';
    paintShip(cells, { x: c[0].x, y: c[0].y, dir, size: c.length }, 'decoy');
  }
  const occ = occupancy(fleet);
  for (const [k, kind] of incoming) {
    const el = cells.get(k);
    if (!el) continue;
    if (kind === 'miss') { el.className = 'cell miss'; continue; }
    if (kind === 'armor') { el.classList.add('armor'); continue; }
    const hitShip = occ.get(k)?.ship;
    const sunk = hitShip
      ? hitShip.hits.length === hitShip.size
      : decoy && decoy.hits.length === decoy.cells.length;   // 假船格
    el.classList.add(sunk ? 'sunk' : 'hit');
  }
  if (lastShot) cells.get(lastShot)?.classList.add('last-shot');
}

// 敵方海域：只有我打出去的結果，船身永遠不顯示（除非終局揭曉）。
// 額外標記：聲納區域、雷達距離提示、裝甲彈開、情報、假船。
export function paintEnemyBoard(cells, tracker, lastShot, revealFleet) {
  resetCells(cells);
  if (revealFleet) {
    for (const ship of revealFleet) {
      if (ship.x != null) paintShip(cells, ship);
    }
  }
  for (const [k, v] of tracker.sonar || []) {
    cells.get(k)?.classList.add(v === 'yes' ? 'sonar-yes' : 'sonar-no');
  }
  for (const [k, kind] of tracker.shots) {
    const el = cells.get(k);
    if (!el) continue;
    if (kind !== 'intel' && kind !== 'armor') el.classList.remove('ship', 'vert', 'edge-start', 'edge-end');
    el.classList.add(kind);
    if (kind === 'miss' && tracker.near?.has(k)) el.classList.add(tracker.near.get(k) ? 'near' : 'far');
  }
  if (lastShot) cells.get(lastShot)?.classList.add('last-shot');
}

export function renderDock(el, fleet, selectedId) {
  el.innerHTML = '';
  for (const ship of fleet) {
    if (ship.ghost) continue;          // 幽靈船不在開局船塢裡
    const li = document.createElement('li');
    li.className = 'dock-item';
    li.dataset.shipId = ship.id;
    if (ship.x != null) li.classList.add('placed');
    if (ship.id === selectedId) li.classList.add('selected');

    const pips = document.createElement('span');
    pips.className = 'dock-pips';
    for (let i = 0; i < ship.size; i++) {
      pips.appendChild(document.createElement('span')).className = 'dock-pip';
    }

    const name = document.createElement('span');
    name.className = 'dock-name';
    name.textContent = ship.name;

    const size = document.createElement('span');
    size.className = 'dock-size';
    size.textContent = `${ship.size} 格`;

    li.append(pips, name, size);
    el.appendChild(li);
  }
}

export function logLine(el, html, cls = '') {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.innerHTML = html;
  el.appendChild(li);
  // 有人正在讀某則的說明時先別捲動——內容從游標底下溜走很惱人。
  // 放開後由呼叫端補捲到底。
  if (!el.dataset.hold) el.scrollTop = el.scrollHeight;
  // 戰報留 200 則就夠了，久戰不必無限長。
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

// 中上方的動作提示：每次出手就跳一下，讓人不用一直盯戰報。
// 跟 toast 不同——這裡只留最新一則，後來的直接取代前一則。
let bannerTimer = null;
export function banner(html, kind = '') {
  const el = $('actionBanner');
  if (!el) return;
  el.className = `action-banner ${kind}`.trim();
  el.innerHTML = html;
  el.hidden = false;
  // 重播一次進場動畫，連續事件才看得出「又跳了一下」
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => { el.hidden = true; el.classList.remove('out'); }, 320);
  }, kind === 'ghost' ? 5200 : 2800);
}

export function toast(text, kind = '') {
  const stack = $('toastStack');
  // 同一句話還掛在畫面上就不再疊一個，只把它的倒數重置（連點時最常見）。
  const dup = [...stack.children].find(c => c.dataset.text === text);
  if (dup) {
    dup.classList.remove('out');
    clearTimeout(+dup.dataset.timer);
    dup.dataset.timer = setTimeout(() => fadeToast(dup), 2600);
    return;
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = text;
  el.dataset.text = text;
  stack.appendChild(el);
  // 最多留 3 則，太多會蓋掉棋盤。
  while (stack.children.length > 3) stack.firstChild.remove();
  el.dataset.timer = setTimeout(() => fadeToast(el), 2600);
}

function fadeToast(el) {
  el.classList.add('out');
  setTimeout(() => el.remove(), 320);
}

const SCREENS = ['screenLobby', 'screenSetup', 'screenBattle'];
export function setScreen(name) {
  for (const id of SCREENS) $(id).hidden = (id !== name);
  $('topbar').hidden = (name === 'screenLobby');
}

// HTML 轉義：聊天訊息與對手代號都是別人送來的字串，不能直接塞進 innerHTML。
export const esc = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
