// ブラウザでの動作確認。ビルド済みの dist を vite preview で配信し、
// インストール済みの Chrome（ヘッドレス）で操作する。
// 実行: npm run build && npm run e2e   （スクリーンショットは E2E_OUT または OS の一時ディレクトリへ）
// 公開URLを確認するとき: E2E_URL=https://game.chozo.net/mugen-reversi/ npm run e2e
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 4179;
const URL = process.env.E2E_URL ?? `http://localhost:${PORT}/`;
const OUT = process.env.E2E_OUT ?? join(tmpdir(), 'mugen-reversi-e2e');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '  ok ' : '  NG '} ${msg}`);
  if (!cond) failures++;
};

// E2E_URL を指定しなければ、ビルド済みの dist を手元で配信する
const server = process.env.E2E_URL ? null : spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
if (server) {
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('localhost') && resolve());
    server.on('exit', () => reject(new Error('preview server exited')));
    setTimeout(() => reject(new Error('preview server timeout')), 15000);
  });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'small', viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'pc', viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
];

try {
  for (const vp of VIEWPORTS) {
    console.log(`\n# ${vp.name} ${vp.viewport.width}x${vp.viewport.height}`);
    const ctx = await browser.newContext(vp);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(URL);
    await page.waitForFunction(() => window.__game);
    await page.evaluate(() => window.__game.setAnimSpeed(20));
    const g = (fn) => page.evaluate(fn);
    const state = () => g(() => window.__game.state());

    const tap = async (x, y) => {
      const [sx, sy] = await g(`window.__game.cellToScreen(${x}, ${y})`);
      if (vp.hasTouch) await page.touchscreen.tap(sx, sy);
      else await page.mouse.click(sx, sy);
      await page.waitForTimeout(80);
    };
    const humanMove = () =>
      g(() => {
        const l = window.__game.legal;
        const m = l[Math.floor(Math.random() * l.length)];
        return window.__game.play(m.x, m.y);
      });
    const waitHumanTurn = () =>
      page.waitForFunction(() => {
        const s = window.__game.state();
        return s.over || (!s.cpuThinking && !window.__game.animating && s.turn === window.__game.mode.human);
      });
    /** 対戦設定を選んで始める */
    const start = async (level, color) => {
      if (!(await state()).setupShown) await page.click('#btn-new');
      await page.click(`#opt-level [data-v="${level}"]`);
      await page.click(`#opt-color [data-v="${color}"]`);
      await page.click('#btn-start');
    };

    let s = await state();
    check(s.titleShown && !s.setupShown, '起動時にタイトル画面が表示される');
    const titleText = await page.textContent('#title');
    check(
      ['無限に広がる盤面', '32枚', '操作方法', 'タップ', 'ピンチ', '全体の戦況'].every((w) => titleText.includes(w)),
      'タイトル画面に特徴・操作方法・戦い方のひとことがある',
    );
    await page.screenshot({ path: join(OUT, `${vp.name}-title.png`) });
    const topBtn = await page.locator('#btn-play-top').boundingBox();
    check(topBtn && topBtn.y + topBtn.height <= vp.viewport.height, 'スクロールしなくても上部の「あそぶ」が見える');
    await page.click('#btn-play-top');
    check((await state()).setupShown, '上部の「あそぶ」で対戦設定が開く');
    await page.click('#btn-howto');
    await page.screenshot({ path: join(OUT, `${vp.name}-title-full.png`), fullPage: false });
    // 「あそぶ」まで画面内に収まるか、スクロールで届く
    await page.locator('#btn-play').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, `${vp.name}-title-bottom.png`) });
    await page.click('#btn-play');
    s = await state();
    check(!s.titleShown && s.setupShown && (await page.isHidden('#btn-setup-cancel')), '「あそぶ」で対戦設定へ（対局前なのでキャンセルはない）');
    await page.click('#btn-howto');
    check((await state()).titleShown, '対戦設定の「遊び方」でタイトル画面に戻る');
    await page.click('#btn-play');
    s = await state();
    check(s.setupShown, '「あそぶ」で対戦設定が開く');
    check(s.audio.context === 'none', '「はじめる」を押すまで音は鳴らない（AudioContext を作らない）');
    check((await page.locator('#btn-debug, #debug').count()) === 0, 'Debug ボタンと開発用表示がない');
    check((await page.locator('#opt-opponent').count()) === 0 && (await page.locator('#opt-level button').count()) === 4, '対戦相手の選択はなく、強さが4段階');
    await page.click('#opt-level [data-v="easy"]');
    await page.click('#opt-color [data-v="W"]');
    await page.screenshot({ path: join(OUT, `${vp.name}-0-setup.png`) });

    // ---- CPU が先手（あなたは白）: CPU が先に打つ ----
    await page.click('#btn-start');
    await page.waitForFunction(() => window.__game.state().audio.context === 'running');
    s = await state();
    check(s.audio.bgm && s.audio.enabled, '「はじめる」で音が有効になり BGM が始まる');
    await waitHumanTurn();
    s = await state();
    check(s.moveCount === 1 && s.turn === 'W', 'あなたが白なら CPU（黒）が先に1手打つ');

    // 音の ON / OFF
    await page.click('#btn-sound');
    await page.waitForFunction(() => window.__game.state().audio.context === 'suspended');
    s = await state();
    check(!s.audio.enabled && !s.audio.bgm && (await page.textContent('#btn-sound')) === '音 OFF', '「音 OFF」で BGM が止まり、音声処理も止まる');
    await page.click('#btn-sound');
    await page.waitForFunction(() => window.__game.state().audio.context === 'running');
    s = await state();
    check(s.audio.enabled && s.audio.bgm && (await page.textContent('#btn-sound')) === '音 ON', '「音 ON」で BGM が再開する');

    // 音量（書き出して測る）。BGM は控えめ、効果音を足しても音割れしない
    if (vp.name === 'phone') {
      const bgm = await g(() => window.__game.renderAudio(30, false));
      const mix = await g(() => window.__game.renderAudio(12, true));
      writeFileSync(join(OUT, 'bgm.wav'), Buffer.from(bgm.wav, 'base64'));
      writeFileSync(join(OUT, 'bgm-with-se.wav'), Buffer.from(mix.wav, 'base64'));
      check(bgm.rmsDb > -60 && bgm.rmsDb < -18 && bgm.peakDb < -3, `BGM の音量 RMS ${bgm.rmsDb.toFixed(1)} dBFS / ピーク ${bgm.peakDb.toFixed(1)} dBFS`);
      check(mix.peakDb < -1 && mix.rmsDb > bgm.rmsDb, `BGM+効果音 RMS ${mix.rmsDb.toFixed(1)} dBFS / ピーク ${mix.peakDb.toFixed(1)} dBFS`);
    }
    check((await page.textContent('#who-B')) === 'CPU・かんたん' && (await page.textContent('#who-W')) === 'あなた', 'HUD に「CPU・かんたん」「あなた」と出る');

    // ---- あなたが先手（黒）: 初期状態と操作 ----
    await start('easy', 'B');
    s = await state();
    check(s.moveCount === 0 && s.turn === 'B' && s.legal === 4 && s.count.B === 2 && s.count.W === 2, '初期状態: あなた（黒）の番・合法手4・石2-2');
    check((await page.textContent('#turn')) === 'あなたの番', '手番の表示が「あなたの番」');
    await page.screenshot({ path: join(OUT, `${vp.name}-1-initial.png`) });

    // 初期4石が画面内（HUD・ボタンに隠れない位置）に見えている
    const vis = await g(() => {
      const hud = document.querySelector('.hud').getBoundingClientRect();
      const ctl = document.querySelector('.controls').getBoundingClientRect();
      return [
        [-1, -1],
        [3, 3],
      ].every(([x, y]) => {
        const [sx, sy] = window.__game.cellToScreen(x, y);
        return sx > 0 && sx < innerWidth && sy > hud.bottom && sy < ctl.top;
      });
    });
    check(vis, '初期4石と周囲1マスが HUD とボタンの間に見えている');

    // 実際のタップ/クリックで着手 → CPU が応手
    await tap(5, 5);
    check((await state()).moveCount === 0, '合法手でないマスをタップしても着手されない');
    await tap(0, -1);
    s = await state();
    check(s.moveCount >= 1 && s.stock.B === 29 && s.count.B + s.count.W === 4 + s.moveCount, 'タップで (0,-1) に着手し、手持ちが減る');
    await waitHumanTurn();
    s = await state();
    check(s.moveCount === 2 && s.turn === 'B' && s.stock.W === 29, 'CPU が応手して、あなたの番に戻る');

    // ドラッグで移動（着手されない）
    const cam0 = await g(() => ({ cx: window.__game.camera.cx, cy: window.__game.camera.cy, cell: window.__game.camera.cell }));
    const cx = vp.viewport.width / 2;
    const cy = vp.viewport.height / 2;
    if (vp.hasTouch) {
      const cdp = await ctx.newCDPSession(page);
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
      await touch('touchStart', [[cx, cy]]);
      for (let i = 1; i <= 10; i++) await touch('touchMove', [[cx - i * 12, cy - i * 8]]);
      await touch('touchEnd', []);
      await page.waitForTimeout(50);
      const cam1 = await g(() => ({ cx: window.__game.camera.cx, cy: window.__game.camera.cy, cell: window.__game.camera.cell }));
      check(cam1.cx > cam0.cx && cam1.cy > cam0.cy, 'スワイプで盤面が移動する');
      check((await state()).moveCount === 2, 'スワイプでは着手されない');
      // ピンチで拡大
      await touch('touchStart', [
        [cx - 30, cy],
        [cx + 30, cy],
      ]);
      for (let i = 1; i <= 10; i++)
        await touch('touchMove', [
          [cx - 30 - i * 6, cy],
          [cx + 30 + i * 6, cy],
        ]);
      await touch('touchEnd', []);
      await page.waitForTimeout(50);
      const cam2 = await g(() => window.__game.camera.cell);
      check(cam2 > cam1.cell * 1.5, `ピンチアウトで拡大する (${cam1.cell.toFixed(1)} → ${cam2.toFixed(1)})`);
      check((await state()).moveCount === 2, 'ピンチでは着手されない');
    } else {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(cx - i * 15, cy - i * 10);
      await page.mouse.up();
      const cam1 = await g(() => ({ cx: window.__game.camera.cx, cy: window.__game.camera.cy, cell: window.__game.camera.cell }));
      check(cam1.cx > cam0.cx && cam1.cy > cam0.cy, 'マウスドラッグで盤面が移動する');
      check((await state()).moveCount === 2, 'ドラッグでは着手されない');
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(50);
      const cam2 = await g(() => window.__game.camera.cell);
      check(cam2 > cam1.cell, `ホイールで拡大する (${cam1.cell.toFixed(1)} → ${cam2.toFixed(1)})`);
    }

    // 遠くの負の座標まで移動しても座標変換が正しい
    await g(() => {
      const c = window.__game.camera;
      c.cx = -100000.5;
      c.cy = -250000.5;
    });
    const far = await g(() => window.__game.camera.cellAt(innerWidth / 2, innerHeight / 2));
    check(far[0] === -100001 && far[1] === -250001, `遠方の負の座標のマスを正しく判定 (${far})`);
    await g(() => window.__game.fitAll());
    await page.waitForTimeout(400);

    // 対局中に New Game を開いてもキャンセルすれば続けられる
    await page.click('#btn-new');
    await page.click('#btn-howto');
    check((await state()).titleShown, '対局中も New Game → 遊び方 でタイトル画面を見られる');
    await page.click('#btn-play');
    await page.click('#btn-setup-cancel');
    s = await state();
    check(s.moveCount === 2 && !s.titleShown && !s.setupShown, '対戦設定をキャンセルすると対局が続く');

    // ---- 最後まで打つ ----
    let guard = 0;
    while (!(await state()).over && guard++ < 100) {
      await waitHumanTurn();
      if ((await state()).over) break;
      if (!(await humanMove())) check(false, `あなたの着手 ${guard}`);
      // CPU の手番には人が打てない
      const blocked = await g(() => {
        const s = window.__game.state();
        if (s.over || s.turn === window.__game.mode.human) return true;
        const l = window.__game.legal;
        return l.length === 0 || !window.__game.play(l[0].x, l[0].y);
      });
      if (!blocked) check(false, 'CPU の手番には人が打てない');
      if (guard === 15) {
        await waitHumanTurn();
        await g(() => window.__game.fitAll());
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(OUT, `${vp.name}-2-midgame.png`) });
      }
    }
    await page.waitForFunction(() => !window.__game.animating);
    await page.waitForTimeout(100);
    s = await state();
    const title = await page.textContent('#result-title');
    check(
      s.over && s.resultShown && ['あなたの勝ち', 'CPUの勝ち', '引き分け'].includes(title),
      `終局して結果が出る（${title} ${s.moveCount}手 黒${s.count.B}-白${s.count.W} ${s.endReason}）`,
    );
    check(s.count.B + s.count.W === 4 + s.moveCount, '盤上の石数 = 4 + 手数');
    await page.screenshot({ path: join(OUT, `${vp.name}-3-result.png`) });
    await page.click('#btn-close-result');
    await g(() => window.__game.fitAll());
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${vp.name}-4-final-board.png`) });

    // ---- げきむず: 考えている間も画面が固まらない ----
    await start('expert', 'B');
    s = await state();
    check(s.moveCount === 0 && !s.over && !s.resultShown && !s.setupShown, 'New Game → はじめる で初期状態に戻る');
    for (let i = 0; i < 3; i++) {
      await waitHumanTurn();
      await humanMove();
      await page.waitForFunction(() => window.__game.state().cpuThinking);
      // 思考中でも、ページの処理（ここでは状態の取得）がすぐ返る
      const t0 = Date.now();
      await state();
      const lag = Date.now() - t0;
      check(lag < 300, `げきむずの思考中も画面が応答する（${lag}ms）`);
    }
    const t1 = Date.now();
    await waitHumanTurn();
    s = await state();
    check(s.moveCount === 6 && s.lastThink && s.lastThink.depth >= 2, `げきむずが ${Date.now() - t1}ms で打つ（読み ${s.lastThink?.depth} 手, ${s.lastThink?.nodes} 局面）`);
    await page.screenshot({ path: join(OUT, `${vp.name}-7-expert.png`) });

    // 考え中に New Game しても古い思考結果で打たれない
    await humanMove();
    await page.waitForFunction(() => window.__game.state().cpuThinking);
    await start('easy', 'B');
    await page.waitForTimeout(2500);
    s = await state();
    check(s.moveCount === 0 && !s.cpuThinking, '考え中に新しい対局を始めても、古い思考結果は使われない');

    // 横はみ出しがない
    const overflow = await g(() => document.documentElement.scrollWidth > innerWidth);
    check(!overflow, '横方向にはみ出さない');
    check(errors.length === 0, `コンソールエラーなし ${errors.join(' | ')}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server?.kill();
}

console.log(`\nスクリーンショット: ${OUT}`);
if (failures > 0) {
  console.log(`${failures} 件失敗`);
  process.exit(1);
}
console.log('すべて成功');
