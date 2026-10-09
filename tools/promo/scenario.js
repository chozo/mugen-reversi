// 無限オセロの告知動画の台本。ポップで楽しい雰囲気に。
// 「あなた」（白・後手）の手は pickMove で選び、画面上の位置をタップする。
// 強いコンピュータ同士だと直線を伸ばし合う細長い盤面になり、画面映えしないので、
// 「多く返せる・盤面の中心に近い」手を選んで、白黒が入り混じる密な盤面にする。相手はコンピュータ（ふつう）。字幕は時刻で決め打ちせず、着手・終局の出来事に合わせる。
// 使える操作はスキルの references/scenario-api.md を参照。

export const config = {
  slug: 'mugen-othello',
  url: 'https://game.chozo.net/mugen-othello/',
  orientation: 'portrait',
  game: { width: 390, height: 693 },
  // 字幕を上に出すので、ゲーム画面は少し下に置く
  layout: { centerX: 0.47, centerY: 0.5, maxW: 0.72, maxH: 0.6 },
  serveDir: 'dist',
  gamePath: '/mugen-othello/',
  // BGM はゲームの BGM（__game.promoBgm）を効果音と同じ経路で書き出す
  music: false,
};

const SEED = Number(process.env.PROMO_SEED || 5); // あなたが僅差で勝つ展開（白34-黒30）
const HUMAN = 'W';
const CPU_LEVEL = 'normal';

/** ゲームの window で実行: 多く返せて、石の重心に近い手（同点は乱数） */
function pickMove(_, win) {
  const g = win.__game.game;
  const moves = g.legalMoves(g.turn);
  if (moves.length === 0) return null;
  let cx = 0;
  let cy = 0;
  for (const k of g.board.keys()) {
    const [x, y] = k.split(',').map(Number);
    cx += x;
    cy += y;
  }
  cx /= g.board.size;
  cy /= g.board.size;
  let best = null;
  let bestScore = -Infinity;
  for (const m of moves) {
    const score = m.flips.length - 0.7 * Math.hypot(m.x + 0.5 - cx, m.y + 0.5 - cy) + Math.random() * 0.8;
    if (score > bestScore) {
      bestScore = score;
      best = { x: m.x, y: m.y };
    }
  }
  return best;
}

/** 「あなた」の番になるまで待つ（CPU の手と反転の演出を撮る） */
async function waitHumanTurn(p, max = 8) {
  await p.until((s) => s.over || (s.turn === HUMAN && !s.cpuThinking && !s.animating), { max });
  return p.state();
}

/** 画面の外なら全体表示にしてから、その手のマスをタップする */
async function tapMove(p, m, { fit = true } = {}) {
  let [x, y] = await p.call('cellToScreen', m.x, m.y);
  if (fit && (x < 24 || x > 366 || y < 110 || y > 600)) {
    await p.call('fitAll');
    await p.wait(0.3);
    [x, y] = await p.call('cellToScreen', m.x, m.y);
  }
  await p.tap(x, y, 0.06);
}

/** あなたの手を1つ打つ。打てなければ false */
async function humanMove(p, { think = 0.25, level = null, ...opt } = {}) {
  const s = await waitHumanTurn(p);
  if (s.over) return false;
  if (think > 0) await p.wait(think); // 少し考える間（早送り中は省く）
  // level を指定したら、その強さのコンピュータが選ぶ手（終盤の読み切り）
  const m = level ? await p.call('bestMove', level) : await p.eval(pickMove, null);
  if (!m) return false;
  await tapMove(p, m, opt);
  return true;
}

export default async function scenario(p) {
  await p.seed(SEED);

  // ---------- 準備（撮らない）: つかみ用に、終盤の「一気にひっくり返す」局面を作る ----------
  await p.call('newGame', { cpu: CPU_LEVEL, human: HUMAN });
  for (let i = 0; i < 200; i++) {
    const s = await p.state();
    if (s.over || s.moveCount >= 44) break;
    if (s.turn === HUMAN && !s.cpuThinking && !s.animating) {
      const m = await p.eval(pickMove, null);
      await p.call('play', m.x, m.y);
    }
    await p.skip(0.25);
  }
  for (let i = 0; i < 40; i++) {
    const s = await p.state();
    if (s.turn === HUMAN && !s.cpuThinking && !s.animating) break;
    await p.skip(0.2);
  }
  // いちばん多く返せる手と、返る石の範囲
  const big = await p.eval((human, win) => {
    const g = win.__game.game;
    const moves = g.legalMoves(human);
    moves.sort((a, b) => b.flips.length - a.flips.length);
    const m = moves[0];
    const xs = [m.x, ...m.flips.map((f) => f.x)];
    const ys = [m.y, ...m.flips.map((f) => f.y)];
    return { x: m.x, y: m.y, n: m.flips.length, x0: Math.min(...xs), x1: Math.max(...xs) + 1, y0: Math.min(...ys), y1: Math.max(...ys) + 1 };
  }, HUMAN);
  await p.eval((b, win) => win.__game.camera.fit(b.x0 - 1, b.y0 - 1, b.x1 + 1, b.y1 + 1, { top: 90, bottom: 80 }, false), big);
  await p.skip(0.05);
  await p.call('audio.drain'); // 準備中の効果音は使わない

  // ---------- 0〜2.4秒 つかみ: スローで一気にひっくり返す ----------
  await p.call('promoBgm', 0.42, 34);
  p.caption('ここに置くと…？', { y: 0.1, dur: 1.0, size: 44 });
  await p.wait(0.55);
  p.speed(0.4, { badge: false });
  p.zoom(1.12, 0.6, { x: 0.47, y: 0.45 });
  await p.tap(...(await p.call('cellToScreen', big.x, big.y)), 0.05);
  p.fx(`${big.n}枚\nひっくり返し！`, { x: 0.47, y: 0.47, dur: 1.4, size: 64 });
  p.shake(10, 0.4);
  await p.wait(1.5);
  p.speed(1);
  p.zoom(1, 0.3);
  p.flash({ dur: 0.3, strength: 0.8 });

  // ---------- 2.4〜5.6秒 タイトル ----------
  p.title({ title: '無限オセロ', sub: '端のない盤面で\n32枚の石の陣取り！', logo: 'logo.svg', dur: 3.2 });
  await p.wait(3.4);

  // ---------- 5.6〜 実際のプレイ（最初から） ----------
  await p.call('newGame', { cpu: CPU_LEVEL, human: HUMAN });
  await p.call('audio.drain');
  p.caption('タップで石を置く！', { y: 0.1, dur: 2.0 });
  await humanMove(p);
  p.fx('パチッ！', { x: 0.62, y: 0.38, dur: 0.6, size: 56 });
  await humanMove(p);
  await humanMove(p);

  // 早送りで盤面が広がっていく様子
  p.caption('盤面はどこまでも\n広がる！', { y: 0.09, dur: 2.2 });
  p.speed(4);
  for (let i = 0; i < 9; i++) {
    if (!(await humanMove(p, { think: 0 }))) break;
    if (i % 3 === 2) await p.call('fitAll');
  }
  p.speed(1);
  await waitHumanTurn(p);

  // スワイプで移動
  p.caption('スワイプで\n自由に移動！', { y: 0.09, dur: 1.8 });
  await p.drag(
    [
      [200, 420],
      [150, 380],
      [110, 350],
    ],
    0.6,
  );
  await p.drag(
    [
      [110, 350],
      [170, 400],
      [240, 450],
    ],
    0.6,
  );
  await p.call('fitAll');
  await p.wait(0.3);

  // 終盤まで早送り
  p.caption('角も辺もない\n読み合い！', { y: 0.09, dur: 2.0 });
  p.speed(6);
  for (let i = 0; i < 40; i++) {
    const s = await waitHumanTurn(p);
    if (s.over || s.moveCount >= 54) break;
    await humanMove(p, { think: 0 });
    if (i % 4 === 3) await p.call('fitAll');
  }
  p.speed(1);
  await p.call('fitAll');

  // ---------- クライマックス: 最後の数手と終局 ----------
  p.caption('最後の1手まで\n逆転あり！', { y: 0.09, dur: 2.0 });
  let lastFx = -10;
  p.on('move', (e) => {
    // 大きく返したときだけ、前の効果文字と重ならない間隔で出す
    // 最後の手（60手目）は「勝った〜！」と重なるので出さない
    if (e.flips >= 6 && e.moveCount < 60 && p.time - lastFx > 1.2) {
      lastFx = p.time;
      p.fx(e.by === 'human' ? 'ドドドッ！' : 'うわっ！', { x: 0.5, y: 0.47, dur: 0.9, size: 60 });
      p.shake(8, 0.3);
    }
  });
  p.on('end', (e) => {
    p.flash({ dur: 0.35 });
    if (e.winner === 'human') p.fx('勝った〜！', { x: 0.47, y: 0.3, dur: 2.2, size: 70 });
  });
  for (let i = 0; i < 6; i++) {
    if (!(await humanMove(p, { think: 0.3, level: 'hard' }))) break;
  }
  await p.until((s) => s.resultShown, { max: 6 });
  const fin = await p.state();
  console.log(`  結果: ${fin.winner === HUMAN ? 'あなたの勝ち' : fin.winner === 'draw' ? '引き分け' : 'CPUの勝ち'}（黒${fin.count.B} - 白${fin.count.W}）`);
  await p.wait(2.0);
  p.off('move');
  p.off('end');

  // ---------- エンドカード ----------
  p.endCard({ title: '無限オセロ', sub: 'CPUと対戦・4段階の強さ', cta: '今すぐ遊べる！', logo: 'logo.svg' });
  await p.wait(3);
}
