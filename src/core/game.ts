// 無限盤リバーシのルール本体。描画やDOMに依存しない純粋なロジック。
// 盤面は Map<"x,y", Color> で持ち、負を含む任意の整数座標を扱う。

export type Color = 'B' | 'W';

export interface Pos {
  x: number;
  y: number;
}

export interface Move extends Pos {
  /** 反転する相手石。方向ごと・置いた石に近い順に並ぶ */
  flips: Pos[];
}

export type GameEvent =
  | { type: 'move'; color: Color; x: number; y: number; flips: Pos[] }
  /** 手持ち石はあるが合法手がないためのパス */
  | { type: 'pass'; color: Color }
  /** 手持ち石を使い切ったため着手できない（パスとは別に数える） */
  | { type: 'outOfStones'; color: Color }
  | { type: 'end'; reason: EndReason; black: number; white: number; winner: Color | 'draw' };

export type EndReason = 'noLegalMoves' | 'allStonesUsed';

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export const STONES_PER_PLAYER = 32;
export const INITIAL_STONES_PER_PLAYER = 2;

export const DIRECTIONS: readonly Pos[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 1 },
];

export const key = (x: number, y: number): string => `${x},${y}`;

export const parseKey = (k: string): Pos => {
  const i = k.indexOf(',');
  return { x: Number(k.slice(0, i)), y: Number(k.slice(i + 1)) };
};

export const opponent = (c: Color): Color => (c === 'B' ? 'W' : 'B');

export interface GameOptions {
  /** 各プレイヤーがゲーム中に新しく置ける石の数（初期配置分を除く） */
  stock?: number;
  /** 初期配置。省略時は通常リバーシと同じ 2×2 */
  initial?: Array<[number, number, Color]>;
  first?: Color;
}

export const DEFAULT_INITIAL: Array<[number, number, Color]> = [
  [0, 0, 'W'],
  [1, 0, 'B'],
  [0, 1, 'B'],
  [1, 1, 'W'],
];

export class Game {
  readonly board = new Map<string, Color>();
  turn: Color;
  stock: Record<Color, number>;
  over = false;
  endReason: EndReason | null = null;
  moveCount = 0;
  passCount: Record<Color, number> = { B: 0, W: 0 };
  /** 石切れで手番を飛ばした回数 */
  outOfStonesSkips: Record<Color, number> = { B: 0, W: 0 };
  /** 初期配置を含め、これまで石が置かれた範囲 */
  bounds: Bounds;
  lastMove: Pos | null = null;
  readonly history: GameEvent[] = [];

  constructor(opts: GameOptions = {}) {
    const stock = opts.stock ?? STONES_PER_PLAYER - INITIAL_STONES_PER_PLAYER;
    this.stock = { B: stock, W: stock };
    this.turn = opts.first ?? 'B';
    const initial = opts.initial ?? DEFAULT_INITIAL;
    this.bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const [x, y, c] of initial) {
      this.board.set(key(x, y), c);
      this.extendBounds(x, y);
    }
    // 初期局面で手番側が打てない場合にも対応する
    this.resolveTurn(this.turn, this.history);
  }

  /** 局面の複製（探索・検証用） */
  clone(): Game {
    const g = Object.create(Game.prototype) as Game;
    Object.assign(g, this, {
      board: new Map(this.board),
      stock: { ...this.stock },
      passCount: { ...this.passCount },
      outOfStonesSkips: { ...this.outOfStonesSkips },
      bounds: { ...this.bounds },
      history: [...this.history],
    });
    return g;
  }

  get(x: number, y: number): Color | undefined {
    return this.board.get(key(x, y));
  }

  count(): Record<Color, number> {
    let b = 0;
    let w = 0;
    for (const c of this.board.values()) {
      if (c === 'B') b++;
      else w++;
    }
    return { B: b, W: w };
  }

  /** (x,y) に color を置いたときに反転する石。置けない場合は空配列 */
  flipsAt(x: number, y: number, color: Color): Pos[] {
    if (this.board.has(key(x, y))) return [];
    const opp = opponent(color);
    const result: Pos[] = [];
    for (const d of DIRECTIONS) {
      const line: Pos[] = [];
      let cx = x + d.x;
      let cy = y + d.y;
      // 石は有限個なので、空マスに当たった時点で必ず止まる
      while (this.board.get(key(cx, cy)) === opp) {
        line.push({ x: cx, y: cy });
        cx += d.x;
        cy += d.y;
      }
      if (line.length > 0 && this.board.get(key(cx, cy)) === color) result.push(...line);
    }
    return result;
  }

  /**
   * 合法手の一覧。合法手は必ず相手石に隣接する空マスなので、
   * 「相手石の8近傍にある空マス」だけを候補として調べる（無限盤全体は走査しない）。
   */
  legalMoves(color: Color = this.turn): Move[] {
    const opp = opponent(color);
    const seen = new Set<string>();
    const moves: Move[] = [];
    for (const [k, c] of this.board) {
      if (c !== opp) continue;
      const p = parseKey(k);
      for (const d of DIRECTIONS) {
        const nx = p.x + d.x;
        const ny = p.y + d.y;
        const nk = key(nx, ny);
        if (seen.has(nk) || this.board.has(nk)) continue;
        seen.add(nk);
        const flips = this.flipsAt(nx, ny, color);
        if (flips.length > 0) moves.push({ x: nx, y: ny, flips });
      }
    }
    return moves;
  }

  canMove(color: Color): boolean {
    return this.stock[color] > 0 && this.legalMoves(color).length > 0;
  }

  /**
   * 現在の手番で (x,y) に着手する。
   * 不正な手なら null。成功時はこの着手で発生したイベント（着手・パス・終了）を返す。
   */
  play(x: number, y: number): GameEvent[] | null {
    if (this.over || this.stock[this.turn] <= 0) return null;
    const color = this.turn;
    const flips = this.flipsAt(x, y, color);
    if (flips.length === 0) return null;

    this.board.set(key(x, y), color);
    for (const f of flips) this.board.set(key(f.x, f.y), color);
    this.stock[color]--;
    this.moveCount++;
    this.lastMove = { x, y };
    this.extendBounds(x, y);

    const events: GameEvent[] = [{ type: 'move', color, x, y, flips }];
    this.resolveTurn(opponent(color), events);
    this.history.push(...events);
    return events;
  }

  /** 次に打つべきプレイヤーを決める。どちらも打てなければ終局 */
  private resolveTurn(next: Color, events: GameEvent[]): void {
    if (this.stock.B <= 0 && this.stock.W <= 0) {
      this.finish('allStonesUsed', events);
      return;
    }
    if (this.canMove(next)) {
      this.turn = next;
      return;
    }
    const other = opponent(next);
    if (this.canMove(other)) {
      if (this.stock[next] <= 0) {
        this.outOfStonesSkips[next]++;
        events.push({ type: 'outOfStones', color: next });
      } else {
        this.passCount[next]++;
        events.push({ type: 'pass', color: next });
      }
      this.turn = other;
      return;
    }
    this.finish('noLegalMoves', events);
  }

  private finish(reason: EndReason, events: GameEvent[]): void {
    this.over = true;
    this.endReason = reason;
    const { B, W } = this.count();
    events.push({
      type: 'end',
      reason,
      black: B,
      white: W,
      winner: B > W ? 'B' : W > B ? 'W' : 'draw',
    });
  }

  winner(): Color | 'draw' | null {
    if (!this.over) return null;
    const { B, W } = this.count();
    return B > W ? 'B' : W > B ? 'W' : 'draw';
  }

  private extendBounds(x: number, y: number): void {
    const b = this.bounds;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
  }
}
