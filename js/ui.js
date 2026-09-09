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

// 我方海域：自己的船 + 對方打過的每一發。
export function paintMyBoard(cells, fleet, incoming, lastShot) {
  resetCells(cells);
  for (const ship of fleet) {
    if (ship.x != null) paintShip(cells, ship);
  }
  const occ = occupancy(fleet);
  for (const [k, kind] of incoming) {
    const el = cells.get(k);
    if (!el) continue;
    if (kind === 'miss') { el.className = 'cell miss'; continue; }
    const hitShip = occ.get(k)?.ship;
    const sunk = hitShip && hitShip.hits.length === hitShip.size;
    el.classList.add(sunk ? 'sunk' : 'hit');
  }
  if (lastShot) cells.get(lastShot)?.classList.add('last-shot');
}

// 敵方海域：只有我打出去的結果，船身永遠不顯示（除非終局揭曉）。
export function paintEnemyBoard(cells, tracker, lastShot, revealFleet) {
  resetCells(cells);
  if (revealFleet) {
    for (const ship of revealFleet) {
      if (ship.x != null) paintShip(cells, ship);
    }
  }
  for (const [k, kind] of tracker.shots) {
    const el = cells.get(k);
    if (!el) continue;
    el.classList.remove('ship', 'vert', 'edge-start', 'edge-end');
    el.classList.add(kind);
  }
  if (lastShot) cells.get(lastShot)?.classList.add('last-shot');
}

export function renderDock(el, fleet, selectedId) {
  el.innerHTML = '';
  for (const ship of fleet) {
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
  el.scrollTop = el.scrollHeight;
  // 戰報留 200 則就夠了，久戰不必無限長。
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

export function toast(text, kind = '') {
  const stack = $('toastStack');
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = text;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

const SCREENS = ['screenLobby', 'screenSetup', 'screenBattle'];
export function setScreen(name) {
  for (const id of SCREENS) $(id).hidden = (id !== name);
  $('topbar').hidden = (name === 'screenLobby');
}

// HTML 轉義：聊天訊息與對手代號都是別人送來的字串，不能直接塞進 innerHTML。
export const esc = s => String(s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
