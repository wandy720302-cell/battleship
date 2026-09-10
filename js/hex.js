// 海克斯大亂鬥：強化定義 + 純規則（不碰 DOM / 網路）。
// 判定原則跟本體一樣：誰的棋盤誰判，攻方只收到結果。
import { SIZE, key, inBounds, cellsOf, occupancy, canPlace, receiveFire } from './game.js';

export const PICK_EVERY = 10;  // 每開火 N 次選一次強化（第 0 次 = 第一回合）

export const AUGMENTS = [
  { id: 'sonar',     name: '海克斯聲納', tier: 'silver', cat: '偵察', kind: 'active', once: true,
    desc: '消耗一回合，掃描一個 3×3 區域，只告訴你範圍內「有」或「沒有」敵船。每局一次。' },
  { id: 'intel',     name: '內線情報',   tier: 'silver', cat: '偵察', kind: 'instant',
    desc: '取得時立刻揭露敵方一格「有船」的座標。可能是小艇，也可能是航母。' },
  { id: 'radar',     name: '深海雷達',   tier: 'gold',   cat: '偵察', kind: 'passive',
    desc: '每次落空都會告訴你：最近的敵船在 1 格內（含斜角）還是 2 格以上。' },
  { id: 'press',     name: '乘勝追擊',   tier: 'gold',   cat: '火力', kind: 'passive',
    desc: '擊中就立刻再開一槍，連鎖到落空為止。' },
  { id: 'cross',     name: '十字爆破',   tier: 'gold',   cat: '火力', kind: 'active', once: true,
    desc: '一發高爆彈同時打目標格與上下左右共 5 格（已打過的跳過）。每局一次。' },
  { id: 'gambler',   name: '機率補償',   tier: 'silver', cat: '火力', kind: 'passive',
    desc: '連續 4 次落空後，下一發加送 2 枚隨機飛彈，一次打 3 格。' },
  { id: 'ghost',     name: '幽靈艦隊',   tier: 'gold',   cat: '防禦', kind: 'instant',
    desc: '取得時隨機佈署一艘 3 格假船。對手把它「擊沉」時回合立刻結束，你還多得 1 發射擊。' },
  { id: 'blink',     name: '緊急躍遷',   tier: 'gold',   cat: '防禦', kind: 'active', once: true,
    desc: '消耗一回合，把一艘完全未受損的船移到棋盤上任何合法位置（可旋轉）。每局一次。' },
  { id: 'armor',     name: '反應裝甲',   tier: 'gold',   cat: '防禦', kind: 'instant',
    desc: '航空母艦每一格都要被打中兩次才算受損。第一次對手只會看到「裝甲彈開」。' },
  { id: 'laststand', name: '背水一戰',   tier: 'prism',  cat: '稜鏡', kind: 'passive',
    desc: '只剩最後一艘船時，每回合可以連開 2 槍。' },
  { id: 'kamikaze',  name: '同歸於盡',   tier: 'prism',  cat: '稜鏡', kind: 'passive',
    desc: '你的船被擊沉的瞬間自爆反擊：對敵方隨機一格「有船」的位置造成 1 次必定命中。' },
  { id: 'rebuild',   name: '艦隊重組',   tier: 'prism',  cat: '稜鏡', kind: 'active', once: true,
    desc: '消耗一回合，所有完全未受損的船隨機換位，對手之前的情報全部作廢。每局一次。' },
  { id: 'hollowpurple', name: '虛式「茈」', tier: 'prism', cat: '稜鏡', kind: 'active', once: true,
    condition: 'lowHp',
    desc: '只有在你只剩最後 2 艘船時才可能刷到。消耗一回合，選一格，以該列為中心的 4 列、整整 40 格全部開火。發動時雙方畫面都會播放專屬動畫。每局一次。' },
];

// 虛式「茈」的出場條件：只剩最後 2 艘船才有機率被抽到（機率仍照階級權重，不保證抽到）。
export const hollowPurpleEligible = remaining => remaining === 2;

export const AUG = Object.fromEntries(AUGMENTS.map(a => [a.id, a]));
export const TIER_NAME = { silver: '銀', gold: '金', prism: '稜鏡' };
const TIER_WEIGHT = { silver: 3, gold: 2, prism: 1 };

// 從池裡抽三個不重複的選項，階級加權，排除已擁有與情境上無意義的。
export function rollOffers(owned, exclude = []) {
  const pool = AUGMENTS.filter(a => !owned.includes(a.id) && !exclude.includes(a.id));
  const out = [];
  while (out.length < 3 && pool.length) {
    const total = pool.reduce((s, a) => s + TIER_WEIGHT[a.tier], 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= TIER_WEIGHT[pool[idx].tier];
      if (r <= 0) break;
    }
    out.push(pool.splice(Math.min(idx, pool.length - 1), 1)[0].id);
  }
  return out;
}

// 換誰出手。攻方／守方／觀戰者三邊都跑這同一份，狀態全是公開的才不會不同步。
// st = { variant, owned:{host:[],guest:[]}, remaining:{host,guest},
//        extra:{host,guest}, turnShots:{host,guest}, bonus:{host,guest} }
// st 會被就地更新；回傳下一個出手的人。
export function advanceTurn(shooter, agg, st) {
  const defender = shooter === 'host' ? 'guest' : 'host';
  const has = (side, id) => st.owned[side].includes(id);

  // 關鍵：乘勝追擊／幽靈艦補償送的那一發是「額外的」，
  // 不該吃掉這一輪的基本開火額度，否則背水一戰的 2 槍會被連鎖吃光。
  if (st.bonus[shooter]) st.bonus[shooter] = false;
  else st.turnShots[shooter] += 1;

  let next;
  if (agg.decoySunk) {
    // 打沉的是假船：攻方回合立刻結束，守方還多得一發
    st.extra[defender] += 1;
    next = defender;
  } else if (agg.hit && (st.variant === 'hit-again' || has(shooter, 'press'))) {
    next = shooter;
    st.bonus[shooter] = true;
  } else if (st.extra[shooter] > 0) {
    st.extra[shooter] -= 1;
    next = shooter;
    st.bonus[shooter] = true;
  } else if (has(shooter, 'laststand') && st.remaining[shooter] === 1 && st.turnShots[shooter] < 2) {
    next = shooter;
  } else {
    next = defender;
  }

  if (next !== shooter) {
    st.turnShots[shooter] = 0;
    st.bonus[shooter] = false;
  }
  return next;
}

// 虛式「茈」：4 列 × 10 欄＝40 格，橫掃整個棋盤寬度。
// 以點擊格的「列」為中心取 4 列（欄一律全開，10 格永遠取滿），
// 貼著上下邊界時往內縮，不會裁短。
export const bandCells = (_x, y) => {
  const start = Math.min(Math.max(y - 1, 0), SIZE - 4);
  const cells = [];
  for (let yy = start; yy < start + 4; yy++) {
    for (let x = 0; x < SIZE; x++) cells.push({ x, y: yy });
  }
  return cells;
};

export const crossCells = (x, y) =>
  [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
    .filter(c => inBounds(c.x, c.y));

export const squareCells = (cx, cy) => {
  const out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (inBounds(cx + dx, cy + dy)) out.push({ x: cx + dx, y: cy + dy });
  }
  return out;
};

// 所有「會被當成船」的格子：真船 + 假船。
function allShipKeys(def) {
  const keys = new Set(occupancy(def.fleet).keys());
  for (const c of def.decoy?.cells || []) keys.add(key(c.x, c.y));
  return keys;
}

// 深海雷達：(x,y) 周圍 1 格（含斜角）有沒有船。
export function nearShip(def, x, y) {
  const keys = allShipKeys(def);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (keys.has(key(x + dx, y + dy))) return true;
  }
  return false;
}

// 聲納：3×3 內有沒有船。
export function sonarPresent(def, cx, cy) {
  const keys = allShipKeys(def);
  return squareCells(cx, cy).some(c => keys.has(key(c.x, c.y)));
}

// 幽靈艦隊：隨機放一艘 3 格假船，不能跟真船重疊。
// blockers 要帶入「對手已經打過的格子」——假船躲在既有的落空標記底下等於白放，
// 對手根本不會再打那裡。
export function randomDecoy(fleet, blockers = []) {
  const probe = { id: '__decoy', size: 3 };
  for (let tries = 0; tries < 500; tries++) {
    const dir = Math.random() < 0.5 ? 'h' : 'v';
    const x = Math.floor(Math.random() * SIZE);
    const y = Math.floor(Math.random() * SIZE);
    if (canPlace([...fleet, ...blockers], probe, x, y, dir)) {
      return { cells: cellsOf({ ...probe, x, y, dir }), hits: [] };
    }
  }
  return null;
}

// 內線情報 / 同歸於盡：隨機挑一格「還沒被打中」的真船格。
export function randomShipCell(fleet) {
  const pool = [];
  for (const ship of fleet) {
    if (ship.x == null) continue;
    cellsOf(ship).forEach((c, i) => { if (!ship.hits.includes(i)) pool.push(c); });
  }
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

// 緊急躍遷 / 艦隊重組共用：船完全沒受損才能動。
export const isUndamaged = ship => ship.x != null && ship.hits.length === 0;

// 艦隊重組：未受損的船全部重新隨機放，受損的不動。
// blockers 是額外要避開的格子（假船、已被打過的格），由呼叫端提供。
export function relocateUndamaged(fleet, blockers = []) {
  const movable = fleet.filter(isUndamaged);
  const backup = movable.map(s => ({ id: s.id, x: s.x, y: s.y, dir: s.dir }));
  for (const s of movable) { s.x = null; s.y = null; }
  for (const ship of movable) {
    let placed = false;
    for (let tries = 0; tries < 1000 && !placed; tries++) {
      const dir = Math.random() < 0.5 ? 'h' : 'v';
      const x = Math.floor(Math.random() * SIZE);
      const y = Math.floor(Math.random() * SIZE);
      if (canPlace([...fleet, ...blockers], ship, x, y, dir)) {
        ship.x = x; ship.y = y; ship.dir = dir; placed = true;
      }
    }
    // 棋盤太擠放不回去：整個還原，當作沒發動（呼叫端看回傳 0 就知道）。
    if (!placed) {
      for (const b of backup) { const s = fleet.find(f => f.id === b.id); s.x = b.x; s.y = b.y; s.dir = b.dir; }
      return 0;
    }
  }
  return movable.length;
}

// 把假船包裝成 canPlace 看得懂的形狀（只用 cellsOf 需要的欄位）。
export function decoyAsShip(decoy) {
  const c = decoy.cells;
  const dir = c.length > 1 && c[1].x !== c[0].x ? 'h' : 'v';
  return { x: c[0].x, y: c[0].y, dir, size: c.length };
}

// 我方防守判定：一格來襲，考慮假船與反應裝甲。
// def = { fleet, decoy, armor: bool, armorHits: Map }
export function resolveCell(def, x, y) {
  const k = key(x, y);
  // 假船
  const decoyIdx = def.decoy?.cells.findIndex(c => c.x === x && c.y === y) ?? -1;
  if (decoyIdx >= 0) {
    if (!def.decoy.hits.includes(decoyIdx)) def.decoy.hits.push(decoyIdx);
    const sunk = def.decoy.hits.length === def.decoy.cells.length
      ? { id: 'decoy', name: '幽靈艦', cells: def.decoy.cells, decoy: true }
      : null;
    return { x, y, hit: true, sunk };
  }
  // 反應裝甲：航母每格第一次打中只是彈開
  const target = occupancy(def.fleet).get(k);
  if (def.armor && target?.ship.id === 'carrier' && !def.armorHits.has(k)) {
    def.armorHits.set(k, 1);
    return { x, y, hit: false, armor: true, sunk: null };
  }
  return receiveFire(def.fleet, x, y);
}
