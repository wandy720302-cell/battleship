// 通用「技能發動全螢幕閃圖」——比虛式「茈」的過場動畫陽春很多，
// 純表現層，跟 hex.js 的規則完全分開；main.js 只呼叫 play(src, title)。
const SHOW_MS = 2400;

export function initImageFlash() {
  const root = document.createElement('div');
  root.id = 'imgflash';
  root.hidden = true;
  root.innerHTML = `
    <div class="imgflash-stage">
      <img class="imgflash-img" alt="">
      <div class="imgflash-title"></div>
    </div>`;
  document.body.appendChild(root);

  const img = root.querySelector('.imgflash-img');
  const title = root.querySelector('.imgflash-title');
  let closeTimer = null;
  let active = false;

  function close() {
    if (!active) return;
    active = false;
    root.classList.add('out');
    clearTimeout(closeTimer);
    setTimeout(() => { root.hidden = true; root.classList.remove('out'); }, 260);
  }

  function play(src, text = '') {
    if (active) return;
    active = true;
    img.src = src;
    title.textContent = text;
    root.hidden = false;
    root.classList.remove('out');
    closeTimer = setTimeout(close, SHOW_MS);
  }

  root.addEventListener('click', close);

  return { play, close, get active() { return active; } };
}
