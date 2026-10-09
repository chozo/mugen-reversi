// ゲームデザイン検証用の自動対局。人間のプレイの代わりにはならないが、
// 盤面の広がり・パス頻度・先後の偏りなどの傾向をつかむために使う。
// 実行: npm run sim [-- 局数]
declare const process: { argv: string[] };
import { Game, opponent, type Color, type Move } from '../src/core/game.ts';

type Strategy = (g: Game, moves: Move[], rnd: () => number) => Move;

const random: Strategy = (_g, moves, rnd) => moves[Math.floor(rnd() * moves.length)];
const greedy: Strategy = (_g, moves, rnd) => {
  const best = Math.max(...moves.map((m) => m.flips.length));
  const top = moves.filter((m) => m.flips.length === best);
  return top[Math.floor(rnd() * top.length)];
};
/** 相手の合法手を最も減らす手（簡易な機動力重視） */
const mobility: Strategy = (g, moves, rnd) => {
  let best = Infinity;
  let top: Move[] = [];
  for (const m of moves) {
    const snapshot = new Map(g.board);
    g.board.set(`${m.x},${m.y}`, g.turn);
    for (const f of m.flips) g.board.set(`${f.x},${f.y}`, g.turn);
    const n = g.legalMoves(opponent(g.turn)).length;
    g.board.clear();
    for (const [k, v] of snapshot) g.board.set(k, v);
    if (n < best) {
      best = n;
      top = [m];
    } else if (n === best) top.push(m);
  }
  return top[Math.floor(rnd() * top.length)];
};

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function run(name: string, black: Strategy, white: Strategy, n: number) {
  const s = {
    win: { B: 0, W: 0, draw: 0 } as Record<Color | 'draw', number>,
    moves: 0,
    passes: 0,
    gamesWithPass: 0,
    wipeouts: 0,
    noMoves: 0,
    width: 0,
    height: 0,
    maxSide: 0,
    diff: 0,
    legalAvg: 0,
    legalSamples: 0,
  };
  for (let i = 0; i < n; i++) {
    const rnd = rng(i * 7919 + 1);
    const g = new Game();
    while (!g.over) {
      const moves = g.legalMoves();
      s.legalAvg += moves.length;
      s.legalSamples++;
      const m = (g.turn === 'B' ? black : white)(g, moves, rnd);
      g.play(m.x, m.y);
    }
    const c = g.count();
    s.win[g.winner()!]++;
    s.moves += g.moveCount;
    const p = g.passCount.B + g.passCount.W;
    s.passes += p;
    if (p > 0) s.gamesWithPass++;
    if (g.endReason === 'noLegalMoves') s.noMoves++;
    if (c.B === 0 || c.W === 0) s.wipeouts++;
    const w = g.bounds.maxX - g.bounds.minX + 1;
    const h = g.bounds.maxY - g.bounds.minY + 1;
    s.width += w;
    s.height += h;
    s.maxSide = Math.max(s.maxSide, w, h);
    s.diff += Math.abs(c.B - c.W);
  }
  const pct = (v: number) => `${((v / n) * 100).toFixed(1)}%`;
  console.log(`\n## ${name}（${n}局）`);
  console.log(`勝率  黒 ${pct(s.win.B)} / 白 ${pct(s.win.W)} / 引分 ${pct(s.win.draw)}`);
  console.log(`平均手数 ${(s.moves / n).toFixed(1)}  合法手不足で終局 ${pct(s.noMoves)}（うち全滅 ${pct(s.wipeouts)}）`);
  console.log(`パスが起きた局 ${pct(s.gamesWithPass)}  平均パス回数 ${(s.passes / n).toFixed(2)}`);
  console.log(
    `盤面の広がり 平均 ${(s.width / n).toFixed(1)}×${(s.height / n).toFixed(1)}  最大辺 ${s.maxSide}  平均合法手数 ${(s.legalAvg / s.legalSamples).toFixed(1)}`,
  );
  console.log(`平均石差 ${(s.diff / n).toFixed(1)}`);
}

const n = Number(process.argv[2] ?? 500);
run('ランダム vs ランダム', random, random, n);
run('最大反転 vs 最大反転', greedy, greedy, n);
run('機動力 vs 機動力', mobility, mobility, Math.min(n, 200));
run('機動力(黒) vs 最大反転(白)', mobility, greedy, Math.min(n, 200));
run('最大反転(黒) vs 機動力(白)', greedy, mobility, Math.min(n, 200));
