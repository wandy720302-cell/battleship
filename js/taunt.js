// 嘲諷貼圖：聊天室按鈕開貼圖選單，點下去雙方（含觀戰者）都會在畫面正中央看到
// 一張跟棋盤等大的貼圖彈出。純表現層，貼圖清單完全由 assets/stickers/manifest.json
// 驅動——新增貼圖不用改這支檔案，見檔尾的操作說明。
const SHOW_MS = 2200;

async function loadManifest() {
  try {
    const res = await fetch('assets/stickers/manifest.json', { cache: 'no-store' });
    if (!res.ok) return [];
    const list = await res.json();
    return Array.isArray(list) ? list.filter(s => s && s.id && s.file) : [];
  } catch {
    return [];
  }
}

// hooks: { onSend(id)：使用者選了一張貼圖要送出去, getBoardEl()：回傳目前該拿來量尺寸的棋盤 DOM }
export function initTaunt({ onSend, getBoardEl }) {
  let stickers = [];
  const byId = new Map();

  // ── 選單按鈕 + 下拉面板，掛在聊天輸入框旁邊 ──
  const chatForm = document.getElementById('chatForm');
  const wrap = document.createElement('div');
  wrap.className = 'taunt-wrap';
  wrap.innerHTML = `
    <button type="button" class="btn btn-ghost btn-sm taunt-btn" disabled>😏 嘲諷</button>
    <div class="taunt-picker" hidden></div>`;
  chatForm?.insertAdjacentElement('afterbegin', wrap);

  const btn = wrap.querySelector('.taunt-btn');
  const picker = wrap.querySelector('.taunt-picker');

  function renderPicker() {
    if (!stickers.length) {
      btn.disabled = true;
      btn.title = '還沒有貼圖，把圖片放進 assets/stickers/ 並加進 manifest.json';
      return;
    }
    btn.disabled = false;
    btn.title = '送一張嘲諷貼圖給對面';
    picker.innerHTML = stickers.map(s =>
      `<button type="button" class="taunt-item" data-id="${s.id}" title="${s.label || ''}">
        <img src="assets/stickers/${s.file}" alt="${s.label || s.id}" loading="lazy">
      </button>`).join('');
  }

  loadManifest().then(list => {
    stickers = list;
    byId.clear();
    for (const s of stickers) byId.set(s.id, s);
    renderPicker();
  });

  btn.addEventListener('click', () => { picker.hidden = !picker.hidden; });
  picker.addEventListener('click', e => {
    const item = e.target.closest('.taunt-item');
    if (!item) return;
    picker.hidden = true;
    onSend(item.dataset.id);
  });
  document.addEventListener('click', e => {
    if (!picker.hidden && !wrap.contains(e.target)) picker.hidden = true;
  });

  // ── 全螢幕置中彈圖，尺寸跟目前棋盤一樣大 ──
  const root = document.createElement('div');
  root.id = 'tauntFlash';
  root.hidden = true;
  root.innerHTML = `<img class="taunt-flash-img" alt="嘲諷貼圖">`;
  document.body.appendChild(root);
  const img = root.querySelector('.taunt-flash-img');
  let closeTimer = null;
  let active = false;

  function close() {
    if (!active) return;
    active = false;
    root.classList.add('out');
    clearTimeout(closeTimer);
    setTimeout(() => { root.hidden = true; root.classList.remove('out'); }, 220);
  }

  function show(id) {
    const s = byId.get(id);
    if (!s) return;
    const board = getBoardEl?.();
    const rect = board?.getBoundingClientRect();
    const size = rect && rect.width > 0 ? Math.round(rect.width) : 320;
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    img.src = `assets/stickers/${s.file}`;
    active = true;
    root.hidden = false;
    root.classList.remove('out');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, SHOW_MS);
  }

  root.addEventListener('click', close);

  return { show, close, get active() { return active; } };
}

// ── 新增貼圖的方法 ──────────────────────────────────
// 1. 把圖片檔（PNG/JPG/GIF/WebP 都行）丟進 assets/stickers/ 資料夾。
// 2. 打開 assets/stickers/manifest.json，加一筆：
//      { "id": "唯一英文代號", "file": "檔名.png", "label": "滑鼠移上去顯示的文字" }
// 3. 存檔、重新整理頁面就會出現在嘲諷選單裡，不用改任何 .js 檔。
