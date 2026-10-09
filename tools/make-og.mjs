// SNS でシェアされたときの画像（OGP, 1200×630）を作る。
// 実行: node tools/make-og.mjs   → public/og.png
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1200;
const H = 630;
const CELL = 54;

// 盤面の石（グリッドの列・行）。端ほど薄くする。中央の石はタイトルのパネルに隠れる
const stones = [
  [9, 4, 'B'], [10, 4, 'W'], [11, 5, 'B'], [12, 5, 'W'], [10, 5, 'B'], [11, 6, 'W'], [12, 6, 'B'], [13, 6, 'B'],
  [9, 6, 'W'], [8, 5, 'W'], [13, 4, 'W'], [14, 7, 'B'], [10, 7, 'B'], [7, 7, 'B'], [15, 5, 'W'], [11, 7, 'W'],
  [16, 4, 'B'], [6, 4, 'W'], [4, 6, 'B'], [18, 6, 'W'], [3, 3, 'W'], [19, 3, 'B'], [5, 9, 'W'], [17, 9, 'B'],
  // パネルの上下に見える石
  [8, 1, 'B'], [9, 1, 'W'], [10, 2, 'B'], [11, 1, 'B'], [12, 2, 'W'], [13, 1, 'W'], [7, 2, 'W'], [14, 2, 'B'], [11, 2, 'B'],
  [8, 9, 'B'], [9, 9, 'W'], [10, 10, 'W'], [11, 9, 'B'], [12, 9, 'B'], [13, 10, 'W'], [15, 9, 'W'], [6, 9, 'B'], [10, 9, 'B'],
];
const cols = Math.ceil(W / CELL) + 1;
const rows = Math.ceil(H / CELL) + 1;
let grid = '';
for (let x = 0; x < cols; x++) grid += `M${x * CELL + 0.5} 0V${H}`;
for (let y = 0; y < rows; y++) grid += `M0 ${y * CELL + 0.5}H${W}`;
const circles = stones
  .map(([x, y, c]) => {
    const cx = x * CELL + CELL / 2;
    const cy = y * CELL + CELL / 2;
    const d = Math.hypot((cx - W / 2) / (W / 2), (cy - H / 2) / (H / 2));
    const op = Math.max(0.12, Math.min(1, 1.3 - 1.1 * d));
    const fill = c === 'B' ? '#1d1d1f' : '#fbfbf8';
    const stroke = c === 'B' ? '#4a4a4f' : '#8d897e';
    return `<circle cx="${cx}" cy="${cy}" r="${CELL * 0.42}" fill="${fill}" stroke="${stroke}" stroke-width="2" opacity="${op.toFixed(2)}"/>`;
  })
  .join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: ${W}px; height: ${H}px; background: #f2f0e9; font-family: 'Hiragino Sans', 'Noto Sans JP', sans-serif; overflow: hidden; }
  svg { position: absolute; inset: 0; }
  .panel { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); padding: 40px 64px 36px;
    background: #fff; border-radius: 28px; white-space: nowrap; box-shadow: 0 16px 50px rgba(0,0,0,0.14); text-align: center; }
  .name { font-size: 104px; font-weight: 900; letter-spacing: 0.06em; color: #1d1d1f; line-height: 1.1; }
  .en { margin-top: 6px; font-size: 24px; font-weight: 700; letter-spacing: 0.4em; color: #6d695f; }
  .lead { margin-top: 22px; font-size: 30px; color: #1d1d1f; line-height: 1.5; }
  .lead b { color: #e0483e; }
</style></head><body>
  <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <defs>
      <radialGradient id="f" cx="50%" cy="50%" r="60%"><stop offset="0.35" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <mask id="m"><rect width="${W}" height="${H}" fill="url(#f)"/></mask>
    </defs>
    <path d="${grid}" stroke="#cfcabd" stroke-width="1.5" fill="none" mask="url(#m)"/>
    ${circles}
  </svg>
  <div class="panel">
    <div class="name">無限リバーシ</div>
    <div class="en">MUGEN REVERSI</div>
    <div class="lead">端のない盤面で、<b>32枚の石</b>を置いて戦うリバーシ</div>
  </div>
</body></html>`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: new URL('../public/og.png', import.meta.url).pathname });
await browser.close();
console.log('public/og.png');
