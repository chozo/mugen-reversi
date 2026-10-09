#!/usr/bin/env node
// 告知動画の撮影と書き出し。台本は scenario.js、見た目は promo.css。
//
//   npm run promo                      全コマを撮って MP4 を書き出す
//   PROMO_EVERY=15 npm run promo       確認用: 15コマおきの静止画だけ撮り、一覧画像を作る（安全領域と時刻つき）
//   PROMO_ENCODE_ONLY=1 npm run promo  撮り直さずに、残っているコマと音声から書き出しだけやり直す
//   PROMO_URL=http://localhost:5173/   起動中の開発サーバーを撮る（未指定なら config.serveDir を内蔵サーバーで配信）
//
// このファイルはゲームごとに変えなくてよい。変えるのは scenario.js と promo.css。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../..');
const scenarioFile = path.resolve(here, process.env.PROMO_SCENARIO || 'scenario.js');
const scenario = await import(pathToFileURL(scenarioFile).href);
const config = withDefaults(scenario.config);

const EVERY = Number(process.env.PROMO_EVERY || 0);
const ENCODE_ONLY = process.env.PROMO_ENCODE_ONLY === '1';
const outDir = path.resolve(appRoot, config.outDir);
const workDir = path.join(outDir, 'work');
const framesDir = path.join(workDir, 'frames');
const previewDir = path.join(workDir, 'preview');
const outMp4 = path.join(outDir, `${config.slug}-promo.mp4`);
const outCover = path.join(outDir, `${config.slug}-promo-cover.jpg`);
const metaFile = path.join(workDir, 'meta.json');
const wavFile = path.join(workDir, 'audio.wav');

function withDefaults(c = {}) {
  if (!c.slug) throw new Error('scenario.js の config.slug を設定してください');
  if (!c.game?.width || !c.game?.height) throw new Error('scenario.js の config.game.width / height（ゲーム画面の CSS ピクセル）を設定してください');
  const portrait = (c.orientation ?? 'portrait') === 'portrait';
  return {
    outDir: '../video',
    serveDir: '.',
    gamePath: '/',
    gameQuery: 'promo=1',
    orientation: portrait ? 'portrait' : 'landscape',
    size: portrait ? { width: 540, height: 960 } : { width: 960, height: 540 },
    scale: 2,
    fps: 30,
    duration: [28, 32],
    jpegQuality: 92,
    music: { synth: { bpm: 128, gain: 0.3 } },
    input: { down: 'touchDown', move: 'touchMove', up: 'touchUp' },
    ...c,
    layout: { centerX: portrait ? 0.47 : 0.5, centerY: portrait ? 0.45 : 0.47, maxW: portrait ? 0.72 : 0.8, maxH: portrait ? 0.64 : 0.74, ...c.layout },
  };
}

const ff = (args, opts = {}) => {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-y', ...args], { encoding: 'utf8', maxBuffer: 1 << 26, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(r.stderr.slice(-3000));
    throw new Error(`ffmpeg が失敗しました: ${args.join(' ')}`);
  }
  return r.stderr;
};

// ---- 配信 ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm' };

function startServer(root) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(301, { Location: `${p}/` }).end(); return; }
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const STAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="promo.css"></head>
<body><div id="bg"></div><div id="camera"><div id="game-box"><iframe id="game" allow="autoplay"></iframe></div></div>
<div id="overlay"></div><div id="guides" hidden><div class="zone top"></div><div class="zone bottom"></div><div class="zone right"></div><div id="timecode"></div></div>
<script src="stage.js"></script></body></html>`;

// ---- 台本から使う操作 ----
function createDirector(page, { capture }) {
  const fps = config.fps;
  const pending = [];
  const handlers = new Map();
  const W = config.size.width;
  let frame = 0; // 撮ったコマ数（動画の時刻 = frame / fps）
  let speed = 1;
  let coverFrame = null;
  let shotCount = 0;
  let lastEvents = [];

  async function tick({ record = true } = {}) {
    const gameDt = speed / fps;
    const videoDt = record ? 1 / fps : 0;
    const res = await page.evaluate(([v, g, c]) => window.__stage.step(v, g, c), [videoDt, gameDt, record && capture]);
    lastEvents = res.events;
    for (const e of res.events) {
      const name = typeof e === 'string' ? e : e.type ?? e.name;
      for (const h of handlers.get(name) || []) await h(e);
      for (const h of handlers.get('*') || []) await h(e);
    }
    if (!record) return;
    const items = pending.splice(0);
    await page.evaluate((list) => { for (const it of list) window.__stage.add(it); window.__stage.render(); }, items);
    if (capture && (!EVERY || frame % EVERY === 0)) {
      const file = EVERY ? path.join(previewDir, `p${String(shotCount).padStart(4, '0')}.jpg`) : path.join(framesDir, `f${String(frame).padStart(5, '0')}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: config.jpegQuality });
      shotCount++;
    }
    frame++;
    if (frame % fps === 0) process.stdout.write(`\r  ${(frame / fps).toFixed(0)}秒 撮影`);
  }

  const p = {
    config,
    get time() { return frame / fps; },
    get frame() { return frame; },
    get events() { return lastEvents; },
    /** 動画の時刻で sec 秒すすめる（撮影する） */
    async wait(sec) { const n = Math.round(sec * fps); for (let i = 0; i < n; i++) await tick(); },
    /** 撮影せずにゲームだけ sec 秒（ゲーム時間）すすめる。準備や見せない区間の早送りに使う */
    async skip(sec) { const n = Math.round(sec * fps); const s = speed; speed = 1; for (let i = 0; i < n; i++) await tick({ record: false }); speed = s; },
    /** 条件を満たすまで撮影しながらすすめる。cond は (state) => boolean。max 秒で打ち切り */
    async until(cond, { max = 10, record = true } = {}) {
      for (let i = 0; i < max * fps; i++) {
        const st = await page.evaluate(() => window.__stage.state());
        if (cond(st, lastEvents)) return true;
        await tick({ record });
      }
      console.warn(`\n  until: ${max}秒以内に条件を満たしませんでした（${p.time.toFixed(2)}秒）`);
      return false;
    },
    /** ゲームの状態（__game.state() の戻り値） */
    state: () => page.evaluate(() => window.__stage.state()),
    /** __game のメソッドを呼ぶ。例: p.call('start') / p.call('audio.capture', true) */
    call: (name, ...args) => page.evaluate(([n, a]) => window.__stage.call(n, a), [name, args]),
    /** ゲームの window で任意の関数を実行（fn は文字列化されて送られる） */
    eval: (fn, arg) => page.evaluate(([src, a]) => { const w = document.getElementById('game').contentWindow; return w.eval(`(${src})`)(a, w); }, [fn.toString(), arg]),
    /** 乱数を固定する */
    seed: (n) => page.evaluate((s) => window.__stage.seed(s), n),
    /** ゲームの速さ（1=等速, 2=早送り, 0.3=スロー）。badge で表示も出す */
    speed(x, { badge } = {}) {
      speed = x;
      const text = badge === undefined ? (x > 1 ? `×${x} 早送り` : x < 1 ? 'スロー' : null) : badge;
      if (text) pending.push({ kind: 'badge', text, dur: Infinity, tag: 'speed' });
      if (x === 1) pending.push({ kind: '__clearBadge' });
    },
    /** 本物と同じ入口で押す・なぞる。points はゲームの座標 [[x,y], ...]、dur 秒かけて動かす */
    async tap(x, y, hold = 0.06) {
      await p.call(config.input.down, x, y); await p.wait(hold); await p.call(config.input.up, x, y);
    },
    async drag(points, dur = 0.3) {
      const n = Math.max(1, Math.round(dur * fps));
      await p.call(config.input.down, ...points[0]);
      for (let i = 1; i <= n; i++) {
        const u = (i / n) * (points.length - 1);
        const k = Math.min(points.length - 2, Math.floor(u));
        const f = u - k;
        const a = points[k], b = points[k + 1];
        await p.call(config.input.move, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
        await tick();
      }
      await p.call(config.input.up, ...points.at(-1));
    },
    /** ゲームの出来事に合わせて字幕などを出す。handler は (event) => void。'*' ですべて */
    on(type, handler) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(handler); },
    off(type) { handlers.delete(type); },
    // ---- 重ねる演出（次のコマから表示） ----
    caption: (text, o = {}) => pending.push({ kind: 'caption', text, dur: 1.6, ...o }),
    fx: (text, o = {}) => pending.push({ kind: 'fx', text, dur: 0.8, ...o }),
    flash: (o = {}) => pending.push({ kind: 'flash', dur: 0.25, ...o }),
    shake: (amount = 12, dur = 0.35) => pending.push({ kind: 'shake', amount, dur }),
    zoom: (scale, dur = 0.3, o = {}) => pending.push({ kind: 'zoom', scale, dur, ...o }),
    title({ title, sub, logo, dur = 2.5, variant = 'dim', background } = {}) {
      pending.push({ kind: 'card', variant, background, dur, html: cardHtml({ title, sub, logo }) });
    },
    endCard({ title, sub, cta = '今すぐ遊べる！', url = config.url, logo, dur = 3, background } = {}) {
      pending.push({ kind: 'card', variant: 'end', background, dur: dur + 1, fadeOut: 0.01, html: cardHtml({ title, sub, logo, cta, url }) });
    },
    /** 今のコマを表紙にする（未指定なら最後のコマ） */
    cover() { coverFrame = frame; },
    get coverFrame() { return coverFrame ?? Math.max(0, frame - 1); },
    width: W,
  };
  return p;
}

function esc(s) { return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function cardHtml({ title, sub, logo, cta, url }) {
  return `<div class="inner">${logo ? `<img class="logo" src="${esc(logo)}">` : ''}${title ? `<div class="title">${esc(title).replace(/\n/g, '<br>')}</div>` : ''}${sub ? `<div class="sub">${esc(sub).replace(/\n/g, '<br>')}</div>` : ''}${cta ? `<div class="cta">${esc(cta)}</div>` : ''}${url ? `<div class="url">${esc(url.replace(/^https?:\/\//, ''))}</div>` : ''}</div>`;
}

// ---- 撮影 ----
async function capture() {
  fs.rmSync(EVERY ? previewDir : framesDir, { recursive: true, force: true });
  fs.mkdirSync(EVERY ? previewDir : framesDir, { recursive: true });

  let server = null;
  let base = process.env.PROMO_URL;
  if (!base) {
    const root = path.resolve(appRoot, config.serveDir);
    if (!fs.existsSync(path.join(root, config.gamePath.replace(/^\//, ''), 'index.html')) && !fs.existsSync(path.join(root, 'index.html'))) {
      throw new Error(`${root} に index.html がありません。ビルドが必要なら先に npm run build を実行してください`);
    }
    server = await startServer(root);
    base = `http://127.0.0.1:${server.address().port}/`;
  }
  const origin = new URL(base).origin;
  const gameUrl = new URL(config.gamePath, base);
  if (config.gameQuery) gameUrl.search = config.gameQuery;

  const browser = await chromium.launch({
    channel: process.env.PROMO_CHROME_PATH ? undefined : 'chrome',
    executablePath: process.env.PROMO_CHROME_PATH,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--font-render-hinting=none', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: config.size, deviceScaleFactor: config.scale });
    page.on('pageerror', (e) => console.error('\n[page error]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('\n[console]', m.text()); });
    // ステージをゲームと同じオリジンに置く（iframe の中を触れるようにするため）
    await page.route(`${origin}/__promo/**`, (route) => {
      const name = new URL(route.request().url()).pathname.replace('/__promo/', '');
      if (name === 'stage.html') return route.fulfill({ contentType: 'text/html', body: STAGE_HTML });
      const file = path.join(here, name);
      if (!file.startsWith(here) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: MIME[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    });
    await page.goto(`${origin}/__promo/stage.html`);
    await page.evaluate((c) => window.__stage.init(c), { ...config, gameUrl: gameUrl.href, guides: !!EVERY });

    const p = createDirector(page, { capture: true });
    console.log(EVERY ? `確認用に ${EVERY} コマおきに撮影します` : '全コマを撮影します');
    await scenario.default(p);
    const duration = p.frame / config.fps;
    console.log(`\n  撮影終了: ${p.frame} コマ / ${duration.toFixed(2)} 秒`);
    const [lo, hi] = config.duration;
    if (duration < lo || duration > hi) console.warn(`  ⚠ 長さ ${duration.toFixed(2)} 秒が目安 ${lo}〜${hi} 秒の外です`);

    if (EVERY) return { preview: true, duration };

    const audio = await page.evaluate(([d, m]) => window.__stage.renderAudio(d, m), [duration, config.music]);
    fs.writeFileSync(wavFile, Buffer.from(audio.wav, 'base64'));
    console.log(`  効果音: ${audio.events} 回${audio.hasRender ? '' : '（__game.audio.render が無いため無音）'}${audio.failed ? `、うち ${audio.failed} 回は鳴らし直しに失敗` : ''}`);
    fs.writeFileSync(metaFile, JSON.stringify({ frames: p.frame, fps: config.fps, cover: p.coverFrame }, null, 2));
    return { preview: false, duration };
  } finally {
    await browser.close();
    server?.close();
  }
}

// ---- 書き出し ----
const TARGET_LUFS = -14;

function measure(file) {
  const s = ff(['-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { allowFail: true });
  const I = Number((s.match(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/) || [])[1]);
  const tp = Number((s.match(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/) || [])[1]);
  return { I, tp };
}

// 音楽を混ぜ、「軽く圧縮 → 音量を上げ下げ → 4倍で山を制限」の音量を変えながら繰り返して -14 LUFS に合わせる。
// loudnorm は効果音の鋭い山があると目標まで上がらないことがあるため使わない。
function mixAudio(meta) {
  const dur = meta.frames / meta.fps;
  const mixed = path.join(workDir, 'mixed.wav');
  const inputs = ['-i', wavFile];
  let pre = '[0:a]anull[src];';
  const file = config.music?.file && path.resolve(appRoot, config.music.file);
  if (file) {
    inputs.push('-stream_loop', '-1', '-i', file);
    pre = `[1:a]aresample=44100,aformat=channel_layouts=stereo,volume=${config.music.volume ?? 0.5},atrim=0:${dur}[bgm];[0:a][bgm]amix=inputs=2:duration=first:normalize=0[src];`;
  }
  let gain = 0;
  let m = null;
  for (let i = 0; i < 6; i++) {
    const af = `${pre}[src]acompressor=threshold=-20dB:ratio=3:attack=5:release=120,volume=${gain.toFixed(2)}dB,aresample=176400,alimiter=limit=0.75:attack=1:release=60:level=false,aresample=44100,aformat=channel_layouts=stereo,atrim=0:${dur}[a]`;
    ff([...inputs, '-filter_complex', af, '-map', '[a]', '-c:a', 'pcm_s16le', mixed]);
    m = measure(mixed);
    if (!Number.isFinite(m.I) || m.I < -70) { console.warn('  ⚠ 音がほぼ無音です'); break; }
    if (Math.abs(m.I - TARGET_LUFS) < 0.3) break;
    gain += Math.max(-12, Math.min(12, TARGET_LUFS - m.I));
  }
  console.log(`  音量の調整: ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB → ${m?.I} LUFS / 真のピーク ${m?.tp} dBTP`);
  return mixed;
}

function encode() {
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const mixed = mixAudio(meta);
  ff(['-framerate', String(meta.fps), '-i', path.join(framesDir, 'f%05d.jpg'), '-i', mixed, '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-r', String(meta.fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-shortest', '-movflags', '+faststart', outMp4]);
  fs.copyFileSync(path.join(framesDir, `f${String(meta.cover).padStart(5, '0')}.jpg`), outCover);
}

function check() {
  const info = ff(['-i', outMp4, '-f', 'null', '-'], { allowFail: true });
  const loud = ff(['-i', outMp4, '-af', 'ebur128=peak=true,volumedetect', '-f', 'null', '-'], { allowFail: true });
  const pick = (re, s) => (s.match(re) || [])[1];
  const dur = pick(/Duration: (\d+:\d+:[\d.]+)/, info);
  const vid = pick(/Video: ([^\n]+)/, info);
  const I = pick(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/, loud);
  const tp = pick(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/, loud);
  const maxv = pick(/max_volume: (-?[\d.]+) dB/, loud);
  const sheet = path.join(outDir, `${config.slug}-promo-sheet.jpg`);
  const thumbW = config.orientation === 'portrait' ? 216 : 384;
  ff(['-i', outMp4, '-vf', `fps=1/2,scale=${thumbW}:-1,tile=8x2:padding=4:color=white`, '-frames:v', '1', '-update', '1', sheet]);
  console.log('\n確認');
  console.log(`  長さ        ${dur}`);
  console.log(`  映像        ${vid}`);
  console.log(`  音量        ${I} LUFS（目標 -14）  真のピーク ${tp} dBTP（目標 -1〜-2）  max_volume ${maxv} dB（0 未満）`);
  const warn = [];
  if (I && Math.abs(Number(I) + 14) > 1) warn.push('音量が目標から 1 LU 以上ずれています');
  if (tp && Number(tp) > -1) warn.push('真のピークが -1 dBTP を超えています');
  if (maxv && Number(maxv) >= 0) warn.push('音割れの可能性があります（max_volume ≥ 0）');
  for (const w of warn) console.warn(`  ⚠ ${w}`);
  console.log(`\n出力\n  ${outMp4}\n  ${outCover}\n  ${sheet}（2秒おきの一覧。字幕の位置・読みやすさ・切れを確認）`);
}

fs.mkdirSync(workDir, { recursive: true });
if (ENCODE_ONLY) {
  if (!fs.existsSync(metaFile)) throw new Error('撮影済みのコマがありません。先に全コマを撮影してください');
  encode();
  check();
} else {
  const r = await capture();
  if (r.preview) {
    const sheet = path.join(outDir, `${config.slug}-promo-preview.jpg`);
    const n = fs.readdirSync(previewDir).length;
    const cols = 8;
    const thumbW = config.orientation === 'portrait' ? 216 : 384;
    ff(['-framerate', '1', '-i', path.join(previewDir, 'p%04d.jpg'), '-vf', `scale=${thumbW}:-1,tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=white`, '-frames:v', '1', '-update', '1', sheet]);
    console.log(`確認用の一覧: ${sheet}（${n} 枚。赤い領域はアプリの UI が重なる場所）`);
  } else {
    encode();
    check();
  }
}
