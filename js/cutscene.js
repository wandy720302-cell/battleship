// 虛式「茈」發動時的專屬過場：影片 + 捲動文字。
// 純表現層，跟 hex.js 的規則完全分開；main.js 只呼叫 playHollowPurple()。
const TEXT = [
  '在茈發動前的41秒內，新宿再次響起了五條悟的吟唱。',
  '「九綱」「偏光」「烏與聲明」「表裡之間」，宿儺明白自己再也沒有任何機會阻止茈的誕生了，' +
  '無限制的虛式如同核爆一般在新宿亮起沖天的光芒，魔虛羅的輪盤在茈中灰飛煙滅，廢墟之中，' +
  '全力護住自己的宿儺無力的靠在殘破的建築上支持身體，他的左手和大腿都被這一擊吞噬殆盡，' +
  '同樣傷痕累累的五條悟出現在宿儺面前，宿儺立刻強迫自己不再倚靠牆壁，堂堂正正站在五條悟面前，' +
  '但是在咒力同源的影響下，五條悟所承受的傷害被大大削弱，在反轉術式的治療下五條悟的身體再次恢復，' +
  '對五條悟來說，決定性的一擊遠距離「茈」只是其即興創作，結果魔虛羅被秒，' +
  '「看來完成的還算不錯」，誰能想到魔虛羅和宿儺發了瘋阻止的只是五條悟剛剛開發的技能，' +
  '五條悟在茈發動前的短短41秒內見招拆招，完成了數個幾乎可以編入教科書的隨機應變操作。',
  '虎杖呆呆的看著屏幕仍不可置信，「也就是說……」，「沒錯，是五條悟贏了！」',
].map(p => `<p>${p}</p>`).join('');

const CRAWL_MS = 5000;    // 跟影片一樣長（5 秒）；可以按 Esc / 點擊隨時跳過

export function initCutscene() {
  const root = document.createElement('div');
  root.id = 'cutscene';
  root.hidden = true;
  root.innerHTML = `
    <div class="cutscene-stage">
      <video class="cutscene-video" src="assets/hollowpurple.mp4" playsinline></video>
      <div class="cutscene-vignette"></div>
      <div class="cutscene-crawl-mask">
        <div class="cutscene-crawl">${TEXT}</div>
      </div>
      <div class="cutscene-title">虛式「茈」</div>
      <button class="cutscene-skip" type="button">跳過 <kbd>Esc</kbd></button>
    </div>`;
  document.body.appendChild(root);

  const video = root.querySelector('.cutscene-video');
  const crawl = root.querySelector('.cutscene-crawl');
  const skipBtn = root.querySelector('.cutscene-skip');
  let closeTimer = null;
  let active = false;

  function close() {
    if (!active) return;
    active = false;
    root.classList.add('out');
    clearTimeout(closeTimer);
    video.pause();
    setTimeout(() => { root.hidden = true; root.classList.remove('out'); }, 260);
  }

  function play() {
    if (active) return;   // 已經在播就不要疊第二次
    active = true;
    root.hidden = false;
    root.classList.remove('out');
    video.currentTime = 0;
    // 這一刻通常緊接著使用者剛才的點擊（攻方）或本頁面稍早已有過互動（守方），
    // 瀏覽器的自動播放限制通常都會放行；真的被擋也不影響文字捲動照跑。
    video.play().catch(() => {});
    // CRAWL_MS 是唯一真相來源：直接把秒數寫進 shorthand，不靠 CSS 裡的預設值，
    // 兩處數字不會再有機會兜不起來。
    crawl.style.animation = 'none';
    void crawl.offsetWidth;
    crawl.style.animation = `hp-crawl ${CRAWL_MS}ms linear forwards`;
    closeTimer = setTimeout(close, CRAWL_MS);
  }

  // Esc 不在這裡自己攔——main.js 有一整條「按 Esc 該做什麼」的優先序
  // （教學、瞄準模式、上班模式都搶同一顆鍵），過場動畫的關閉交給那邊呼叫
  // close()，不然兩個監聽器都會收到同一次按鍵，跳過過場會連帶誤觸下一層。
  skipBtn.addEventListener('click', close);
  root.addEventListener('click', e => { if (e.target === root) close(); });
  video.addEventListener('error', () => { /* 影片壞掉不該卡住文字 */ });

  return { play, close, get active() { return active; } };
}
