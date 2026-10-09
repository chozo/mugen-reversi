// 告知動画の撮影用ステージ（ブラウザ側）。record.mjs が読み込む。
// ゲームは iframe に入れ、字幕・効果文字・フラッシュ・ズームなどを親ページに重ねる。
// アニメーションはすべて仮想時刻 t（秒）から計算する。CSS アニメーションは使わない（実時間で動いてしまうため）。
(() => {
  const $ = (sel) => document.querySelector(sel);
  const items = []; // 画面に重ねる要素 { kind, start, dur, el, ... }
  const camera = { from: 1, to: 1, start: 0, dur: 0, ox: 0.5, oy: 0.5 };
  const shakes = [];
  let cfg = null;
  let win = null; // ゲームの window
  let videoTime = 0;
  let speed = 1;
  let audioEvents = [];
  let seedState = 0;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
  const easeInOut = (x) => { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  // 0→1 で 0.6 → 1.15 → 1 と弾む拡大率
  const pop = (x) => {
    x = clamp(x, 0, 1);
    if (x < 0.6) return 0.6 + 0.55 * easeOut(x / 0.6);
    return 1.15 - 0.15 * easeInOut((x - 0.6) / 0.4);
  };

  function layoutGame() {
    const { width: W, height: H } = cfg.size;
    const g = cfg.game;
    const L = cfg.layout;
    const scale = Math.min((W * L.maxW) / g.width, (H * L.maxH) / g.height);
    const w = g.width * scale;
    const h = g.height * scale;
    const box = $('#game-box');
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    box.style.left = `${W * L.centerX - w / 2}px`;
    box.style.top = `${H * L.centerY - h / 2}px`;
    const frame = $('#game');
    frame.style.width = `${g.width}px`;
    frame.style.height = `${g.height}px`;
    frame.style.transform = `scale(${scale})`;
  }

  async function init(config) {
    cfg = config;
    document.documentElement.style.setProperty('--W', `${cfg.size.width}px`);
    document.documentElement.style.setProperty('--H', `${cfg.size.height}px`);
    if (cfg.background) $('#bg').style.background = cfg.background;
    if (cfg.guides) $('#guides').hidden = false;
    layoutGame();
    const frame = $('#game');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ゲームの読み込みが20秒以内に終わりませんでした')), 20000);
      frame.addEventListener('load', () => { clearTimeout(timer); resolve(); }, { once: true });
      frame.src = cfg.gameUrl;
    });
    win = frame.contentWindow;
    const t0 = Date.now();
    while (!win.__game) {
      if (Date.now() - t0 > 20000) throw new Error('window.__game が見つかりません（references/game-hooks.md を参照）');
      await new Promise((r) => setTimeout(r, 50));
    }
    if (win.document.fonts) await win.document.fonts.ready;
    if (document.fonts) await document.fonts.ready;
    win.__game.manual?.(true);
    win.__game.audio?.capture?.(true);
    return true;
  }

  // 乱数の固定。ゲームが Math.random を呼ぶたびに参照していれば効く。
  function seed(n) {
    seedState = n >>> 0;
    win.Math.random = () => {
      seedState = (seedState + 0x6d2b79f5) >>> 0;
      let t = seedState;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // iframe 内の CSS アニメーション・トランジションを仮想時刻で進める
  function advanceCssAnimations(dtMs) {
    const doc = win.document;
    if (!doc.getAnimations) return;
    for (const a of doc.getAnimations()) {
      if (!a.__promo) { a.__promo = true; a.pause(); }
      a.currentTime = (Number(a.currentTime) || 0) + dtMs;
    }
  }

  // 1コマ進める。ゲームの出来事と効果音の呼び出しを返す。
  function step(videoDt, gameDt, capture) {
    videoTime += videoDt;
    const events = [];
    if (gameDt > 0) {
      // 大きな dt はゲーム側が壊れないよう 1/60 秒ずつに分ける
      let rest = gameDt;
      while (rest > 1e-9) {
        const d = Math.min(rest, 1 / 60);
        win.__game.step(d);
        advanceCssAnimations(d * 1000);
        rest -= d;
      }
    }
    const ev = win.__game.drainEvents?.() || [];
    for (const e of ev) events.push(e);
    const calls = win.__game.audio?.drain?.() || [];
    if (capture) for (const c of calls) audioEvents.push({ t: videoTime, name: c.name, args: c.args || [] });
    return { t: videoTime, events };
  }

  function call(name, args) {
    const fn = name.split('.').reduce((o, k) => (o == null ? o : o[k]), win.__game);
    if (typeof fn !== 'function') throw new Error(`__game.${name} は関数ではありません`);
    const owner = name.includes('.') ? name.split('.').slice(0, -1).reduce((o, k) => o[k], win.__game) : win.__game;
    return fn.apply(owner, args);
  }

  function state() { return win.__game.state?.() ?? null; }

  // ---- 重ねる要素 ----
  function makeText(cls, text, opt) {
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = String(text).split('\n').map((s) => `<span>${s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span>`).join('');
    if (opt.size) el.style.fontSize = `${opt.size}px`;
    if (opt.color) el.style.color = opt.color;
    if (opt.stroke) el.style.setProperty('--stroke', opt.stroke);
    if (opt.className) el.classList.add(...opt.className.split(' '));
    $('#overlay').appendChild(el);
    return el;
  }

  function add(item) {
    const it = { ...item, start: item.start ?? videoTime };
    const H = cfg.size.height;
    const W = cfg.size.width;
    if (it.kind === 'caption') {
      it.el = makeText('caption', it.text, it);
      it.el.style.top = `${(it.y ?? 0.17) * H}px`;
    } else if (it.kind === 'fx') {
      it.el = makeText('fx', it.text, it);
      it.el.style.left = `${(it.x ?? 0.45) * W}px`;
      it.el.style.top = `${(it.y ?? 0.42) * H}px`;
      it.rot = it.rot ?? (((items.length * 37) % 17) - 8);
    } else if (it.kind === 'badge' || it.kind === '__clearBadge') {
      // 表示中の早送り・スロー表示は消してから出す
      for (const b of items) if (b.kind === 'badge') b.dur = Math.min(b.dur, videoTime - b.start + 0.15);
      if (it.kind === '__clearBadge') return;
      it.el = makeText('badge', it.text, it);
    } else if (it.kind === 'flash') {
      it.el = document.createElement('div');
      it.el.className = 'flash';
      if (it.color) it.el.style.background = it.color;
      $('#overlay').appendChild(it.el);
    } else if (it.kind === 'card') {
      it.el = document.createElement('div');
      it.el.className = `card ${it.variant || ''}`;
      if (it.background) it.el.style.background = it.background;
      it.el.innerHTML = it.html;
      $('#overlay').appendChild(it.el);
    } else if (it.kind === 'shake') {
      shakes.push(it);
      return;
    } else if (it.kind === 'zoom') {
      const cur = cameraScale(videoTime);
      Object.assign(camera, { from: cur, to: it.scale, start: it.start, dur: it.dur ?? 0.3, ox: it.x ?? camera.ox, oy: it.y ?? camera.oy });
      return;
    } else {
      throw new Error(`未知の要素: ${it.kind}`);
    }
    it.el.style.opacity = '0';
    items.push(it);
  }

  function cameraScale(t) {
    const x = camera.dur > 0 ? (t - camera.start) / camera.dur : 1;
    return camera.from + (camera.to - camera.from) * easeInOut(x);
  }

  function render() {
    const t = videoTime;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const local = t - it.start;
      const dur = it.dur ?? Infinity;
      const out = it.fadeOut ?? 0.15;
      if (local < 0) { it.el.style.opacity = '0'; continue; }
      if (local > dur) { it.el.remove(); items.splice(i, 1); continue; }
      const fadeOut = dur === Infinity ? 1 : clamp((dur - local) / out, 0, 1);
      if (it.kind === 'caption') {
        const s = pop(local / 0.22);
        it.el.style.opacity = String(clamp(local / 0.06, 0, 1) * fadeOut);
        it.el.style.transform = `translateX(-50%) scale(${s})`;
      } else if (it.kind === 'fx') {
        const s = pop(local / 0.18) * (1 + 0.04 * Math.sin(local * 18) * Math.exp(-local * 3));
        it.el.style.opacity = String(clamp(local / 0.04, 0, 1) * fadeOut);
        it.el.style.transform = `translate(-50%, -50%) rotate(${it.rot}deg) scale(${s * (1 + (1 - fadeOut) * 0.3)})`;
      } else if (it.kind === 'badge') {
        it.el.style.opacity = String(clamp(local / 0.1, 0, 1) * fadeOut);
        it.el.style.transform = `scale(${pop(local / 0.2)})`;
      } else if (it.kind === 'flash') {
        it.el.style.opacity = String((it.strength ?? 0.9) * (1 - easeOut(local / dur)));
      } else if (it.kind === 'card') {
        const fin = it.fadeIn ?? 0.25;
        it.el.style.opacity = String(clamp(local / fin, 0, 1) * fadeOut);
        const inner = it.el.firstElementChild;
        if (inner) inner.style.transform = `scale(${pop(local / 0.35)})`;
      }
    }
    // カメラ（ズームと揺れ）
    let dx = 0, dy = 0;
    for (let i = shakes.length - 1; i >= 0; i--) {
      const s = shakes[i];
      const local = t - s.start;
      if (local > s.dur) { shakes.splice(i, 1); continue; }
      if (local < 0) continue;
      const amp = (s.amount ?? 12) * (1 - local / s.dur);
      dx += amp * Math.sin(local * 71.3 + 1.7);
      dy += amp * Math.sin(local * 53.9 + 4.1);
    }
    const sc = cameraScale(t);
    const cam = $('#camera');
    cam.style.transformOrigin = `${camera.ox * 100}% ${camera.oy * 100}%`;
    cam.style.transform = `translate(${dx}px, ${dy}px) scale(${sc})`;
    if (cfg.guides) $('#timecode').textContent = `${t.toFixed(2)}s`;
  }

  function setSpeed(x) { speed = x; }

  // ---- 音の書き出し ----
  function synthMusic(ctx, music, duration) {
    const bpm = music.bpm ?? 128;
    const beat = 60 / bpm;
    const gain = ctx.createGain();
    gain.gain.value = music.gain ?? 0.35;
    gain.connect(ctx.destination);
    const start = music.start ?? 0;
    const end = Math.min(duration, music.end ?? duration);
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.2, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    let s = 12345;
    for (let i = 0; i < nd.length; i++) { s = (s * 1103515245 + 12345) >>> 0; nd[i] = (s / 2147483648) - 1; }
    const kick = (t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(g).connect(gain); o.start(t); o.stop(t + 0.3);
    };
    const hat = (t, v) => {
      const src = ctx.createBufferSource(); src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
      const g = ctx.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      src.connect(f).connect(g).connect(gain); src.start(t); src.stop(t + 0.06);
    };
    const bass = (t, freq) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + beat * 0.45);
      o.connect(f).connect(g).connect(gain); o.start(t); o.stop(t + beat * 0.5);
    };
    const roots = music.roots ?? [55, 55, 65.41, 49];
    for (let i = 0, t = start; t < end - 0.01; i++, t += beat) {
      kick(t);
      hat(t + beat / 2, 0.25);
      hat(t + beat / 4, 0.08); hat(t + (beat * 3) / 4, 0.08);
      bass(t + beat / 2, roots[Math.floor(i / 4) % roots.length]);
    }
  }

  function toWavBase64(buf) {
    const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
    data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
    w(36, 'data'); data.setUint32(40, len * ch * 2, true);
    const chans = [...Array(ch)].map((_, i) => buf.getChannelData(i));
    let o = 44;
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { data.setInt16(o, clamp(chans[c][i], -1, 1) * 0x7fff, true); o += 2; }
    const bytes = new Uint8Array(data.buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // 記録した効果音をゲームの関数で鳴らし直し、音楽を足して WAV にする
  async function renderAudio(duration, music) {
    const sr = 44100;
    const ctx = new win.OfflineAudioContext(2, Math.ceil(sr * duration), sr);
    let failed = 0;
    const render = win.__game.audio?.render;
    if (render) {
      for (const e of audioEvents) {
        if (e.t >= duration) continue;
        try { render.call(win.__game.audio, ctx, e.name, e.args, e.t); } catch { failed++; }
      }
    }
    if (music && music.synth) synthMusic(ctx, music.synth, duration);
    const buf = await ctx.startRendering();
    return { wav: toWavBase64(buf), events: audioEvents.length, failed, hasRender: !!render };
  }

  window.__stage = { init, seed, step, call, state, add, render, setSpeed, renderAudio, get time() { return videoTime; }, get speed() { return speed; } };
})();
