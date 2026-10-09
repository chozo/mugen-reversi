import { CONFIG } from '../config.ts';

/**
 * 画面とワールド座標の変換。ワールド座標 1 = 1マス。
 * マス (x,y) は [x, x+1) × [y, y+1) を占める。
 */
export class Camera {
  /** 画面中央が指すワールド座標 */
  cx = 1;
  cy = 1;
  /** 1マスのピクセル数（CSSピクセル） */
  cell = 48;
  width = 1;
  height = 1;

  private anim: { from: [number, number, number]; to: [number, number, number]; start: number } | null = null;

  toScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.cx) * this.cell + this.width / 2, (wy - this.cy) * this.cell + this.height / 2];
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.cell + this.cx, (sy - this.height / 2) / this.cell + this.cy];
  }

  /** 画面上の点 (sx,sy) を含むマス */
  cellAt(sx: number, sy: number): [number, number] {
    const [wx, wy] = this.toWorld(sx, sy);
    return [Math.floor(wx), Math.floor(wy)];
  }

  pan(dx: number, dy: number): void {
    this.anim = null;
    this.cx -= dx / this.cell;
    this.cy -= dy / this.cell;
  }

  /** 画面上の点 (sx,sy) を固定したまま拡大縮小する */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.anim = null;
    const [wx, wy] = this.toWorld(sx, sy);
    this.cell = clamp(this.cell * factor, CONFIG.view.minCellPx, CONFIG.view.maxCellPx);
    this.cx = wx - (sx - this.width / 2) / this.cell;
    this.cy = wy - (sy - this.height / 2) / this.cell;
  }

  /** ワールド矩形が画面の安全領域（上下の余白を除く）に収まるように移動する */
  fit(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    inset: { top: number; bottom: number },
    animate: boolean,
  ): void {
    const pad = CONFIG.view.fitPaddingCells;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const availH = Math.max(80, this.height - inset.top - inset.bottom);
    const cell = clamp(Math.min(this.width / w, availH / h), CONFIG.view.minCellPx, CONFIG.view.maxCellPx);
    const cx = (minX + maxX) / 2;
    // 安全領域の中心に合わせるため、上下の余白差だけ中心をずらす
    const cy = (minY + maxY) / 2 - (inset.top - inset.bottom) / 2 / cell;
    if (animate) {
      this.anim = { from: [this.cx, this.cy, this.cell], to: [cx, cy, cell], start: performance.now() };
    } else {
      this.anim = null;
      this.cx = cx;
      this.cy = cy;
      this.cell = cell;
    }
  }

  centerOn(wx: number, wy: number): void {
    this.anim = { from: [this.cx, this.cy, this.cell], to: [wx, wy, this.cell], start: performance.now() };
  }

  /** カメラ移動アニメーションを進める。まだ動いていれば true */
  step(now: number): boolean {
    if (!this.anim) return false;
    const t = Math.min(1, (now - this.anim.start) / CONFIG.view.cameraAnimMs);
    const e = 1 - (1 - t) ** 3;
    const [fx, fy, fc] = this.anim.from;
    const [tx, ty, tc] = this.anim.to;
    // ズームは対数空間で補間すると自然に見える
    this.cell = Math.exp(Math.log(fc) + (Math.log(tc) - Math.log(fc)) * e);
    this.cx = fx + (tx - fx) * e;
    this.cy = fy + (ty - fy) * e;
    if (t >= 1) this.anim = null;
    return this.anim !== null;
  }

  get animating(): boolean {
    return this.anim !== null;
  }
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
