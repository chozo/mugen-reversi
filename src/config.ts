// 見た目・操作・演出の調整値をまとめる

export const CONFIG = {
  view: {
    /** 初期表示で短辺に収めるマス数 */
    initialVisibleCells: 9,
    minCellPx: 4,
    maxCellPx: 160,
    /** これより小さいマスではグリッド線を薄くしていく */
    gridFadeCellPx: 14,
    dprMax: 2,
    /** 全体表示時の余白（マス） */
    fitPaddingCells: 1.5,
    cameraAnimMs: 280,
  },
  input: {
    /** これ以上動いたらタップではなくドラッグ扱い */
    tapSlopPx: 10,
    wheelZoomSpeed: 0.0015,
    keyPanPx: 80,
  },
  anim: {
    placeMs: 140,
    /** 置いた石からの距離1あたりの反転開始の遅れ */
    flipStepMs: 70,
    flipStartMs: 90,
    flipDurMs: 240,
  },
  cpu: {
    /** CPU が打つまでの最低の間（すぐ打つと何が起きたか分からないため） */
    minThinkMs: 450,
  },
  audio: {
    master: 0.8,
    bgm: 0.08,
    se: 0.9,
  },
  colors: {
    bg: "#f2f0e9",
    grid: "#cfcabd",
    black: "#1d1d1f",
    blackRim: "#4a4a4f",
    white: "#fbfbf8",
    whiteRim: "#8d897e",
    lastMove: "#e0483e",
    legalBlack: "rgba(29,29,31,0.22)",
    legalWhite: "rgba(120,116,104,0.35)",
    offscreenMarker: "rgba(224,72,62,0.75)",
    minimapBg: "rgba(255,255,255,0.82)",
    minimapFrame: "rgba(0,0,0,0.25)",
    minimapView: "rgba(224,72,62,0.9)",
  },
  minimap: {
    sizePx: 92,
    marginPx: 12,
  },
} as const;
