// 可玩的上班模式：假 Excel。棋盤就是試算表上的兩塊範圍，
// 命中 = 紅字負數、落空 = 會計格式的「-」、擊沉 = 淺紅填滿深紅字（Excel 內建條件格式）。
import { SIZE, key, occupancy, canPlace, cellsOf } from './game.js';

const COLS = 24;   // A–X；1366 寬的筆電也要一次看到兩塊棋盤
const ROWS = 32;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
const REGIONS = ['North', 'South', 'East', 'West', 'Central', 'NE', 'NW', 'SE', 'SW', 'HQ'];

// 兩塊棋盤在試算表上的位置（0-based 欄/列索引）
const BLOCK = {
  left:  { col: 1,  row: 3, title: 'Forecast' },  // B4:K13
  right: { col: 12, row: 3, title: 'Actual'   },  // M4:V13
};

// 小型 PRNG，讓「業績數字」每次重畫都一樣，不然會像在閃。
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function makeValues(seed) {
  const rnd = mulberry32(seed);
  const v = [];
  for (let y = 0; y < SIZE; y++) {
    v.push([]);
    for (let x = 0; x < SIZE; x++) v[y].push(120 + rnd() * 8800);
  }
  return v;
}
const VALUES = { left: makeValues(20260909), right: makeValues(7355608) };
// 無小數：欄寬 52px 塞得下 "(8,730)"，塞不下 "(8,729.93)"。
const fmt = n => Math.round(n).toLocaleString('en-US');
const neg = n => `(${fmt(n)})`;

export function initExcelMode(hooks) {
  const {
    getState, onFire, onReady, onRandom, onRematch, onPlace, onLift, onEnter, onExit,
  } = hooks;

  const root = document.createElement('div');
  root.id = 'excelMode';
  root.hidden = true;
  root.innerHTML = `
    <div class="xl-title">
      <span class="xl-title-left"><span class="xl-logo">X</span><span class="xl-qat">&#128190; &#8617; &#8618;</span></span>
      <span class="xl-title-center">Q3_Forecast.xlsx &nbsp;&#8226;&nbsp; Saved</span>
      <span class="xl-title-right"><span>&#8212;</span><span>&#9633;</span><span>&#10005;</span></span>
    </div>
    <div class="xl-ribbon-tabs">
      <span>File</span><span class="active">Home</span><span>Insert</span><span>Page Layout</span>
      <span>Formulas</span><span>Data</span><span>Review</span><span>View</span><span>Help</span>
    </div>
    <div class="xl-ribbon">
      <div class="xl-group"><div class="xl-group-body"><span class="xl-big">&#128203;</span><span class="xl-small">&#9986;<br>&#128203;<br>&#128396;</span></div><div class="xl-group-label">Clipboard</div></div>
      <div class="xl-group"><div class="xl-group-body xl-font">
        <span class="xl-select">Calibri</span><span class="xl-select xl-select-sm">11</span>
        <span class="xl-btns"><b>B</b><i>I</i><u>U</u> &#9633; &#9650; A</span></div><div class="xl-group-label">Font</div></div>
      <div class="xl-group"><div class="xl-group-body xl-align">&#8801; &#8801; &#8801; &nbsp; &#8676; &#8677; &nbsp; Wrap Text<br>&#8801; &#8801; &#8801; &nbsp; &#8676; &#8677; &nbsp; Merge &amp; Center</div><div class="xl-group-label">Alignment</div></div>
      <div class="xl-group"><div class="xl-group-body xl-align"><span class="xl-select">Accounting</span><br>$ &nbsp; % &nbsp; , &nbsp; .00 &nbsp; .0</div><div class="xl-group-label">Number</div></div>
      <div class="xl-group"><div class="xl-group-body xl-align"><span class="xl-big-btn">Conditional<br>Formatting</span><span class="xl-big-btn">Format as<br>Table</span><span class="xl-big-btn">Cell<br>Styles</span></div><div class="xl-group-label">Styles</div></div>
      <div class="xl-group"><div class="xl-group-body xl-align"><span class="xl-big-btn">&#8721; AutoSum</span><span class="xl-big-btn">Sort &amp;<br>Filter</span></div><div class="xl-group-label">Editing</div></div>
    </div>
    <div class="xl-formula">
      <span class="xl-namebox" id="xlName">B4</span>
      <span class="xl-fx">&#10005; &#10003; <i>fx</i></span>
      <span class="xl-fbar" id="xlFormula"></span>
    </div>
    <div class="xl-sheet-wrap">
      <table class="xl-sheet" id="xlSheet"></table>
    </div>
    <div class="xl-tabs">
      <span class="xl-nav">&#9664; &#9654;</span>
      <span class="xl-tab active">Q3_Forecast</span><span class="xl-tab">Summary</span><span class="xl-tab">Raw</span><span class="xl-tab">Pivot</span>
      <span class="xl-tab-add">&#8853;</span>
    </div>
    <div class="xl-status">
      <span id="xlStatus">Ready</span>
      <span class="xl-status-right" id="xlStatusRight"></span>
      <span class="xl-zoom">&#9638; &#9636; &#9637; &nbsp; &#8722; &#9472;&#9472;&#9472;&#9673;&#9472;&#9472;&#9472; &#43; &nbsp;100%</span>
    </div>
    <div class="xl-dialog" id="xlDialog" hidden>
      <div class="xl-dialog-box">
        <div class="xl-dialog-title">Microsoft Excel</div>
        <div class="xl-dialog-body"><span class="xl-dialog-icon">&#8505;</span><span id="xlDialogText"></span></div>
        <div class="xl-dialog-actions"><button id="xlDialogOk">OK</button><button id="xlDialogCancel">Cancel</button></div>
      </div>
    </div>`;
  document.body.appendChild(root);

  // ── 建表 ────────────────────────────────────────────
  const cells = [];        // cells[row][col] -> td
  const colHeads = [];
  const rowHeads = [];
  (function build() {
    const table = root.querySelector('#xlSheet');
    const thead = document.createElement('tr');
    thead.appendChild(document.createElement('th')).className = 'xl-corner';
    for (let c = 0; c < COLS; c++) {
      const th = document.createElement('th');
      th.textContent = LETTERS[c];
      colHeads.push(th);
      thead.appendChild(th);
    }
    table.appendChild(thead);
    for (let r = 0; r < ROWS; r++) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = r + 1;
      rowHeads.push(th);
      tr.appendChild(th);
      cells.push([]);
      for (let c = 0; c < COLS; c++) {
        const td = document.createElement('td');
        td.dataset.r = r; td.dataset.c = c;
        cells[r].push(td);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
  })();

  const cellAt = (r, c) => cells[r]?.[c];
  const put = (r, c, text, cls = '') => {
    const td = cellAt(r, c);
    if (!td) return;
    td.textContent = text;
    td.className = cls;
  };

  // 固定的表頭裝飾，只畫一次。
  function paintChrome() {
    put(0, 0, 'Regional Sales Report — FY2026', 'xl-h1');
    put(1, 0, 'Unit: USD (thousands)', 'xl-note');
    for (const side of ['left', 'right']) {
      const b = BLOCK[side];
      put(b.row - 2, b.col, b.title, 'xl-h2');
      put(b.row - 1, b.col - 1, 'Region', 'xl-th');
      for (let i = 0; i < SIZE; i++) put(b.row - 1, b.col + i, MONTHS[i], 'xl-th xl-right');
      for (let i = 0; i < SIZE; i++) put(b.row + i, b.col - 1, REGIONS[i], 'xl-label');
      put(b.row + SIZE, b.col - 1, 'Total', 'xl-th');
      for (let x = 0; x < SIZE; x++) {
        const sum = VALUES[side].reduce((acc, row) => acc + row[x], 0);
        put(b.row + SIZE, b.col + x, fmt(sum), 'xl-th xl-right xl-total');
      }
    }
    put(BLOCK.right.row + SIZE + 2, BLOCK.right.col - 1, 'Variance', 'xl-th');
    put(BLOCK.right.row + SIZE + 2, BLOCK.right.col, '=SUM(M14:V14)-SUM(B14:K14)', 'xl-formula-cell');
  }

  // ── 狀態 ────────────────────────────────────────────
  let armed = false;
  let sel = { x: 0, y: 0 };  // 選取格（遊戲座標）：擺船時在右表 Actual，開戰後在左表 Forecast
  let dir = 'h';             // 擺船方向，Space 切換
  let dialogShownFor = null;
  // 擺船階段游標在自己的表上，開戰後才移到敵方。
  const curBlock = () => {
    const s = getState();
    return (s.phase === 'setup' && s.role !== 'spectator') ? 'right' : 'left';
  };
  const savedTitle = document.title;
  const favicon = document.querySelector('link[rel="icon"]');
  const savedIcon = favicon?.href;
  const XL_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="5" fill="#1d6f42"/><text x="16" y="23" font-family="Arial" font-weight="700" font-size="19" text-anchor="middle" fill="#fff">X</text></svg>`);

  const blockOf = side => BLOCK[side];
  const toSheet = (side, x, y) => ({ r: blockOf(side).row + y, c: blockOf(side).col + x });
  const fromSheet = (r, c) => {
    for (const side of ['left', 'right']) {
      const b = BLOCK[side];
      if (r >= b.row && r < b.row + SIZE && c >= b.col && c < b.col + SIZE) {
        return { side, x: c - b.col, y: r - b.row };
      }
    }
    return null;
  };
  const refName = (r, c) => LETTERS[c] + (r + 1);

  // 畫一塊「只看得到打擊結果」的區塊（敵方海域或觀戰者視角）
  function paintTracker(side, tracker, reveal) {
    const occ = reveal ? occupancy(reveal) : null;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const { r, c } = toSheet(side, x, y);
        const v = VALUES[side][y][x];
        const k = key(x, y);
        const shot = tracker.shots.get(k);
        if (shot === 'miss') put(r, c, '-', 'xl-num xl-miss');
        else if (shot === 'hit') put(r, c, neg(v), 'xl-num xl-hit');
        else if (shot === 'sunk') put(r, c, neg(v), 'xl-num xl-sunk');
        else put(r, c, fmt(v), occ?.has(k) ? 'xl-num xl-ship' : 'xl-num');
      }
    }
  }

  // 畫我方海域：船是淡藍填色，被打到才變紅。
  function paintMine(side, fleet, incoming) {
    const occ = occupancy(fleet);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const { r, c } = toSheet(side, x, y);
        const v = VALUES[side][y][x];
        const k = key(x, y);
        const hit = incoming.get(k);
        const ship = occ.get(k)?.ship;
        if (hit === 'miss') put(r, c, '-', 'xl-num xl-miss');
        else if (hit === 'hit') {
          const sunk = ship && ship.hits.length === ship.size;
          put(r, c, neg(v), sunk ? 'xl-num xl-sunk' : 'xl-num xl-hit');
        } else put(r, c, fmt(v), ship ? 'xl-num xl-ship' : 'xl-num');
      }
    }
  }

  // 擺船預覽：目前這艘船若放在游標處會佔哪幾格，放不下就紅。
  function paintPreview(s) {
    root.querySelectorAll('.xl-preview, .xl-preview-bad')
      .forEach(el => el.classList.remove('xl-preview', 'xl-preview-bad'));
    const ship = s.selectedShip;
    if (!ship) return;
    const ok = canPlace(s.myFleet, ship, sel.x, sel.y, dir);
    for (const c of cellsOf({ ...ship, x: sel.x, y: sel.y, dir })) {
      if (c.x >= SIZE || c.y >= SIZE) continue;
      const { r, c: col } = toSheet('right', c.x, c.y);
      cellAt(r, col)?.classList.add(ok ? 'xl-preview' : 'xl-preview-bad');
    }
  }

  function paintSelection() {
    root.querySelectorAll('.xl-sel').forEach(el => el.classList.remove('xl-sel'));
    colHeads.forEach(h => h.classList.remove('xl-head-on'));
    rowHeads.forEach(h => h.classList.remove('xl-head-on'));
    const { r, c } = toSheet(curBlock(), sel.x, sel.y);
    cellAt(r, c)?.classList.add('xl-sel');
    colHeads[c].classList.add('xl-head-on');
    rowHeads[r].classList.add('xl-head-on');
    root.querySelector('#xlName').textContent = refName(r, c);
    root.querySelector('#xlFormula').textContent = cellAt(r, c)?.textContent || '';
  }

  function update() {
    if (!armed) return;
    const s = getState();
    const spectator = s.role === 'spectator';

    if (spectator) {
      paintTracker('left', s.spec.host, s.specReveal.host);
      paintTracker('right', s.spec.guest, s.specReveal.guest);
    } else {
      paintTracker('left', s.enemy, s.enemyReveal);
      paintMine('right', s.myFleet, s.incoming);
      if (s.phase === 'setup' && !s.readyMe) paintPreview(s);
    }
    paintSelection();

    const status = root.querySelector('#xlStatus');
    const right = root.querySelector('#xlStatusRight');
    if (s.phase === 'setup') {
      status.textContent = s.readyMe ? 'Calculating…' : 'Ready';
      right.textContent = s.placed ? 'Count: 5' : `Count: ${s.placedCount}`;
    } else if (s.phase === 'battle') {
      status.textContent = s.myTurn ? 'Ready' : 'Calculating…';
      right.textContent = spectator
        ? `Sum: ${s.spec.host.sunkShips.length}   Count: ${s.spec.guest.sunkShips.length}`
        : `Sum: ${s.enemy.sunkShips.length}   Count: ${s.remaining}`;
    } else if (s.phase === 'over') {
      status.textContent = 'Ready';
      right.textContent = `Sum: ${s.enemy?.sunkShips.length ?? 0}   Count: ${s.remaining ?? 0}`;
      if (!spectator && dialogShownFor !== s.gameId) {
        dialogShownFor = s.gameId;
        root.querySelector('#xlDialogText').textContent = s.over === 'win'
          ? 'Data validation complete. 17 of 17 records matched. Refresh workbook now?'
          : 'Data validation failed. 0 of 17 records matched. Refresh workbook now?';
        root.querySelector('#xlDialog').hidden = false;
      }
    } else {
      status.textContent = 'Ready';
      right.textContent = '';
    }
    if (s.phase !== 'over') root.querySelector('#xlDialog').hidden = true;
  }

  // ── 互動 ────────────────────────────────────────────
  root.querySelector('#xlSheet').addEventListener('click', e => {
    const td = e.target.closest('td');
    if (!td) return;
    const pos = fromSheet(+td.dataset.r, +td.dataset.c);
    if (!pos || pos.side !== curBlock()) return;
    if (sel.x === pos.x && sel.y === pos.y) act();
    else { sel = { x: pos.x, y: pos.y }; update(); }
  });

  // Enter / 第二次點擊：擺船階段是放下或撿起，開戰後是開火。
  function act() {
    const s = getState();
    if (s.phase === 'setup') {
      if (s.readyMe) return;
      // 手上有船：只嘗試放下（放不下就沒事）。手上沒船：在船上是撿起、全放好了是準備。
      if (s.selectedShip) onPlace(sel.x, sel.y, dir);
      else if (occupancy(s.myFleet).has(key(sel.x, sel.y))) lift(s);
      else if (s.placed) onReady();
    } else if (s.phase === 'battle') {
      tryFire();
    }
  }

  // 撿起游標下的船，方向跟著那艘船走，重放時才不會莫名轉向。
  function lift(s) {
    const hit = occupancy(s.myFleet).get(key(sel.x, sel.y));
    if (!hit) return;
    dir = hit.ship.dir;
    onLift(sel.x, sel.y);
  }

  function tryFire() {
    const s = getState();
    if (s.phase !== 'battle' || !s.myTurn) return;
    if (s.enemy.shots.has(key(sel.x, sel.y))) return;
    onFire(sel.x, sel.y);
  }

  function onKey(e) {
    if (!armed) return;
    const s = getState();
    const move = (dx, dy) => {
      sel = {
        x: Math.min(SIZE - 1, Math.max(0, sel.x + dx)),
        y: Math.min(SIZE - 1, Math.max(0, sel.y + dy)),
      };
      update();
    };
    const inSetup = s.phase === 'setup' && !s.readyMe && s.role !== 'spectator';
    switch (e.key) {
      case 'ArrowUp':    e.preventDefault(); move(0, -1); break;
      case 'ArrowDown':  e.preventDefault(); move(0, 1); break;
      case 'ArrowLeft':  e.preventDefault(); move(-1, 0); break;
      case 'ArrowRight': e.preventDefault(); move(1, 0); break;
      case 'Tab':        e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); break;
      case 'Enter':      e.preventDefault(); act(); break;
      case ' ': case 'r': case 'R':
        if (!inSetup) break;
        e.preventDefault();
        dir = dir === 'h' ? 'v' : 'h';
        update();
        break;
      case 'Delete': case 'Backspace':
        if (!inSetup) break;
        e.preventDefault();
        lift(s);
        break;
      case 'F9':
        e.preventDefault();
        if (inSetup) onRandom();
        break;
    }
  }
  document.addEventListener('keydown', onKey);

  root.querySelector('#xlDialogOk').addEventListener('click', () => {
    root.querySelector('#xlDialog').hidden = true;
    onRematch();
  });
  root.querySelector('#xlDialogCancel').addEventListener('click', () => {
    root.querySelector('#xlDialog').hidden = true;
  });

  function enter() {
    if (armed) return;
    armed = true;
    root.hidden = false;
    document.title = 'Q3_Forecast.xlsx - Excel';
    if (favicon) favicon.href = XL_ICON;
    onEnter?.();
    update();
  }
  function exit() {
    if (!armed) return;
    armed = false;
    root.hidden = true;
    document.title = savedTitle;
    if (favicon && savedIcon) favicon.href = savedIcon;
    onExit?.();
  }

  paintChrome();
  return { enter, exit, update, get active() { return armed; } };
}
