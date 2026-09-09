// 純遊戲邏輯：不碰 DOM、不碰網路，方便單獨推理與測試。
export const SIZE = 10;

export const SHIP_TYPES = [
  { id: 'carrier',    name: '航空母艦', size: 5 },
  { id: 'battleship', name: '戰艦',     size: 4 },
  { id: 'cruiser',    name: '巡洋艦',   size: 3 },
  { id: 'submarine',  name: '潛水艇',   size: 3 },
  { id: 'destroyer',  name: '驅逐艦',   size: 2 },
];

export const key = (x, y) => `${x},${y}`;
export const inBounds = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;

// 一艘船佔用的所有格子。dir: 'h' 向右、'v' 向下。
export function cellsOf(ship) {
  const cells = [];
  for (let i = 0; i < ship.size; i++) {
    cells.push(ship.dir === 'h'
      ? { x: ship.x + i, y: ship.y }
      : { x: ship.x, y: ship.y + i });
  }
  return cells;
}

// 能不能把 ship 擺在 (x,y)：不出界、不與其他船重疊（不含自己）。
export function canPlace(fleet, ship, x, y, dir) {
  const probe = { ...ship, x, y, dir };
  const cells = cellsOf(probe);
  if (cells.some(c => !inBounds(c.x, c.y))) return false;
  const taken = new Set();
  for (const other of fleet) {
    if (other.id === ship.id || other.x == null) continue;
    for (const c of cellsOf(other)) taken.add(key(c.x, c.y));
  }
  return !cells.some(c => taken.has(key(c.x, c.y)));
}

export function emptyFleet() {
  return SHIP_TYPES.map(t => ({ ...t, x: null, y: null, dir: 'h', hits: [] }));
}

export function randomFleet() {
  const fleet = emptyFleet();
  for (const ship of fleet) {
    let placed = false;
    while (!placed) {
      const dir = Math.random() < 0.5 ? 'h' : 'v';
      const x = Math.floor(Math.random() * SIZE);
      const y = Math.floor(Math.random() * SIZE);
      if (canPlace(fleet, ship, x, y, dir)) {
        ship.x = x; ship.y = y; ship.dir = dir;
        placed = true;
      }
    }
  }
  return fleet;
}

export const isFleetPlaced = fleet => fleet.every(s => s.x != null);

// 佔用格子 -> 船，用來做命中查詢與繪製。
export function occupancy(fleet) {
  const map = new Map();
  for (const ship of fleet) {
    if (ship.x == null) continue;
    cellsOf(ship).forEach((c, i) => map.set(key(c.x, c.y), { ship, index: i }));
  }
  return map;
}

// 對「我方」艦隊執行一次來襲判定，會就地更新 ship.hits。
export function receiveFire(fleet, x, y) {
  const target = occupancy(fleet).get(key(x, y));
  if (!target) return { x, y, hit: false, sunk: null };
  const { ship, index } = target;
  if (!ship.hits.includes(index)) ship.hits.push(index);
  const sunk = ship.hits.length === ship.size
    ? { id: ship.id, name: ship.name, cells: cellsOf(ship) }
    : null;
  return { x, y, hit: true, sunk };
}

export const fleetDestroyed = fleet =>
  fleet.every(s => s.x != null && s.hits.length === s.size);

// 己方還沒沉的船（用來畫剩餘戰力）。
export const remainingShips = fleet =>
  fleet.filter(s => s.hits.length < s.size).length;

// 追蹤敵方棋盤：只記錄我打過的格子與結果。
export function newTracker() {
  return { shots: new Map(), sunkShips: [] };
}

export function recordShot(tracker, res) {
  tracker.shots.set(key(res.x, res.y), res.hit ? 'hit' : 'miss');
  if (res.sunk) {
    tracker.sunkShips.push(res.sunk);
    for (const c of res.sunk.cells) tracker.shots.set(key(c.x, c.y), 'sunk');
  }
}

// 下一個回合輪誰。variant 'hit-again' 時命中可以連開。
export function nextTurn(shooter, opponent, hit, variant) {
  if (variant === 'hit-again' && hit) return shooter;
  return opponent;
}
