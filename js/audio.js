// 全部用 Web Audio 現場合成，專案裡不放任何音檔。
let ctx = null;
let enabled = true;

const ac = () => {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
};

export function setSoundEnabled(on) {
  enabled = on;
  if (!bgm || !bgmGain) return;
  // 靜音只是把音量拉到 0，播放進度繼續走——恢復時要接得回去，不是重新開始。
  if (on && bgmSrc) {
    if (bgm.paused) bgm.play().catch(() => {});
    rampGain(0.55, 0.4);
  } else if (!on) {
    rampGain(0, 0.25);
  }
}
export const isSoundEnabled = () => enabled;
// 瀏覽器要求先有使用者手勢才准出聲，開場點擊時呼叫一次。
export const unlockAudio = () => { if (enabled) ac(); };

function noiseBuffer(c, seconds) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function burst({ duration = 0.4, gain = 0.3, filterFrom = 1200, filterTo = 120 }) {
  const c = ac();
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, duration);
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(filterFrom, c.currentTime);
  filter.frequency.exponentialRampToValueAtTime(filterTo, c.currentTime + duration);
  const vol = c.createGain();
  vol.gain.setValueAtTime(gain, c.currentTime);
  vol.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);
  src.connect(filter).connect(vol).connect(c.destination);
  src.start();
  src.stop(c.currentTime + duration);
}

function tone({ from, to, duration = 0.25, type = 'sine', gain = 0.18, delay = 0 }) {
  const c = ac();
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + duration);
  const vol = c.createGain();
  vol.gain.setValueAtTime(0.0001, t0);
  vol.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  vol.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(vol).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

const play = {
  fire:  () => tone({ from: 1800, to: 300, duration: 0.18, type: 'sawtooth', gain: 0.08 }),
  miss:  () => burst({ duration: 0.35, gain: 0.22, filterFrom: 900, filterTo: 200 }),
  hit:   () => { burst({ duration: 0.5, gain: 0.4, filterFrom: 2200, filterTo: 80 });
                 tone({ from: 220, to: 55, duration: 0.35, type: 'square', gain: 0.14 }); },
  sunk:  () => { burst({ duration: 1.0, gain: 0.5, filterFrom: 2600, filterTo: 50 });
                 tone({ from: 180, to: 40, duration: 0.9, type: 'sawtooth', gain: 0.16 });
                 tone({ from: 90, to: 30, duration: 1.1, type: 'sine', gain: 0.2, delay: 0.1 }); },
  turn:  () => tone({ from: 660, to: 880, duration: 0.12, type: 'triangle', gain: 0.1 }),
  chat:  () => tone({ from: 900, to: 1200, duration: 0.08, type: 'sine', gain: 0.07 }),
  join:  () => { tone({ from: 440, to: 660, duration: 0.12, type: 'triangle', gain: 0.12 });
                 tone({ from: 660, to: 880, duration: 0.14, type: 'triangle', gain: 0.12, delay: 0.1 }); },
  win:   () => [523, 659, 784, 1046].forEach((f, i) =>
                 tone({ from: f, to: f * 1.01, duration: 0.28, type: 'triangle', gain: 0.16, delay: i * 0.13 })),
  lose:  () => [440, 370, 294, 220].forEach((f, i) =>
                 tone({ from: f, to: f * 0.99, duration: 0.34, type: 'sine', gain: 0.16, delay: i * 0.17 })),
};

export function sfx(name) {
  if (!enabled) return;
  try { play[name]?.(); } catch { /* 音效壞掉不該影響遊戲 */ }
}

// ── 背景音樂：目前只有「虛式「茈」發動後循環播放」這一種用途 ──
// 跟音效不同，這是真的 <audio> 檔案，不是合成的，所以獨立管理，
// 但一樣尊重 setSoundEnabled() 的全域靜音開關（上班模式進出會用到）。
//
// 淡入淡出刻意用 Web Audio 的 GainNode + AudioParam 排程，不用 rAF/setTimeout
// 手刻——那類 JS 計時器在分頁切到背景時會被瀏覽器大幅節流甚至暫停，音量會卡在
// 半路動不了；GainNode 的排程是瀏覽器音訊時脈自己在跑，分頁在不在前景都準。
let bgm = null;         // <audio> 元素
let bgmGain = null;     // 接在它跟喇叭之間的音量旋鈕
let bgmSrc = null;      // 記著「現在應該要播哪首」，靜音期間不出聲但不忘記

function ensureBGM(src) {
  if (bgm) return;
  bgm = new Audio();
  bgm.loop = true;
  bgm.preload = 'auto';
  const c = ac();
  bgmGain = c.createGain();
  bgmGain.gain.value = 0;
  c.createMediaElementSource(bgm).connect(bgmGain).connect(c.destination);
}

function rampGain(target, seconds) {
  const c = ac();
  const g = bgmGain.gain;
  g.cancelScheduledValues(c.currentTime);
  g.setValueAtTime(g.value, c.currentTime);       // 從目前值接著滑，不會跳一下
  g.linearRampToValueAtTime(target, c.currentTime + seconds);
}

export function playBGM(src, { volume = 0.55, fadeMs = 900 } = {}) {
  bgmSrc = src;
  ensureBGM(src);
  const already = bgm.src.endsWith(src) && !bgm.paused;
  bgm.src = src;
  if (!enabled) return;              // 靜音中就只記錄，開聲音時 setSoundEnabled 會補播
  if (!already) bgm.play().catch(() => { /* 還沒被使用者手勢解鎖就安靜放棄 */ });
  rampGain(volume, fadeMs / 1000);
}

export function stopBGM({ fadeMs = 700 } = {}) {
  bgmSrc = null;
  if (!bgm || bgm.paused) return;
  rampGain(0, fadeMs / 1000);
  setTimeout(() => { bgm.pause(); bgm.currentTime = 0; }, fadeMs + 50);
}
