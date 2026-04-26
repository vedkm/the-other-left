// Tiny Web Audio synth — no asset loading, no Phaser dependency.
// All sounds are short and pleasant-ish; volume is conservative.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

function ensure(): AudioContext {
  if (ctx) return ctx;
  const C = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)!;
  ctx = new C();
  master = ctx.createGain();
  master.gain.value = 0.45;
  master.connect(ctx.destination);
  return ctx;
}

export function unlockAudio() {
  const c = ensure();
  if (c.state === "suspended") c.resume();
}

export function setMuted(v: boolean) {
  muted = v;
  if (master) master.gain.value = v ? 0 : 0.45;
}

export function isMuted() { return muted; }

function pulse(freq: number, dur: number, type: OscillatorType = "square", vol = 0.18, attack = 0.005) {
  if (muted) return;
  const c = ensure();
  if (c.state === "suspended") c.resume();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = c.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(vol, t + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(master!);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noiseBurst(dur: number, lowpass: number, vol = 0.35) {
  if (muted) return;
  const c = ensure();
  if (c.state === "suspended") c.resume();
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = lowpass;
  const gain = c.createGain();
  gain.gain.value = vol;
  src.connect(filter).connect(gain).connect(master!);
  src.start();
}

// Pentatonic scale (in Hz) — sounds good no matter where you stop.
// Used for the rising combo hits.
const COMBO_NOTES = [523, 587, 659, 784, 880, 988, 1175, 1319, 1568, 1760, 1976];

export const sfx = {
  engineTick(combo = 0) {
    // Engine pitch rises with combo — game literally sounds more frantic.
    const base = 85 + Math.min(combo, 12) * 7;
    pulse(base, 0.12, "sawtooth", 0.10);
  },
  turn()       { pulse(440, 0.05, "square",  0.08); },
  brake()      { pulse(320, 0.18, "sawtooth", 0.10); },
  crash() {
    noiseBurst(0.45, 1100, 0.5);
    setTimeout(() => pulse(110, 0.18, "sawtooth", 0.18), 30);
    setTimeout(() => pulse(70, 0.25, "sawtooth", 0.16), 80);
  },
  // Descending tone when a combo breaks — satisfyingly sad.
  miss(fromCombo = 0) {
    const start = COMBO_NOTES[Math.min(fromCombo, COMBO_NOTES.length - 1)] ?? 660;
    pulse(start,        0.10, "triangle", 0.14);
    setTimeout(() => pulse(start * 0.7, 0.10, "triangle", 0.13), 80);
    setTimeout(() => pulse(start * 0.5, 0.16, "triangle", 0.12), 160);
  },
  // Each combo level plays a HIGHER note — stacks into a major-scale build-up.
  comboHit(level = 1) {
    const idx = Math.max(0, Math.min(COMBO_NOTES.length - 1, level - 1));
    const freq = COMBO_NOTES[idx];
    pulse(freq, 0.18, "triangle", 0.18);
    // Bass thump on combo 4+ for extra weight.
    if (level >= 4) setTimeout(() => pulse(freq / 4, 0.14, "sine", 0.18), 20);
    // Sparkle on combo 7+ — tinkle on top.
    if (level >= 7) setTimeout(() => pulse(freq * 2, 0.10, "triangle", 0.14), 40);
  },
  step()       { pulse(540, 0.04, "triangle", 0.06); },
  win() {
    pulse(523, 0.18, "triangle", 0.15);
    setTimeout(() => pulse(659, 0.18, "triangle", 0.15), 130);
    setTimeout(() => pulse(784, 0.30, "triangle", 0.18), 260);
  },
  countdown() { pulse(660, 0.10, "triangle", 0.14); },
  go()        { pulse(990, 0.20, "triangle", 0.18); },
};

// First user gesture unlocks the AudioContext.
function attachUnlock() {
  const handler = () => {
    unlockAudio();
    window.removeEventListener("pointerdown", handler);
    window.removeEventListener("keydown", handler);
  };
  window.addEventListener("pointerdown", handler);
  window.addEventListener("keydown", handler);
}
attachUnlock();
