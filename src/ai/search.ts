// コンピュータの思考。DOM に依存しない（Web Worker・テスト・自動対局から使う）。
// ルールは core/game.ts と同じだが、探索を速くするため盤面を整数キーで持ち、
// 着手を「打つ・戻す」で差分更新する。

import type { Color } from '../core/game.ts';

export type Level = 'easy' | 'normal' | 'hard' | 'expert';

export interface LevelSpec {
  label: string;
  /** 読む手数の上限（0 はランダム） */
  maxDepth: number;
  /** 思考時間の上限（ミリ秒） */
  timeMs: number;
}

export const LEVELS: Record<Level, LevelSpec> = {
  easy: { label: 'かんたん', maxDepth: 0, timeMs: 0 },
  normal: { label: 'ふつう', maxDepth: 1, timeMs: 200 },
  hard: { label: 'つよい', maxDepth: 3, timeMs: 1000 },
  expert: { label: 'げきむず', maxDepth: 60, timeMs: 2000 },
};

export const LEVEL_ORDER: Level[] = ['easy', 'normal', 'hard', 'expert'];

/** 思考に渡す局面（Worker へ送れる形） */
export interface Position {
  stones: Array<[number, number, Color]>;
  stock: Record<Color, number>;
  turn: Color;
}

export interface SearchResult {
  x: number;
  y: number;
  /** 完了した読みの深さ */
  depth: number;
  nodes: number;
  ms: number;
  /** 手番側から見た評価値 */
  score: number;
  /** 最後まで読み切ったか */
  exact: boolean;
}

type Side = 1 | -1; // 1 = 黒, -1 = 白

// 座標 (x,y) を 1つの整数にする。x,y は ±32767 まで扱える（石は64個しかないので十分）
const OFF = 32768;
const W = 65536;
const enc = (x: number, y: number) => (x + OFF) * W + (y + OFF);
const decX = (k: number) => Math.floor(k / W) - OFF;
const decY = (k: number) => (k % W) - OFF;
const DIRS = [W, -W, 1, -1, W + 1, -W - 1, W - 1, -W + 1];

const WIN = 1_000_000;

class Timeout extends Error {}

export class SearchBoard {
  readonly cells = new Map<number, Side>();
  /** 黒石数 - 白石数 */
  diff = 0;
  stockB = 0;
  stockW = 0;
  nodes = 0;
  private readonly undo: Array<{ k: number; side: Side; flips: number[] }> = [];

  constructor(pos: Position) {
    for (const [x, y, c] of pos.stones) {
      const s: Side = c === 'B' ? 1 : -1;
      this.cells.set(enc(x, y), s);
      this.diff += s;
    }
    this.stockB = pos.stock.B;
    this.stockW = pos.stock.W;
  }

  stock(s: Side): number {
    return s === 1 ? this.stockB : this.stockW;
  }

  /** k に side が置いたときに返る石を out に追加し、その数を返す */
  flipsInto(k: number, side: Side, out: number[] | null): number {
    const cells = this.cells;
    let n = 0;
    for (const d of DIRS) {
      let c = k + d;
      let len = 0;
      while (cells.get(c) === -side) {
        c += d;
        len++;
      }
      if (len > 0 && cells.get(c) === side) {
        n += len;
        if (out) for (let i = 1; i <= len; i++) out.push(k + d * i);
      }
    }
    return n;
  }

  /** 合法手（キー）と返す石数。手持ちがなければ空 */
  moves(side: Side): Array<{ k: number; n: number }> {
    const res: Array<{ k: number; n: number }> = [];
    if (this.stock(side) <= 0) return res;
    const seen = new Set<number>();
    for (const [k, v] of this.cells) {
      if (v !== -side) continue;
      for (const d of DIRS) {
        const nk = k + d;
        if (seen.has(nk) || this.cells.has(nk)) continue;
        seen.add(nk);
        const n = this.flipsInto(nk, side, null);
        if (n > 0) res.push({ k: nk, n });
      }
    }
    return res;
  }

  hasMove(side: Side): boolean {
    if (this.stock(side) <= 0) return false;
    for (const [k, v] of this.cells) {
      if (v !== -side) continue;
      for (const d of DIRS) {
        const nk = k + d;
        if (!this.cells.has(nk) && this.flipsInto(nk, side, null) > 0) return true;
      }
    }
    return false;
  }

  make(k: number, side: Side): void {
    const flips: number[] = [];
    this.flipsInto(k, side, flips);
    this.cells.set(k, side);
    for (const f of flips) this.cells.set(f, side);
    this.diff += side * (1 + 2 * flips.length);
    if (side === 1) this.stockB--;
    else this.stockW--;
    this.undo.push({ k, side, flips });
  }

  unmake(): void {
    const u = this.undo.pop()!;
    this.cells.delete(u.k);
    for (const f of u.flips) this.cells.set(f, -u.side as Side);
    this.diff -= u.side * (1 + 2 * u.flips.length);
    if (u.side === 1) this.stockB++;
    else this.stockW++;
  }
}

/** 終局時の得点（side から見て）。勝敗を最優先し、次に石差 */
function finalScore(b: SearchBoard, side: Side): number {
  const d = b.diff * side;
  return d > 0 ? WIN + d : d < 0 ? -WIN + d : 0;
}

/** 評価関数の調整値（自動対局での比較用に外から変えられる） */
export const EVAL = {
  /**
   * 末端で手番側が次の1手で増やせる石差を、どれだけ見込むか（0〜1）。
   * 読みの深さの偶奇による偏りを減らす。自動対局で 0 より 0.5 の方が強かった
   */
  tempo: 0.5,
};

/**
 * 途中局面の評価（side から見て。side が次に打つ）。
 * 確定石がほぼない盤なので、基本は石差。
 */
function evaluate(b: SearchBoard, side: Side): number {
  let v = b.diff * side * 10;
  if (EVAL.tempo > 0) {
    let best = 0;
    for (const m of b.moves(side)) if (m.n > best) best = m.n;
    v += EVAL.tempo * (2 * best + 1) * 10;
  }
  return v;
}

interface Ctx {
  deadline: number;
  exactHit: boolean;
}

/** ネガマックス + アルファベータ。パスは深さを消費しない */
function negamax(b: SearchBoard, side: Side, depth: number, alpha: number, beta: number, ctx: Ctx): number {
  b.nodes++;
  if ((b.nodes & 1023) === 0 && performance.now() > ctx.deadline) throw new Timeout();
  if (b.stockB <= 0 && b.stockW <= 0) return finalScore(b, side);
  const moves = b.moves(side);
  if (moves.length === 0) {
    if (!b.hasMove(-side as Side)) return finalScore(b, side);
    return -negamax(b, -side as Side, depth, -beta, -alpha, ctx);
  }
  if (depth <= 0) {
    ctx.exactHit = false;
    return evaluate(b, side);
  }
  // 多く返す手から調べると枝刈りが効きやすい
  moves.sort((a, c) => c.n - a.n);
  let best = -Infinity;
  for (const m of moves) {
    b.make(m.k, side);
    const v = -negamax(b, -side as Side, depth - 1, -beta, -alpha, ctx);
    b.unmake();
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

export type Rng = () => number;

/** 局面から次の一手を選ぶ。合法手がなければ null */
export function chooseMove(pos: Position, level: Level, rng: Rng = Math.random, override?: Partial<LevelSpec>): SearchResult | null {
  const spec = { ...LEVELS[level], ...override };
  const start = performance.now();
  const b = new SearchBoard(pos);
  const side: Side = pos.turn === 'B' ? 1 : -1;
  const moves = b.moves(side);
  if (moves.length === 0) return null;
  const result = (k: number, depth: number, score: number, exact: boolean): SearchResult => ({
    x: decX(k),
    y: decY(k),
    depth,
    nodes: b.nodes,
    ms: performance.now() - start,
    score,
    exact,
  });

  if (spec.maxDepth <= 0) {
    const m = moves[Math.floor(rng() * moves.length)];
    return result(m.k, 0, 0, false);
  }

  // 反復深化。時間切れになったら、最後に読み終えた深さの最善手を使う
  const ctx: Ctx = { deadline: start + spec.timeMs, exactHit: true };
  let order = moves.sort((a, c) => c.n - a.n).map((m) => m.k);
  let bestK = order[0];
  let bestScore = -Infinity;
  let doneDepth = 0;
  let exact = false;
  for (let depth = 1; depth <= spec.maxDepth; depth++) {
    ctx.exactHit = true;
    const scores = new Map<number, number>();
    try {
      let alpha = -Infinity;
      for (const k of order) {
        b.make(k, side);
        // 同点の手を公平に比べるため、最善手と同じ値までは正確に求める（alpha - 1）
        const v = -negamax(b, -side as Side, depth - 1, -Infinity, -(alpha - 1), ctx);
        b.unmake();
        scores.set(k, v);
        if (v > alpha) alpha = v;
      }
    } catch (e) {
      if (!(e instanceof Timeout)) throw e;
      break;
    }
    order = [...order].sort((a, c) => scores.get(c)! - scores.get(a)!);
    bestScore = scores.get(order[0])!;
    // 同じ評価の手が複数あれば、ランダムに選ぶ（毎回同じ展開にならないように）
    const ties = order.filter((k) => scores.get(k) === bestScore);
    bestK = ties[Math.floor(rng() * ties.length)];
    doneDepth = depth;
    exact = ctx.exactHit;
    if (exact) break; // 最後まで読み切った
  }
  return result(bestK, doneDepth, bestScore, exact);
}
