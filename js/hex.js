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

  // ── 第二批（新增，不取代上面任何一張）──
  // 「乘勝追擊」「背水一戰」跟舊卡同名但機制不同（舊版無限連鎖／沒有自癒），
  // id 加 2 區分，畫面上的名字會自動帶「（新版）」避免三選一撞名混淆。
  { id: 'basicsonar', name: '初級聲納',   tier: 'silver', cat: '偵察', kind: 'active', once: true,
    desc: '消耗一回合，掃描一個 3×3 區域，只告訴你範圍內「有」或「沒有」敵船。每局一次。' },
  { id: 'decoybuoy',  name: '誘餌浮標',   tier: 'silver', cat: '防禦', kind: 'instant',
    desc: '佈陣時額外放置一個 1 格誘餌。對手第一次打中該格時算「擊中」，但那格不屬於任何真實船隻。' },
  { id: 'sectorscan', name: '局部探測',   tier: 'silver', cat: '偵察', kind: 'active', once: true,
    desc: '消耗一回合，指定一整條橫列或直行，只告訴你這條線上「有」或「沒有」敵船部位。每局一次。' },
  { id: 'logbook',    name: '航海日誌',   tier: 'silver', cat: '偵察', kind: 'passive',
    desc: '連續 3 次落空後，自動標記敵方海域 1 格「確定沒有船」的空格。每局最多觸發 2 次。' },
  { id: 'pressattack2', name: '乘勝追擊（新版）', tier: 'gold', cat: '火力', kind: 'passive',
    desc: '擊中立刻多開 1 槍，但這發不管中不中都不會再觸發——每回合最多開火 2 次，不會無限連殺。' },
  { id: 'heavyartillery', name: '重型火砲', tier: 'gold', cat: '火力', kind: 'active', once: true,
    desc: '放棄本回合常規開火，改轟炸一個 2×2 區域（4 格），一次結算全部受損。每局一次。' },
  { id: 'fleetmaneuver', name: '艦隊重編', tier: 'gold', cat: '防禦', kind: 'active', once: true,
    desc: '不消耗回合。把一艘完全未受損的船朝任意方向平移 1 格（新位置需合法）。每局一次。' },
  { id: 'warmonger',  name: '戰爭狂熱',   tier: 'prism',  cat: '稜鏡', kind: 'passive',
    desc: '每徹底擊沉一艘敵艦，你每回合的基礎開火次數永久 +1（會疊加）。' },
  { id: 'dreadnought', name: '無畏號裝甲', tier: 'prism', cat: '稜鏡', kind: 'instant',
    desc: '指定你的旗艦（最大艘的船）。它的每一格要被打中 3 次才算受損，前 2 次都只會看到「裝甲彈開」。' },
  { id: 'orbitalstrike', name: '軌道打擊', tier: 'prism', cat: '稜鏡', kind: 'active', once: true,
    desc: '放棄本回合所有開火，指定一整條橫列或直行，該線上所有敵艦部位直接翻開並視為命中 1 次。每局一次。' },
  { id: 'laststand2', name: '背水一戰（新版）', tier: 'prism', cat: '稜鏡', kind: 'passive',
    desc: '只剩最後一艘船時，每回合固定開火 2 次；該回合只要有命中，隨機修復自己 1 個受損部位（不能復活已沉的船）。' },
  { id: 'romantic168', name: '浪漫168突襲', tier: 'prism', cat: '稜鏡', kind: 'active', once: true,
    desc: '放棄本回合開火，直接隨機偷走對手一張已擁有的強化（變成你的）。發動時雙方畫面會跳出專屬圖片。每局一次。' },
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
//        extra:{host,guest}, turnShots:{host,guest}, bonus:{host,guest},
//        baseShots:{host,guest} }
// st 會被就地更新；回傳下一個出手的人。
export function advanceTurn(shooter, agg, st) {
  const defender = shooter === 'host' ? 'guest' : 'host';
  const has = (side, id) => st.owned[side].includes(id);
  const wasBonus = st.bonus[shooter];   // 這一發本身是不是「額外送的」，判斷完就可以丟

  // 關鍵：乘勝追擊／幽靈艦補償送的那一發是「額外的」，
  // 不該吃掉這一輪的基本開火額度，否則背水一戰的 2 槍會被連鎖吃光。
  if (wasBonus) st.bonus[shooter] = false;
  else st.turnShots[shooter] += 1;

  let next;
  if (agg.decoySunk) {
    // 打沉的是假船：攻方回合立刻結束，守方還多得一發
    st.extra[defender] += 1;
    next = defender;
  } else if (agg.hit && (st.variant === 'hit-again' || has(shooter, 'press'))) {
    // 舊版乘勝追擊／房規連射：無限連鎖，命中就一直送
    next = shooter;
    st.bonus[shooter] = true;
  } else if (agg.hit && has(shooter, 'pressattack2') && !wasBonus) {
    // 新版乘勝追擊：只從「非額外」的命中觸發一次，這發本身不會再送——封頂 2 發
    next = shooter;
    st.bonus[shooter] = true;
  } else if (st.extra[shooter] > 0) {
    st.extra[shooter] -= 1;
    next = shooter;
    st.bonus[shooter] = true;
  } else {
    // 背水一戰（新舊版都算）保底 2 發、戰爭狂熱疊加的永久基礎開火次數，
    // 兩個都是「跟命中與否無關」的固定額度，取比較大的那個。
    const lastShipFloor = (has(shooter, 'laststand') || has(shooter, 'laststand2'))
      && st.remaining[shooter] === 1 ? 2 : 1;
    const floor = Math.max(lastShipFloor, st.baseShots?.[shooter] || 1);
    next = st.turnShots[shooter] < floor ? shooter : defender;
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

// 幽靈艦隊 / 誘餌浮標共用：隨機放一艘 size 格假船，不能跟真船重疊。
// blockers 要帶入「對手已經打過的格子」——假船躲在既有的落空標記底下等於白放，
// 對手根本不會再打那裡。兩張卡共用同一個假船欄位，同時擁有時後選的會蓋掉前一個。
export function randomDecoy(fleet, blockers = [], size = 3) {
  const probe = { id: '__decoy', size };
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

// 局部探測／軌道打擊共用：整條橫列或直行的所有格子。
// orientation 'row'：index 是 y，回傳這一列所有 x；'col'：index 是 x，回傳這一行所有 y。
export function lineCells(orientation, index) {
  const cells = [];
  for (let i = 0; i < SIZE; i++) {
    cells.push(orientation === 'row' ? { x: i, y: index } : { x: index, y: i });
  }
  return cells;
}

// 局部探測：這條線上有沒有船（含假船），只回是非。
export function linePresent(def, orientation, index) {
  const keys = allShipKeys(def);
  return lineCells(orientation, index).some(c => keys.has(key(c.x, c.y)));
}

// 重型火砲：以點擊格為錨點的 2×2，貼邊界內縮，永遠取滿 4 格。
export function squareCells2x2(x, y) {
  const sx = Math.min(Math.max(x, 0), SIZE - 2);
  const sy = Math.min(Math.max(y, 0), SIZE - 2);
  const cells = [];
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) cells.push({ x: sx + dx, y: sy + dy });
  return cells;
}

// 艦隊重編：把一艘完全未受損的船朝 (dx,dy) 移 1 格；擺不下回傳 false，不消耗這次嘗試。
export function shiftShip(fleet, blockers, shipId, dx, dy) {
  const ship = fleet.find(s => s.id === shipId);
  if (!ship || !isUndamaged(ship)) return false;
  const nx = ship.x + dx, ny = ship.y + dy;
  const others = fleet.filter(s => s.id !== shipId);
  if (!canPlace([...others, ...blockers], ship, nx, ny, ship.dir)) return false;
  ship.x = nx; ship.y = ny;
  return true;
}

// 背水一戰（新版）的自癒：隨機挑一艘「有受損但還沒沉」的船，修復 1 格。
// 找不到符合資格的船（要嘛全滿、要嘛已經沉了）就回傳 null，呼叫端不用做任何事。
export function healRandomCell(fleet) {
  const pool = fleet.filter(s => !s.ghost && s.x != null && s.hits.length > 0 && s.hits.length < s.size);
  if (!pool.length) return null;
  const ship = pool[Math.floor(Math.random() * pool.length)];
  const idx = ship.hits[Math.floor(Math.random() * ship.hits.length)];
  ship.hits = ship.hits.filter(i => i !== idx);
  return { shipId: ship.id, index: idx };
}

// 航海日誌：隨機挑一格「確定沒有船」的空格，excludeKeys 排除攻方已經打過/已知的格子（不然等於白送情報）。
export function randomEmptyCell(def, excludeKeys = []) {
  const keys = allShipKeys(def);
  const excl = new Set(excludeKeys);
  const pool = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const k = key(x, y);
    if (!keys.has(k) && !excl.has(k)) pool.push({ x, y });
  }
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
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
  // 無畏號裝甲：跟反應裝甲共用「carrier = 旗艦」的假設（兩套現有編制裡最大艘的都是它），
  // 差別是要彈開 2 次才開始算真的受損。兩者都有的話，反應裝甲先判到就不會再進這裡——
  // 沒特別處理疊加，效果不會加成。
  if (def.dreadnought && target?.ship.id === 'carrier' && (def.dreadnoughtHits.get(k) || 0) < 2) {
    def.dreadnoughtHits.set(k, (def.dreadnoughtHits.get(k) || 0) + 1);
    return { x, y, hit: false, armor: true, sunk: null };
  }
  return receiveFire(def.fleet, x, y);
}
