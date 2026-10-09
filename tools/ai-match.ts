// コンピュータの強さを自動対局で比べる。先後を入れ替えて同数ずつ打つ。
// 実行: npm run sim:ai [-- 局数]
declare const process: { argv: string[] };
import { Game, type Color } from '../src/core/game.ts';
import { toPosition } from '../src/ai/client.ts';
import { chooseMove, LEVELS, type Level, type LevelSpec } from '../src/ai/search.ts';

interface Player {
  name: string;
  level: Level;
  override?: Partial<LevelSpec>;
}

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function playGame(black: Player, white: Player, seed: number) {
  const r = rng(seed);
  const g = new Game();
  const think: Record<Color, { ms: number; n: number; depth: number }> = {
    B: { ms: 0, n: 0, depth: 0 },
    W: { ms: 0, n: 0, depth: 0 },
  };
  while (!g.over) {
    const p = g.turn === 'B' ? black : white;
    const res = chooseMove(toPosition(g), p.level, r, p.override)!;
    think[g.turn].ms = Math.max(think[g.turn].ms, res.ms);
    think[g.turn].n++;
    think[g.turn].depth += res.depth;
    if (!g.play(res.x, res.y)) throw new Error(`illegal move ${res.x},${res.y}`);
  }
  return { winner: g.winner()!, count: g.count(), think };
}

function match(a: Player, b: Player, n: number) {
  let aw = 0;
  let bw = 0;
  let dr = 0;
  let aBlackWins = 0;
  let maxMsA = 0;
  let maxMsB = 0;
  let depthA = 0;
  let movesA = 0;
  let marginBlack = 0;
  let marginWhite = 0;
  for (let i = 0; i < n; i++) {
    const aIsBlack = i % 2 === 0;
    const res = aIsBlack ? playGame(a, b, i + 1) : playGame(b, a, i + 1);
    const aColor: Color = aIsBlack ? 'B' : 'W';
    const margin = (res.count.B - res.count.W) * (aIsBlack ? 1 : -1);
    if (aIsBlack) marginBlack += margin;
    else marginWhite += margin;
    if (res.winner === 'draw') dr++;
    else if (res.winner === aColor) {
      aw++;
      if (aIsBlack) aBlackWins++;
    } else bw++;
    const ta = res.think[aColor];
    const tb = res.think[aColor === 'B' ? 'W' : 'B'];
    maxMsA = Math.max(maxMsA, ta.ms);
    maxMsB = Math.max(maxMsB, tb.ms);
    depthA += ta.depth;
    movesA += ta.n;
  }
  console.log(
    `${a.name} vs ${b.name}: ${aw}勝 ${bw}敗 ${dr}分（${a.name}の黒番での勝ち ${aBlackWins}/${Math.ceil(n / 2)}）` +
      `  ${a.name}の平均石差 黒番 ${(marginBlack / Math.ceil(n / 2)).toFixed(1)} 白番 ${(marginWhite / Math.floor(n / 2)).toFixed(1)}` +
      `  最大思考 ${maxMsA.toFixed(0)}ms / ${maxMsB.toFixed(0)}ms  ${a.name}の平均深さ ${(depthA / movesA).toFixed(1)}`,
  );
}

if (process.argv[1].endsWith('ai-match.ts')) main();

function main() {
  const n = Number(process.argv[2] ?? 10);
  const P = (level: Level, override?: Partial<LevelSpec>): Player => ({ name: LEVELS[level].label, level, override });
  console.log(`各 ${n} 局（先後を入れ替え）`);
  match(P('normal'), P('easy'), n);
  match(P('hard'), P('normal'), n);
  match(P('expert'), P('hard'), n);
}
