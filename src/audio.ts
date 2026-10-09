// BGM と効果音。音源ファイルは使わず Web Audio API で合成する。
// 合成関数は (ctx, 出力先, 時刻) を受け取る形にして、OfflineAudioContext でも同じ音を作れるようにしている。

import { CONFIG } from './config.ts';

type Ctx = BaseAudioContext;

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

// ---------- 効果音 ----------

const noiseCache = new WeakMap<Ctx, AudioBuffer>();
function noise(ctx: Ctx): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.1), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

/** 減衰する1音（アタックは短く、指数的に消える） */
function tone(ctx: Ctx, out: AudioNode, t: number, type: OscillatorType, freq: number, gain: number, decay: number, freqEnd?: number) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + decay * 0.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + decay + 0.02);
}

/** 石を置く音：木の駒を置いたような「コトッ」 */
export function playPlace(ctx: Ctx, out: AudioNode, t: number, pitch = 1) {
  tone(ctx, out, t, 'sine', 430 * pitch, 0.55, 0.16, 190 * pitch);
  tone(ctx, out, t, 'triangle', 1250 * pitch, 0.08, 0.05);
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2400 * pitch;
  bp.Q.value = 1.4;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.32, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  n.connect(bp).connect(g).connect(out);
  n.start(t);
  n.stop(t + 0.06);
}

// 返す石が遠くなるほど高くなる（ペンタトニック）
const FLIP_STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

/** 石が裏返る音：軽い「チッ」。step は置いた石からの距離の順、count は同時に返る数 */
export function playFlip(ctx: Ctx, out: AudioNode, t: number, step: number, count: number) {
  const f = midiHz(81 + FLIP_STEPS[Math.min(step, FLIP_STEPS.length - 1)]);
  const loud = Math.min(1, 0.65 + 0.12 * count);
  tone(ctx, out, t, 'triangle', f, 0.16 * loud, 0.09);
  tone(ctx, out, t, 'sine', f * 2, 0.05 * loud, 0.05);
}

// ---------- BGM ----------

/**
 * 明るいポップス。Cメジャー・116 BPM・16小節ループ（約33秒）。
 * メロディ（矩形波）・裏拍の和音・ベース・ドラム（キック／クラップ／ハイハット）。
 * 8分音符単位の「ステップ」で組み立て、ステップ番号から音を決めるので、どこからでも同じ曲を再生できる。
 */
const BPM = 116;
const STEP = 60 / BPM / 2;
const STEPS_PER_BAR = 8;

// 和音：ベースの根音と、和音の構成音
const CH: Record<string, { root: number; tones: number[] }> = {
  C: { root: 36, tones: [60, 64, 67] },
  G: { root: 43, tones: [59, 62, 67] },
  Am: { root: 45, tones: [57, 60, 64] },
  F: { root: 41, tones: [57, 60, 65] },
  Em: { root: 40, tones: [59, 64, 67] },
};
// A: C G Am F | C G F G   B: F G Em Am | F G C C
const PROGRESSION = ['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'G', 'F', 'G', 'Em', 'Am', 'F', 'G', 'C', 'C'];

// メロディ。1小節 = 8分音符8つ。数字は MIDI ノート、'-' は前の音を伸ばす、'.' は休符
const MELODY = [
  '76 - 79 - 76 74 72 -',
  '74 - 74 76 74 - 71 -',
  '72 - 76 - 81 - 79 76',
  '77 - 76 - 74 - - -',
  '76 - 79 - 76 74 72 -',
  '74 - 74 76 79 - 74 -',
  '72 - 69 - 72 74 76 77',
  '79 - - - 74 - 71 -',
  '81 - 81 79 77 - 76 -',
  '79 - 79 77 76 - 74 -',
  '76 - 79 - 83 - 81 79',
  '81 - - - 76 - 72 -',
  '77 - 76 77 81 - 79 -',
  '79 - 77 76 74 - 71 -',
  '72 - 76 - 79 - 84 -',
  '79 - - - . . . .',
].map((bar) => bar.split(' '));

const LOOP_STEPS = PROGRESSION.length * STEPS_PER_BAR;

export interface BgmBus {
  dry: AudioNode;
  /** 残響（ディレイ）に送る入力 */
  wet: AudioNode;
}

/** BGM 用の出力経路（ディレイ）を作る */
export function createBgmBus(ctx: Ctx, out: AudioNode): BgmBus {
  const dry = ctx.createGain();
  dry.connect(out);
  const wet = ctx.createGain();
  const delay = ctx.createDelay(2);
  delay.delayTime.value = STEP * 3;
  const fb = ctx.createGain();
  fb.gain.value = 0.3;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2500;
  const wetOut = ctx.createGain();
  wetOut.gain.value = 0.35;
  wet.connect(delay);
  delay.connect(lp).connect(fb).connect(delay);
  lp.connect(wetOut).connect(out);
  return { dry, wet };
}

/** フィルターと音量の包絡を付けた1音 */
function synth(
  ctx: Ctx,
  outs: AudioNode[],
  t: number,
  o: { type: OscillatorType; freq: number; gain: number; attack: number; hold: number; release: number; cutoff: number; detune?: number },
) {
  const osc = ctx.createOscillator();
  osc.type = o.type;
  osc.frequency.value = o.freq;
  if (o.detune) osc.detune.value = o.detune;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = o.cutoff;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + o.attack);
  g.gain.setValueAtTime(o.gain, t + o.attack + o.hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.attack + o.hold + o.release);
  osc.connect(lp).connect(g);
  for (const out of outs) g.connect(out);
  osc.start(t);
  osc.stop(t + o.attack + o.hold + o.release + 0.02);
}

function kick(ctx: Ctx, out: AudioNode, t: number) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.42, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.3);
}

function noiseHit(ctx: Ctx, out: AudioNode, t: number, type: BiquadFilterType, freq: number, gain: number, decay: number) {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  n.connect(f).connect(g).connect(out);
  n.start(t);
  n.stop(t + Math.min(decay + 0.01, 0.1));
}

function clap(ctx: Ctx, out: AudioNode, t: number) {
  // 少しずらして3回重ねると手拍子らしくなる
  for (const d of [0, 0.012, 0.024]) noiseHit(ctx, out, t + d, 'bandpass', 1600, 0.16, 0.09);
  tone(ctx, out, t, 'triangle', 220, 0.05, 0.06);
}

/** ステップ step の音を時刻 t に鳴らす予約をする */
export function scheduleBgmStep(ctx: Ctx, bus: BgmBus, step: number, t: number) {
  const s = step % LOOP_STEPS;
  const bar = Math.floor(s / STEPS_PER_BAR);
  const pos = s % STEPS_PER_BAR;
  const chord = CH[PROGRESSION[bar]];

  // ドラム：4つ打ちのキック、2・4拍のクラップ、8分のハイハット（裏拍を強く）
  if (pos % 2 === 0) kick(ctx, bus.dry, t);
  if (pos === 2 || pos === 6) clap(ctx, bus.dry, t);
  noiseHit(ctx, bus.dry, t, 'highpass', 7500, pos % 2 === 1 ? 0.07 : 0.035, 0.035);
  // 4小節ごとに、最後の拍でハイハットを細かく刻んでつなぎにする
  if (bar % 4 === 3 && pos >= 6) noiseHit(ctx, bus.dry, t + STEP / 2, 'highpass', 7500, 0.05, 0.03);

  // ベース：根音を中心に、オクターブと5度ではずむ
  const bassPattern: Array<number | null> = [0, null, 12, 0, 0, null, 7, 12];
  const bn = bassPattern[pos];
  if (bn !== null) {
    synth(ctx, [bus.dry], t, { type: 'sawtooth', freq: midiHz(chord.root + bn), gain: 0.11, attack: 0.005, hold: 0.06, release: 0.12, cutoff: 700 });
  }

  // 裏拍の和音（明るいスタッカート）
  if (pos % 2 === 1) {
    for (const m of chord.tones) {
      synth(ctx, [bus.dry], t, { type: 'square', freq: midiHz(m), gain: 0.022, attack: 0.004, hold: 0.03, release: 0.09, cutoff: 2600 });
    }
  }

  // メロディ
  const note = MELODY[bar][pos];
  if (note !== '-' && note !== '.') {
    let len = 1;
    while (pos + len < STEPS_PER_BAR && MELODY[bar][pos + len] === '-') len++;
    const f = midiHz(Number(note));
    const hold = Math.max(0.03, len * STEP - 0.08);
    synth(ctx, [bus.dry, bus.wet], t, { type: 'square', freq: f, gain: 0.05, attack: 0.008, hold, release: 0.08, cutoff: 3200 });
    // 1オクターブ上の三角波を薄く重ねて、きらっとさせる
    synth(ctx, [bus.dry], t, { type: 'triangle', freq: f * 2, gain: 0.018, attack: 0.008, hold, release: 0.08, cutoff: 6000 });
  }
}

// ---------- 再生の管理 ----------

/** 効果音の呼び出し（告知動画の撮影で記録し、書き出し時に鳴らし直す） */
export interface SfxCall {
  name: 'place' | 'flip' | 'bgm';
  args: number[];
}

/**
 * 記録した呼び出しを、渡された AudioContext の時刻 when に鳴らす（告知動画の書き出し用）。
 * 普段の再生と同じ合成関数・音量を使う。'bgm' は args = [音量, 秒数]
 */
export function renderSfx(ctx: BaseAudioContext, name: SfxCall['name'], args: number[], when: number): void {
  const out = ctx.createGain();
  out.connect(ctx.destination);
  if (name === 'bgm') {
    out.gain.value = args[0];
    const bus = createBgmBus(ctx, out);
    for (let step = 0, t = when; t < when + args[1]; step++, t += STEP) scheduleBgmStep(ctx, bus, step, t);
    return;
  }
  out.gain.value = CONFIG.audio.master * CONFIG.audio.se;
  if (name === 'place') playPlace(ctx, out, when, args[0]);
  else playFlip(ctx, out, when, args[0], args[1]);
}

export class Sound {
  ctx: AudioContext | null = null;
  enabled = true;
  /** true の間は鳴らさずに記録する（告知動画の撮影用） */
  capturing = false;
  captured: SfxCall[] = [];
  private master!: GainNode;
  private se!: GainNode;
  private bgmGain!: GainNode;
  private bus!: BgmBus;
  private bgmWanted = false;
  private bgmTimer = 0;
  private nextStep = 0;
  private nextTime = 0;

  /** ユーザー操作（クリック・タップ）の処理の中で呼ぶ。ブラウザの自動再生制限のため */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = this.enabled ? CONFIG.audio.master : 0;
      this.master.connect(comp);
      this.se = ctx.createGain();
      this.se.gain.value = CONFIG.audio.se;
      this.se.connect(this.master);
      this.bgmGain = ctx.createGain();
      this.bgmGain.gain.value = 0;
      this.bgmGain.connect(this.master);
      this.bus = createBgmBus(ctx, this.bgmGain);
      document.addEventListener('visibilitychange', () => this.syncRunning());
    }
    this.syncRunning();
  }

  /** 画面が隠れているときと OFF のときは止める */
  private syncRunning(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (document.hidden || !this.enabled) {
      if (ctx.state === 'running') void ctx.suspend();
    } else if (ctx.state !== 'running') {
      void ctx.resume();
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(on ? CONFIG.audio.master : 0, t, 0.05);
    if (on) {
      this.syncRunning();
      if (this.bgmWanted) this.startBgm();
    } else {
      this.stopScheduler();
      // フェードアウトしてから止める
      setTimeout(() => !this.enabled && this.syncRunning(), 200);
    }
  }

  startBgm(): void {
    this.bgmWanted = true;
    const ctx = this.ctx;
    if (!ctx || !this.enabled || this.bgmTimer) return;
    const t = ctx.currentTime;
    this.bgmGain.gain.cancelScheduledValues(t);
    this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value, t);
    this.bgmGain.gain.linearRampToValueAtTime(CONFIG.audio.bgm, t + 1.5);
    this.nextTime = t + 0.1;
    // 先読みして予約する（タイマーの遅れで音が途切れないように）
    const tick = () => {
      while (this.nextTime < ctx.currentTime + 0.3) {
        scheduleBgmStep(ctx, this.bus, this.nextStep, this.nextTime);
        this.nextStep++;
        this.nextTime += STEP;
      }
    };
    tick();
    this.bgmTimer = window.setInterval(tick, 60);
  }

  private stopScheduler(): void {
    clearInterval(this.bgmTimer);
    this.bgmTimer = 0;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.bgmGain.gain.cancelScheduledValues(t);
    this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value, t);
    this.bgmGain.gain.linearRampToValueAtTime(0, t + 0.3);
    // 次に始めるときは4小節の区切りから
    const phrase = STEPS_PER_BAR * 4;
    this.nextStep = Math.ceil(this.nextStep / phrase) * phrase;
  }

  private ready(): AudioContext | null {
    return this.ctx && this.enabled && this.ctx.state === 'running' ? this.ctx : null;
  }

  place(pitch = 1): void {
    if (this.capturing) {
      this.captured.push({ name: 'place', args: [pitch] });
      return;
    }
    const ctx = this.ready();
    if (ctx) playPlace(ctx, this.se, ctx.currentTime + 0.005, pitch);
  }

  /** 石が裏返る音（裏返る瞬間に呼ぶ） */
  flip(step: number, count: number): void {
    if (this.capturing) {
      this.captured.push({ name: 'flip', args: [step, count] });
      return;
    }
    const ctx = this.ready();
    if (ctx) playFlip(ctx, this.se, ctx.currentTime + 0.005, step, count);
  }

  /** 自動テスト用の状態 */
  get state() {
    return { enabled: this.enabled, context: this.ctx?.state ?? 'none', bgm: this.bgmTimer !== 0 };
  }
}

// ---------- 確認用の書き出し ----------

/**
 * BGM（と、指定すれば効果音）を OfflineAudioContext で書き出す。音量の確認と試聴用。
 * 実際の再生と同じ音量設定・コンプレッサーを通す。
 */
export async function renderPreview(seconds: number, withSe: boolean): Promise<AudioBuffer> {
  const sr = 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
  const comp = ctx.createDynamicsCompressor();
  comp.connect(ctx.destination);
  const master = ctx.createGain();
  master.gain.value = CONFIG.audio.master;
  master.connect(comp);
  const bgm = ctx.createGain();
  bgm.gain.value = CONFIG.audio.bgm;
  bgm.connect(master);
  const se = ctx.createGain();
  se.gain.value = CONFIG.audio.se;
  se.connect(master);
  const bus = createBgmBus(ctx, bgm);
  for (let step = 0, t = 0.05; t < seconds; step++, t += STEP) scheduleBgmStep(ctx, bus, step, t);
  if (withSe) {
    // 2秒ごとに「置く → 距離順に裏返る（各距離2個ずつ、5段）」
    for (let t = 1; t < seconds - 1; t += 2) {
      playPlace(ctx, se, t, (t | 0) % 4 === 1 ? 1 : 1.12);
      for (let s = 0; s < 5; s++) playFlip(ctx, se, t + (CONFIG.anim.flipStartMs + s * CONFIG.anim.flipStepMs + CONFIG.anim.flipDurMs / 2) / 1000, s, 2);
    }
  }
  return ctx.startRendering();
}

/** 音量の目安（ピークと RMS、dBFS） */
export function levels(buf: AudioBuffer, from = 0, to = buf.duration) {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = Math.floor(from * buf.sampleRate); i < Math.min(d.length, to * buf.sampleRate); i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
      sum += v * v;
      n++;
    }
  }
  const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, n))) };
}

/** 16bit WAV に変換（試聴ファイルの保存用） */
export function toWav(buf: AudioBuffer): Uint8Array {
  const ch = buf.numberOfChannels;
  const len = buf.length;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  out.setUint32(4, 36 + len * ch * 2, true);
  str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true);
  out.setUint32(28, buf.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  for (let i = 0; i < len; i++)
    for (let c = 0; c < ch; c++) out.setInt16(44 + (i * ch + c) * 2, Math.max(-1, Math.min(1, data[c][i])) * 0x7fff, true);
  return new Uint8Array(out.buffer);
}
