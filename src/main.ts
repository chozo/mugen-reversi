import './style.css';
import { CpuClient } from './ai/client.ts';
import { LEVEL_ORDER, LEVELS, type Level, type SearchResult } from './ai/search.ts';
import { levels, renderPreview, Sound, toWav } from './audio.ts';
import { CONFIG } from './config.ts';
import { Game, opponent, type Color, type GameEvent } from './core/game.ts';
import { Camera } from './view/camera.ts';
import { attachInput } from './view/input.ts';
import { Renderer, type PlayAnim, type Scene } from './view/renderer.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('board');
const hud = document.querySelector<HTMLElement>('.hud')!;
const controls = document.querySelector<HTMLElement>('.controls')!;

const cam = new Camera();
const renderer = new Renderer(canvas, cam);

let game = new Game();
let legal = game.legalMoves();
let anim: PlayAnim | null = null;
let hover: { x: number; y: number } | null = null;
/** 演出速度の倍率（自動テスト用） */
let animSpeed = 1;
let pendingResult = false;
let renderQueued = false;

/** 対戦設定（コンピュータの強さと、人が持つ石の色） */
interface Mode {
  cpu: Level;
  human: Color;
}
let mode: Mode = { cpu: 'normal', human: 'B' };
const cpu = new CpuClient();
const sound = new Sound();
let cpuThinking = false;
let lastThink: SearchResult | null = null;
/** 新しい対局を始めるたびに増やし、古い対局の思考結果を捨てる */
let gameId = 0;
/** 一度でも対局を始めたか（対戦設定のキャンセルで戻る先があるか） */
let started = false;

const isCpu = (c: Color) => c !== mode.human;
/** 画面に出す呼び名 */
const who = (c: Color) => (isCpu(c) ? 'CPU' : 'あなた');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 描画 ----------

function scene(): Scene {
  return {
    board: game.board,
    turn: game.turn,
    legal,
    showLegal: !game.over && !anim && !isCpu(game.turn),
    lastMove: game.lastMove,
    hover,
    anim,
    bounds: game.bounds,
  };
}

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(frame);
}

function frame(now: number) {
  renderQueued = false;
  const camMoving = cam.step(now);
  if (anim && now >= anim.end) {
    anim = null;
    if (pendingResult) {
      pendingResult = false;
      showResult();
    }
  }
  // 描画で例外が起きてもアニメーションが止まらないよう、次のフレームを先に予約する
  if (camMoving || anim) requestRender();
  renderer.draw(scene(), now);
}

function insets() {
  return {
    top: hud.getBoundingClientRect().bottom + 8,
    bottom: cam.height - controls.getBoundingClientRect().top + 8,
  };
}

function resize() {
  renderer.resize(window.innerWidth, window.innerHeight);
  renderer.insetTop = hud.getBoundingClientRect().bottom;
  requestRender();
}

/** 初期表示：中央の4石とその周囲が見える状態 */
function resetCamera() {
  const n = CONFIG.view.initialVisibleCells;
  const pad = (n - 2) / 2;
  const { top, bottom } = insets();
  cam.fit(-pad + CONFIG.view.fitPaddingCells, -pad + CONFIG.view.fitPaddingCells, 2 + pad - CONFIG.view.fitPaddingCells, 2 + pad - CONFIG.view.fitPaddingCells, { top, bottom }, false);
}

/** 盤上の全ての石と合法手が収まるように表示する */
function fitAll() {
  const b = game.bounds;
  let { minX, minY } = b;
  let maxX = b.maxX + 1;
  let maxY = b.maxY + 1;
  for (const m of legal) {
    minX = Math.min(minX, m.x);
    minY = Math.min(minY, m.y);
    maxX = Math.max(maxX, m.x + 1);
    maxY = Math.max(maxY, m.y + 1);
  }
  cam.fit(minX, minY, maxX, maxY, insets(), true);
  requestRender();
}

// ---------- 着手 ----------

function tryPlay(x: number, y: number, byCpu = false): boolean {
  if (game.over || anim) return false;
  if (!byCpu && (cpuThinking || isCpu(game.turn))) return false;
  const color = game.turn;
  const before = new Map(game.board);
  const events = game.play(x, y);
  if (!events) return false;
  const move = events[0] as Extract<GameEvent, { type: 'move' }>;
  startAnim(color, move, before);
  legal = game.over ? [] : game.legalMoves();
  hover = null;
  for (const e of events) handleEvent(e);
  updateHud();
  requestRender();
  void cpuTurn();
  return true;
}

/** CPU の手番なら考えて打つ。パスで CPU が続けて打つ場合も、打った後にもう一度呼ばれる */
async function cpuTurn() {
  if (game.over || !isCpu(game.turn) || cpuThinking) return;
  const id = gameId;
  cpuThinking = true;
  updateHud();
  const started = performance.now();
  const res = await cpu.think(game, mode.cpu);
  if (id !== gameId) return;
  // すぐ打つと何が起きたか分からないので、最低限の間を置き、直前の反転が終わるのを待つ
  await sleep(Math.max(0, CONFIG.cpu.minThinkMs / animSpeed - (performance.now() - started)));
  while (anim && id === gameId) await sleep(20);
  if (id !== gameId) return;
  cpuThinking = false;
  if (!res) {
    updateHud();
    return;
  }
  lastThink = res;
  tryPlay(res.x, res.y, true);
}

function startAnim(color: Color, move: Extract<GameEvent, { type: 'move' }>, before: Map<string, Color>) {
  const a = CONFIG.anim;
  const flips = move.flips.map((f) => {
    // 置いた石に近いものから順に裏返る
    const d = Math.max(Math.abs(f.x - move.x), Math.abs(f.y - move.y));
    return { x: f.x, y: f.y, from: before.get(`${f.x},${f.y}`)!, to: color, delay: a.flipStartMs + (d - 1) * a.flipStepMs };
  });
  const last = flips.reduce((m, f) => Math.max(m, f.delay), 0);
  const start = performance.now();
  sound.place(color === 'B' ? 1 : 1.12);
  // 同じ距離の石は同時に裏返るので、距離ごとに1回、色が変わる瞬間に鳴らす
  const byDelay = new Map<number, number>();
  for (const f of flips) byDelay.set(f.delay, (byDelay.get(f.delay) ?? 0) + 1);
  [...byDelay.keys()]
    .sort((p, q) => p - q)
    .forEach((delay, step) => sound.flip(step, byDelay.get(delay)!, (delay + a.flipDurMs / 2) / animSpeed / 1000));
  anim = {
    start,
    speed: animSpeed,
    placed: { x: move.x, y: move.y, color },
    flips,
    end: start + (last + a.flipDurMs) / animSpeed,
  };
}

function handleEvent(e: GameEvent) {
  switch (e.type) {
    case 'pass':
      toast(`${who(e.color)}は置ける場所がないのでパス。${who(opponent(e.color))}が続けて打ちます`);
      break;
    case 'outOfStones':
      toast(`${who(e.color)}は手持ちの石を使い切りました。${who(opponent(e.color))}が続けて打ちます`);
      break;
    case 'end':
      pendingResult = true;
      break;
  }
}

// ---------- UI ----------

let toastTimer = 0;
function toast(msg: string, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

function resultText() {
  const c = game.count();
  const w = game.winner();
  return {
    title: w === 'draw' ? '引き分け' : `${who(w!)}の勝ち`,
    score: `黒 ${c.B} - ${c.W} 白`,
    reason: game.endReason === 'allStonesUsed' ? '双方が石を使い切りました' : 'どちらも置ける場所がなくなりました',
  };
}

function showResult() {
  const r = resultText();
  $('result-title').textContent = r.title;
  $('result-score').textContent = r.score;
  $('result-reason').textContent = r.reason;
  $('result').hidden = false;
}

function updateHud() {
  const c = game.count();
  for (const p of ['B', 'W'] as Color[]) {
    $(`count-${p}`).textContent = String(c[p]);
    $(`stock-${p}`).textContent = String(game.stock[p]);
    $(`player-${p}`).classList.toggle('active', !game.over && game.turn === p);
    $(`who-${p}`).textContent = isCpu(p) ? `CPU・${LEVELS[mode.cpu].label}` : who(p);
  }
  const turn = $('turn');
  turn.classList.toggle('white', !game.over && game.turn === 'W');
  turn.classList.toggle('over', game.over);
  turn.classList.toggle('thinking', !game.over && isCpu(game.turn));
  turn.textContent = game.over ? `終局 ${resultText().title}` : isCpu(game.turn) ? 'CPU 考え中…' : `${who(game.turn)}の番`;
}

function newGame(next: Mode = mode) {
  started = true;
  gameId++;
  cpu.cancel();
  cpuThinking = false;
  lastThink = null;
  mode = next;
  game = new Game();
  legal = game.legalMoves();
  anim = null;
  hover = null;
  pendingResult = false;
  $('result').hidden = true;
  $('setup').hidden = true;
  resetCamera();
  updateHud();
  requestRender();
  void cpuTurn();
}

// ---------- 対戦設定 ----------

const draft: Mode = { ...mode };

function renderSetup() {
  const mark = (groupId: string, value: string) => {
    for (const b of $(groupId).querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.v === value));
  };
  mark('opt-level', draft.cpu);
  mark('opt-color', draft.human);
}

/** 対戦設定を開く。cancelable が false（起動直後）ならキャンセルできない */
function openSetup(cancelable = started) {
  Object.assign(draft, mode);
  $('btn-setup-cancel').hidden = !cancelable;
  $('title').hidden = true;
  $('result').hidden = true;
  renderSetup();
  $('setup').hidden = false;
}

function bindOptions<T extends string>(groupId: string, set: (v: T) => void) {
  $(groupId).addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]');
    if (!b) return;
    set(b.dataset.v as T);
    renderSetup();
  });
}

$('opt-level').innerHTML = LEVEL_ORDER.map((l) => `<button type="button" data-v="${l}">${LEVELS[l].label}</button>`).join('');
bindOptions<Level>('opt-level', (v) => (draft.cpu = v));
bindOptions<Color>('opt-color', (v) => (draft.human = v));
function toggleSound() {
  sound.unlock();
  sound.setEnabled(!sound.enabled);
  updateSoundButton();
}

function updateSoundButton() {
  const b = $('btn-sound');
  b.textContent = sound.enabled ? '音 ON' : '音 OFF';
  b.setAttribute('aria-pressed', String(sound.enabled));
}

$('btn-start').addEventListener('click', () => {
  // ブラウザは操作なしで音を出せないので、「はじめる」のタップで音を有効にして BGM を始める
  sound.unlock();
  sound.startBgm();
  newGame({ ...draft });
});
$('btn-setup-cancel').addEventListener('click', () => ($('setup').hidden = true));
$('btn-howto').addEventListener('click', showTitle);
// 「あそぶ」は説明の上と下の2か所にある
$('btn-play-top').addEventListener('click', () => openSetup());
$('btn-play').addEventListener('click', () => openSetup());

/** タイトル画面（このオセロの特徴と操作方法） */
function showTitle() {
  $('setup').hidden = true;
  $('result').hidden = true;
  const t = $('title');
  t.hidden = false;
  t.scrollTop = 0;
}

// ---------- 入力 ----------

attachInput(canvas, cam, {
  onTap(sx, sy) {
    const mm = renderer.minimapHit(sx, sy, scene());
    if (mm) {
      cam.centerOn(mm[0], mm[1]);
      requestRender();
      return;
    }
    const [x, y] = cam.cellAt(sx, sy);
    if (tryPlay(x, y) || game.over || anim) return;
    if (isCpu(game.turn)) toast('コンピュータが考えています', 1200);
    else if (!game.get(x, y)) toast('そこには置けません', 1200);
  },
  onHover(sx, sy) {
    const [x, y] = cam.cellAt(sx, sy);
    const h = legal.find((m) => m.x === x && m.y === y) ? { x, y } : null;
    if (h?.x !== hover?.x || h?.y !== hover?.y) {
      hover = h;
      requestRender();
    }
  },
  onHoverEnd() {
    hover = null;
    requestRender();
  },
  onCameraChange() {
    requestRender();
  },
});

$('btn-new').addEventListener('click', () => openSetup());
$('btn-new-result').addEventListener('click', () => openSetup());
$('btn-close-result').addEventListener('click', () => ($('result').hidden = true));
$('btn-fit').addEventListener('click', fitAll);
$('btn-sound').addEventListener('click', toggleSound);

window.addEventListener('keydown', (e) => {
  const step = CONFIG.input.keyPanPx;
  if (!$('setup').hidden || !$('title').hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'f') fitAll();
  else if (k === 'm') toggleSound();
  else if (k === 'arrowleft') cam.pan(step, 0);
  else if (k === 'arrowright') cam.pan(-step, 0);
  else if (k === 'arrowup') cam.pan(0, step);
  else if (k === 'arrowdown') cam.pan(0, -step);
  else if (k === '+' || k === '=') cam.zoomAt(cam.width / 2, cam.height / 2, 1.2);
  else if (k === '-') cam.zoomAt(cam.width / 2, cam.height / 2, 1 / 1.2);
  else return;
  requestRender();
});

window.addEventListener('resize', resize);

// ---------- 自動テスト用の入口 ----------

declare global {
  interface Window {
    __game: unknown;
  }
}

window.__game = {
  get game() {
    return game;
  },
  get legal() {
    return legal.map((m) => ({ x: m.x, y: m.y, flips: m.flips.length }));
  },
  get animating() {
    return anim !== null;
  },
  get cpuThinking() {
    return cpuThinking;
  },
  get mode() {
    return mode;
  },
  camera: cam,
  play: (x: number, y: number) => tryPlay(x, y),
  /** 画面上の位置に合法手があればその座標（タップ検証用） */
  cellToScreen: (x: number, y: number) => cam.toScreen(x + 0.5, y + 0.5),
  setAnimSpeed: (s: number) => (animSpeed = s),
  newGame: (m?: Mode) => newGame(m),
  openSetup,
  fitAll,
  get audio() {
    return sound.state;
  },
  /** 音量確認用：BGM（と効果音）を書き出し、音量と WAV（base64）を返す */
  async renderAudio(seconds: number, withSe: boolean) {
    const buf = await renderPreview(seconds, withSe);
    const bytes = toWav(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { ...levels(buf, 2), wav: btoa(bin) };
  },
  state: () => ({
    turn: game.turn,
    over: game.over,
    moveCount: game.moveCount,
    count: game.count(),
    stock: { ...game.stock },
    passCount: { ...game.passCount },
    winner: game.winner(),
    endReason: game.endReason,
    legal: legal.length,
    resultShown: !$('result').hidden,
    setupShown: !$('setup').hidden,
    titleShown: !$('title').hidden,
    cpuThinking,
    lastThink,
    audio: sound.state,
  }),
};

resize();
resetCamera();
updateHud();
updateSoundButton();
requestRender();
showTitle();
