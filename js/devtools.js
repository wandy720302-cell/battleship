// 開發者測試面板：只在網址帶 ?dev=1 時出現，一般玩家看不到、也不會載入。
// 目的是取代「臨時加測試鉤子、測完再刪」的流程——這次做成永久但隱藏的工具，
// 之後測任何「剩幾艘船才會怎樣」的效果都能秒測。
import { AUG, AUGMENTS, TIER_NAME } from './hex.js';

export function initDevTools(hooks) {
  if (!location.search.includes('dev=1')) return null;
  const { getState, onSinkTo, onForceOwn, onQuickReady } = hooks;

  const root = document.createElement('div');
  root.id = 'devtools';
  root.innerHTML = `
    <button class="dev-toggle" type="button">🛠</button>
    <div class="dev-panel" hidden>
      <div class="dev-head">🛠 測試工具<span class="dev-badge">?dev=1</span></div>

      <div class="dev-row">
        <button class="dev-btn" data-quick-ready>🎲 隨機部署＋準備</button>
      </div>

      <div class="dev-sec">把我的剩餘艦艇數設為</div>
      <div class="dev-row dev-sink">
        <button class="dev-btn" data-sink="2">2 艘（虛式「茈」條件）</button>
        <button class="dev-btn" data-sink="1">1 艘（背水一戰條件）</button>
      </div>

      <div class="dev-sec">強制取得強化（會照正常流程同步給對手）</div>
      <select class="dev-select" id="devAugSelect"></select>
      <button class="dev-btn dev-btn-block" data-force-own>取得</button>

      <p class="dev-note" id="devNote"></p>
    </div>`;
  document.body.appendChild(root);

  const select = root.querySelector('#devAugSelect');
  select.innerHTML = AUGMENTS.map(a =>
    `<option value="${a.id}">${TIER_NAME[a.tier]}｜${a.name}</option>`).join('');

  const note = root.querySelector('#devNote');
  const say = text => { note.textContent = text; };

  root.querySelector('.dev-toggle').addEventListener('click', () => {
    root.querySelector('.dev-panel').hidden = !root.querySelector('.dev-panel').hidden;
  });

  root.querySelector('[data-quick-ready]').addEventListener('click', () => {
    const s = getState();
    if (s.phase !== 'setup') return say('要在擺船畫面才能用');
    onQuickReady();
    say('已隨機部署並按下準備');
  });

  root.querySelectorAll('[data-sink]').forEach(btn => {
    btn.addEventListener('click', () => {
      const s = getState();
      if (s.phase !== 'battle') return say('要在對戰中才能用（開著海克斯大亂鬥）');
      if (!s.mayhem) return say('這兩個門檻是海克斯大亂鬥才有的機制');
      onSinkTo(+btn.dataset.sink);
      say(`已把你的剩餘艦艇數設為 ${btn.dataset.sink}——下次輪到你選卡時應該就有機會刷到`);
    });
  });

  root.querySelector('[data-force-own]').addEventListener('click', () => {
    const s = getState();
    if (s.phase !== 'battle') return say('要在對戰中才能用');
    if (!s.mayhem) return say('強化是海克斯大亂鬥才有的機制');
    const id = select.value;
    if (s.owned?.includes(id)) return say(`你已經有 ${AUG[id].name} 了`);
    onForceOwn(id);
    say(`已取得 ${AUG[id].name}（已同步給對手，跟真的抽到一樣）`);
  });

  return { root };
}
