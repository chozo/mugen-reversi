import { describe, expect, it } from 'vitest';
import { DIRECTIONS, Game, key, type Color, type Pos } from '../src/core/game.ts';

/** 文字列の盤面（B/W/.）を、左上を (ox,oy) として配置したゲームを作る */
function fromAscii(rows: string[], ox = 0, oy = 0, first: Color = 'B', stock = 30): Game {
  const initial: Array<[number, number, Color]> = [];
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === 'B' || ch === 'W') initial.push([ox + x, oy + y, ch]);
    }),
  );
  return new Game({ initial, first, stock });
}

const sortPos = (ps: Pos[]) => [...ps].sort((a, b) => a.x - b.x || a.y - b.y);

/** 検算用：石の外接矩形+1マスを総当たりして合法手を求める */
function bruteForceLegal(g: Game, color: Color): string[] {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const k of g.board.keys()) {
    const [x, y] = k.split(',').map(Number);
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minY = Math.min(b.minY, y);
    b.maxY = Math.max(b.maxY, y);
  }
  const res: string[] = [];
  for (let x = b.minX - 1; x <= b.maxX + 1; x++)
    for (let y = b.minY - 1; y <= b.maxY + 1; y++) if (g.flipsAt(x, y, color).length > 0) res.push(key(x, y));
  return res.sort();
}

describe('初期配置', () => {
  it('通常オセロと同じ 2×2 で黒から始まり、黒の合法手は4つ', () => {
    const g = new Game();
    expect(g.get(0, 0)).toBe('W');
    expect(g.get(1, 0)).toBe('B');
    expect(g.get(0, 1)).toBe('B');
    expect(g.get(1, 1)).toBe('W');
    expect(g.turn).toBe('B');
    expect(g.stock).toEqual({ B: 30, W: 30 });
    const moves = g.legalMoves().map((m) => key(m.x, m.y)).sort();
    expect(moves).toEqual(['-1,0', '0,-1', '1,2', '2,1'].sort());
  });

  it('負の座標への着手で正しく反転する', () => {
    const g = new Game();
    expect(g.play(0, -1)).not.toBeNull();
    expect(g.get(0, -1)).toBe('B');
    expect(g.get(0, 0)).toBe('B');
    expect(g.count()).toEqual({ B: 4, W: 1 });
    expect(g.stock).toEqual({ B: 29, W: 30 });
    expect(g.turn).toBe('W');
  });
});

describe('8方向の反転', () => {
  // 原点から遠い負の座標・正の座標の両方で同じ結果になること
  const origins: Array<[number, number]> = [
    [0, 0],
    [-1000, -1000],
    [-7, 3],
    [500, -250],
    [123456, 987654],
  ];
  for (const d of DIRECTIONS) {
    for (const [ox, oy] of origins) {
      it(`方向 (${d.x},${d.y}) 原点 (${ox},${oy})`, () => {
        // 置く位置 P=(ox,oy)、その先に W,W,W, B
        const initial: Array<[number, number, Color]> = [];
        for (let i = 1; i <= 3; i++) initial.push([ox + d.x * i, oy + d.y * i, 'W']);
        initial.push([ox + d.x * 4, oy + d.y * 4, 'B']);
        const g = new Game({ initial });
        const flips = g.flipsAt(ox, oy, 'B');
        expect(sortPos(flips)).toEqual(sortPos([1, 2, 3].map((i) => ({ x: ox + d.x * i, y: oy + d.y * i }))));
        g.play(ox, oy);
        for (let i = 0; i <= 4; i++) expect(g.get(ox + d.x * i, oy + d.y * i)).toBe('B');
      });
    }
  }

  it('全8方向を同時に反転する', () => {
    const g = fromAscii(
      [
        'B.B.B', //
        '.WWW.',
        'BW.WB',
        '.WWW.',
        'B.B.B',
      ],
      -3,
      -3,
    );
    const ev = g.play(-1, -1);
    expect(ev).not.toBeNull();
    expect(g.count()).toEqual({ B: 17, W: 0 });
  });

  it('挟んでいない方向は反転しない', () => {
    const g = fromAscii(['.WWB', 'W...', 'W...', '....'], -10, -10);
    // (−10,−10) に黒: 右方向は挟める、下方向は終端に黒がないので反転しない
    const flips = g.flipsAt(-10, -10, 'B');
    expect(sortPos(flips)).toEqual([
      { x: -9, y: -10 },
      { x: -8, y: -10 },
    ]);
  });

  it('間に空マスがあると挟めない', () => {
    const g = fromAscii(['.W.WB'], -2, 0);
    expect(g.flipsAt(-2, 0, 'B')).toEqual([]);
  });

  it('自分の石が隣接しているだけでは置けない', () => {
    const g = fromAscii(['.BW'], 0, 0);
    expect(g.flipsAt(0, 0, 'B')).toEqual([]);
  });

  it('石がある場所には置けない', () => {
    const g = new Game();
    expect(g.play(0, 0)).toBeNull();
    expect(g.play(1, 0)).toBeNull();
  });

  it('合法でない場所への着手は状態を変えない', () => {
    const g = new Game();
    expect(g.play(5, 5)).toBeNull();
    expect(g.play(-1, -1)).toBeNull();
    expect(g.moveCount).toBe(0);
    expect(g.stock.B).toBe(30);
    expect(g.turn).toBe('B');
  });

  it('非常に長い列（初期表示範囲の外まで続く列）も反転する', () => {
    const initial: Array<[number, number, Color]> = [];
    for (let i = 1; i <= 200; i++) initial.push([-i, -i, 'W']);
    initial.push([-201, -201, 'B']);
    const g = new Game({ initial });
    g.play(0, 0);
    expect(g.count()).toEqual({ B: 202, W: 0 });
  });
});

describe('パス・石切れ・終局', () => {
  it('合法手がないプレイヤーは自動でパスし、相手が続けて打つ', () => {
    // 黒が (0,0) に打つと、残る白は W B W の形で白から挟める黒がなくなる
    const g = fromAscii(['.WB..WBW'], 0, 0);
    const ev = g.play(0, 0)!;
    expect(ev.map((e) => e.type)).toEqual(['move', 'pass']);
    expect(ev[1]).toEqual({ type: 'pass', color: 'W' });
    expect(g.turn).toBe('B');
    expect(g.passCount).toEqual({ B: 0, W: 1 });
    // 黒は続けて打てる
    expect(g.play(4, 0)).not.toBeNull();
    expect(g.turn).toBe('W');
  });

  it('初期局面で手番側が打てない場合もパスになる', () => {
    const g = fromAscii(['WBW'], -5, -5, 'W');
    expect(g.turn).toBe('B');
    expect(g.passCount.W).toBe(1);
    expect(g.history).toEqual([{ type: 'pass', color: 'W' }]);
  });

  it('相手の石が盤上からなくなると両者打てず終局', () => {
    const g = fromAscii(['.WB'], -3, 7);
    const ev = g.play(-3, 7)!;
    expect(ev.map((e) => e.type)).toEqual(['move', 'end']);
    expect(g.over).toBe(true);
    expect(g.endReason).toBe('noLegalMoves');
    expect(g.winner()).toBe('B');
    expect(g.play(-4, 7)).toBeNull();
  });

  it('手持ち石を使い切ったプレイヤーは打てず、相手だけが続けて打つ', () => {
    const g = fromAscii(['.WB..WB..WB'], 0, 0, 'B', 1);
    // 白の手持ちを0にしておく
    g.stock.W = 0;
    // 黒が1手打つと黒も0個 → 両者石切れで終局
    const ev = g.play(0, 0)!;
    expect(ev.map((e) => e.type)).toEqual(['move', 'end']);
    expect(g.endReason).toBe('allStonesUsed');
  });

  it('片方だけ石切れの場合、もう片方が連続して着手できる', () => {
    const g = fromAscii(['.WB', '...', '.WB', '...', 'BW.'], 0, 0, 'B', 1);
    g.stock.W = 5;
    g.stock.B = 1;
    // 黒が打って黒は残り0。白は合法手があるので白番
    g.play(0, 0);
    expect(g.stock.B).toBe(0);
    expect(g.turn).toBe('W');
    // 白が打つと、黒は石切れなので白がもう一度打つ
    const wm = g.legalMoves('W');
    expect(wm.length).toBeGreaterThan(0);
    const ev = g.play(wm[0].x, wm[0].y)!;
    if (!g.over) {
      expect(ev.some((e) => e.type === 'outOfStones' && e.color === 'B')).toBe(true);
      expect(g.turn).toBe('W');
      expect(g.outOfStonesSkips.B).toBe(1);
      expect(g.passCount.B).toBe(0);
    }
  });

  it('同数で終わると draw', () => {
    // B が (0,0) に打って W1個反転 → B: 3, W: 3
    const g = fromAscii(['.WB', '...', 'WWW', 'B..'], 0, 0, 'B', 1);
    g.stock.W = 0;
    g.play(0, 0);
    expect(g.over).toBe(true);
    expect(g.count()).toEqual({ B: 4, W: 3 });
    expect(g.winner()).toBe('B');
    const h = fromAscii(['.WB', '...', 'WWWW', 'B...'], 0, 0, 'B', 1);
    h.stock.W = 0;
    h.play(0, 0);
    expect(h.count()).toEqual({ B: 4, W: 4 });
    expect(h.winner()).toBe('draw');
  });
});

describe('ランダム対局での不変条件と合法手探索の検算', () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }

  it('200局: 候補探索の合法手が総当たりと一致し、石数・手持ちの整合が取れる', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const g = new Game();
      let guard = 0;
      while (!g.over && guard++ < 200) {
        for (const c of ['B', 'W'] as Color[]) {
          const fast = g.legalMoves(c).map((m) => key(m.x, m.y)).sort();
          expect(fast).toEqual(bruteForceLegal(g, c));
        }
        const moves = g.legalMoves();
        expect(moves.length).toBeGreaterThan(0);
        expect(g.stock[g.turn]).toBeGreaterThan(0);
        const m = moves[Math.floor(r() * moves.length)];
        expect(g.play(m.x, m.y)).not.toBeNull();
        // 盤上の石の総数 = 初期4 + 手数、手持ち消費 = 手数
        expect(g.board.size).toBe(4 + g.moveCount);
        expect(60 - g.stock.B - g.stock.W).toBe(g.moveCount);
      }
      expect(g.over).toBe(true);
      expect(g.moveCount).toBeLessThanOrEqual(60);
      // 終局時は本当にどちらも打てない
      expect(g.canMove('B') || g.canMove('W')).toBe(false);
      const ends = g.history.filter((e) => e.type === 'end');
      expect(ends.length).toBe(1);
    }
  });
});
