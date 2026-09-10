// 純遊戲邏輯：不碰 DOM、不碰網路，方便單獨推理與測試。
export const SIZE = 10;

// 經典模式：5 艘、17 格
export const SHIP_TYPES = [
  { id: 'carrier',    name: '航空母艦', size: 5 },
  { id: 'battleship', name: '戰艦',     size: 4 },
  { id: 'cruiser',    name: '巡洋艦',   size: 3 },
  { id: 'submarine',  name: '潛水艇',   size: 3 },
  { id: 'destroyer',  name: '驅逐艦',   size: 2 },
];

// 幽靈船幾格。改這個數字就好：
//   1 → 難找（中位 38 發、約 5 分鐘），純運氣，命中即沉
//   5 → 好找（中位 18 發、約 2.4 分鐘），打中一發能沿著追
export const GHOST_SIZE = 1;

// 海克斯模式：10 艘。9 艘先擺（1,1,2,2,3,3,4,4,5＝25 格），
// 最後那艘「幽靈船」開局不佈署，等前 9 艘全沉了才登場。
export const MAYHEM_SHIPS = [
  { id: 'carrier',    name: '航空母艦', size: 5 },
  { id: 'battleship', name: '戰艦',     size: 4 },
  { id: 'heavy',      name: '重巡洋艦', size: 4 },
  { id: 'cruiser',    name: '巡洋艦',   size: 3 },
  { id: 'submarine',  name: '潛水艇',   size: 3 },
  { id: 'destroyer',  name: '驅逐艦',   size: 2 },
  { id: 'frigate',    name: '護衛艦',   size: 2 },
  { id: 'torpedo',    name: '魚雷艇',   size: 1 },
  { id: 'scout',      name: '偵察艇',   size: 1 },
  { id: 'ghost',      name: '幽靈船',   size: GHOST_SIZE, ghost: true },
];

export const fleetSpec = mayhem => (mayhem ? MAYHEM_SHIPS : SHIP_TYPES);
// 幽靈船不在開局佈署，所以「要擺幾艘」跟「總共幾艘」是兩個數字
export const deployCount = spec => spec.filter(s => !s.ghost).length;

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

export function emptyFleet(spec = SHIP_TYPES) {
  return spec.map(t => ({ ...t, x: null, y: null, dir: 'h', hits: [] }));
}

export function randomFleet(spec = SHIP_TYPES) {
  const fleet = emptyFleet(spec);
  for (const ship of fleet) {
    if (ship.ghost) continue;          // 幽靈船留到後面才登場
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

// 開局只需要把非幽靈船擺好
export const isFleetPlaced = fleet => fleet.every(s => s.ghost || s.x != null);

// 除了幽靈船以外全部沉了 → 該讓幽靈船登場
export const nonGhostAllSunk = fleet =>
  fleet.some(s => s.ghost) &&
  fleet.filter(s => !s.ghost).every(s => s.x != null && s.hits.length === s.size);

export const ghostOf = fleet => fleet.find(s => s.ghost) || null;

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
// shots 的值：'miss' | 'hit' | 'sunk' | 'armor'(裝甲彈開) | 'intel'(情報：有船) | 'decoy'(假船)
// near：深海雷達的落空提示；sonar：聲納掃過的 3×3 區域 'yes' | 'no'
export function newTracker() {
  return { shots: new Map(), sunkShips: [], near: new Map(), sonar: new Map() };
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
