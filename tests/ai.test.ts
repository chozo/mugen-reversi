import { describe, expect, it } from 'vitest';
import { toPosition } from '../src/ai/client.ts';
import { chooseMove, LEVEL_ORDER, SearchBoard } from '../src/ai/search.ts';
import { Game, key } from '../src/core/game.ts';

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** ランダムに n 手進めた局面 */
function randomGame(seed: number, n: number): Game {
  const r = rng(seed);
  const g = new Game();
  while (!g.over && g.moveCount < n) {
    const ms = g.legalMoves();
    const m = ms[Math.floor(r() * ms.length)];
    g.play(m.x, m.y);
  }
  return g;
}

/** 検算用：Game を使った全探索。黒 - 白 の最終石差（黒は最大化、白は最小化） */
function solve(g: Game): number {
  if (g.over) {
    const c = g.count();
    return c.B - c.W;
  }
  let best = g.turn === 'B' ? -Infinity : Infinity;
  for (const m of g.legalMoves()) {
    const h = g.clone();
    h.play(m.x, m.y);
    const v = solve(h);
    best = g.turn === 'B' ? Math.max(best, v) : Math.min(best, v);
  }
  return best;
}

describe('探索用の盤面', () => {
  it('合法手が Game と一致し、打って戻すと元に戻る', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const g = randomGame(seed, seed % 50);
      if (g.over) continue;
      const b = new SearchBoard(toPosition(g));
      const side = g.turn === 'B' ? 1 : -1;
      const enc = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768);
      const expected = g.legalMoves().map((m) => [enc(m.x, m.y), m.flips.length].join(':')).sort();
      const moves = b.moves(side);
      expect(moves.map((m) => [m.k, m.n].join(':')).sort()).toEqual(expected);
      const before = [...b.cells].sort((p, q) => p[0] - q[0]);
      const diff = b.diff;
      for (const m of moves) {
        b.make(m.k, side);
        b.unmake();
      }
      expect([...b.cells].sort((p, q) => p[0] - q[0])).toEqual(before);
      expect(b.diff).toBe(diff);
      expect([b.stockB, b.stockW]).toEqual([g.stock.B, g.stock.W]);
    }
  });

  it('負の座標・遠方の座標でも合法手を正しく求める', () => {
    const g = new Game({
      initial: [
        [-5000, -7000, 'W'],
        [-4999, -7000, 'B'],
        [-5000, -6999, 'B'],
        [-4999, -6999, 'W'],
      ],
    });
    const res = chooseMove(toPosition(g), 'expert', rng(1), { timeMs: 200 })!;
    expect(g.legalMoves().map((m) => key(m.x, m.y))).toContain(key(res.x, res.y));
  });
});

describe('コンピュータの着手', () => {
  it('どの強さでも合法手を返す', () => {
    for (const level of LEVEL_ORDER) {
      for (let seed = 1; seed <= 5; seed++) {
        const g = randomGame(seed * 13, seed * 9);
        if (g.over) continue;
        const res = chooseMove(toPosition(g), level, rng(seed), { timeMs: 100 })!;
        expect(g.legalMoves().map((m) => key(m.x, m.y))).toContain(key(res.x, res.y));
      }
    }
  });

  it('合法手がなければ null', () => {
    const res = chooseMove({ stones: [[0, 0, 'B']], stock: { B: 5, W: 5 }, turn: 'W' }, 'expert');
    expect(res).toBeNull();
  });

  it('一手で相手を全滅させられるなら、げきむずはその手を選ぶ', () => {
    // (0,0) に打つと白が全滅して勝ち。(5,0) に打つと3個返せるが白が残る
    const g = new Game({
      initial: [
        [1, 0, 'W'],
        [2, 0, 'B'],
        [-3, 3, 'B'],
        [-2, 3, 'W'],
      ],
      stock: 5,
    });
    const res = chooseMove(toPosition(g), 'expert', rng(1), { timeMs: 500 })!;
    // どちらの手でも1個ずつしか返らないので、勝ちが確定する手を読みで見つける必要がある
    const h = g.clone();
    h.play(res.x, res.y);
    expect(solve(h)).toBe(solve(g));
  });

  it('終盤の読み切りは全探索と同じ結果になる', () => {
    let checked = 0;
    for (let seed = 1; checked < 6 && seed < 40; seed++) {
      const g = randomGame(seed, 57); // 残り3手
      if (g.over) continue;
      const res = chooseMove(toPosition(g), 'expert', rng(seed), { timeMs: 5000 })!;
      expect(res.exact).toBe(true);
      const best = solve(g);
      const h = g.clone();
      h.play(res.x, res.y);
      // 選んだ手の結果が最善と同じ
      expect(solve(h)).toBe(best);
      // 評価値（手番から見た石差。勝敗の加点を除く）も一致する
      const side = g.turn === 'B' ? 1 : -1;
      const s = res.score;
      const d = s > 500_000 ? s - 1_000_000 : s < -500_000 ? s + 1_000_000 : s;
      expect(d).toBe(best * side);
      checked++;
    }
    expect(checked).toBe(6);
  }, 60_000);
});
