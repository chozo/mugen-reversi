import { CONFIG } from '../config.ts';
import { parseKey, type Color, type Move, type Pos } from '../core/game.ts';
import type { Camera } from './camera.ts';

/** 着手アニメーション。論理盤面は即座に更新し、表示だけ遅らせる */
export interface PlayAnim {
  start: number;
  /** 演出速度の倍率 */
  speed: number;
  placed: Pos & { color: Color };
  flips: Array<Pos & { from: Color; to: Color; delay: number }>;
  end: number;
}

export interface Scene {
  board: ReadonlyMap<string, Color>;
  turn: Color;
  legal: Move[];
  showLegal: boolean;
  lastMove: Pos | null;
  hover: Pos | null;
  anim: PlayAnim | null;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const C = CONFIG.colors;

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  /** 上部HUDに隠れる高さ。画面外マーカーをこの下に出す */
  insetTop = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly cam: Camera,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.view.dprMax);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.cam.width = w;
    this.cam.height = h;
  }

  draw(scene: Scene, now: number): void {
    const { ctx, cam } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, cam.width, cam.height);

    // 画面に見えているマスの範囲（この範囲だけを描く）
    const [wx0, wy0] = cam.toWorld(0, 0);
    const [wx1, wy1] = cam.toWorld(cam.width, cam.height);
    const x0 = Math.floor(wx0) - 1;
    const y0 = Math.floor(wy0) - 1;
    const x1 = Math.ceil(wx1) + 1;
    const y1 = Math.ceil(wy1) + 1;

    this.drawGrid(x0, y0, x1, y1);

    const cell = cam.cell;
    const r = cell * 0.42;

    if (scene.showLegal) {
      ctx.fillStyle = scene.turn === 'B' ? C.legalBlack : C.legalWhite;
      for (const m of scene.legal) {
        if (m.x < x0 || m.x > x1 || m.y < y0 || m.y > y1) continue;
        const [sx, sy] = cam.toScreen(m.x + 0.5, m.y + 0.5);
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(2, cell * 0.14), 0, Math.PI * 2);
        ctx.fill();
      }
      if (scene.hover) {
        const [sx, sy] = cam.toScreen(scene.hover.x + 0.5, scene.hover.y + 0.5);
        ctx.globalAlpha = 0.45;
        this.drawStone(sx, sy, r, 1, scene.turn);
        ctx.globalAlpha = 1;
      }
    }

    // アニメーション中の石の上書き表示
    const override = new Map<string, { color: Color; sx: number; scale: number }>();
    if (scene.anim) {
      const a = scene.anim;
      const t = (now - a.start) * a.speed;
      const pt = Math.min(1, Math.max(0, t / CONFIG.anim.placeMs));
      override.set(`${a.placed.x},${a.placed.y}`, { color: a.placed.color, sx: 1, scale: easeOutBack(pt) });
      for (const f of a.flips) {
        const p = Math.min(1, Math.max(0, (t - f.delay) / CONFIG.anim.flipDurMs));
        // 横方向につぶして、半分を過ぎたら色を変える（裏返しの表現）
        override.set(`${f.x},${f.y}`, {
          color: p < 0.5 ? f.from : f.to,
          sx: Math.max(0.06, Math.abs(Math.cos(p * Math.PI))),
          scale: 1 + 0.08 * Math.sin(p * Math.PI),
        });
      }
    }

    for (const [k, color] of scene.board) {
      const p = parseKey(k);
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      const [sx, sy] = cam.toScreen(p.x + 0.5, p.y + 0.5);
      const o = override.get(k);
      if (o) this.drawStone(sx, sy, r * o.scale, o.sx, o.color);
      else this.drawStone(sx, sy, r, 1, color);
    }

    if (scene.lastMove) {
      const [sx, sy] = cam.toScreen(scene.lastMove.x + 0.5, scene.lastMove.y + 0.5);
      ctx.fillStyle = C.lastMove;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(1.5, cell * 0.08), 0, Math.PI * 2);
      ctx.fill();
    }

    if (scene.showLegal) this.drawOffscreenMarkers(scene.legal);
    this.drawMinimap(scene);
  }

  private drawGrid(x0: number, y0: number, x1: number, y1: number): void {
    const { ctx, cam } = this;
    const cell = cam.cell;
    // 縮小時は線を薄くして、画面がグリッドで埋まらないようにする
    const alpha = Math.min(1, Math.max(0.15, (cell - 3) / (CONFIG.view.gridFadeCellPx - 3)));
    ctx.strokeStyle = C.grid;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const sx = Math.round(cam.toScreen(x, 0)[0]) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, cam.height);
    }
    for (let y = y0; y <= y1; y++) {
      const sy = Math.round(cam.toScreen(0, y)[1]) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(cam.width, sy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawStone(sx: number, sy: number, r: number, scaleX: number, color: Color): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(scaleX, 1);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(0, r), 0, Math.PI * 2);
    ctx.fillStyle = color === 'B' ? C.black : C.white;
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.strokeStyle = color === 'B' ? C.blackRim : C.whiteRim;
    ctx.stroke();
    ctx.restore();
  }

  /** 画面外にある合法手の方向を、画面端の小さな印で示す */
  private drawOffscreenMarkers(legal: Move[]): void {
    const { ctx, cam } = this;
    const m = 6;
    const top = this.insetTop;
    ctx.fillStyle = C.offscreenMarker;
    for (const mv of legal) {
      const [sx, sy] = cam.toScreen(mv.x + 0.5, mv.y + 0.5);
      if (sx >= 0 && sx <= cam.width && sy >= top && sy <= cam.height) continue;
      const cx = Math.min(cam.width - m, Math.max(m, sx));
      const cy = Math.min(cam.height - m, Math.max(top + m, sy));
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** ミニマップの矩形（画面座標） */
  minimapRect(): { x: number; y: number; size: number } {
    const { sizePx, marginPx } = CONFIG.minimap;
    return { x: this.cam.width - sizePx - marginPx, y: this.cam.height - sizePx - marginPx, size: sizePx };
  }

  /** ミニマップが表すワールド範囲（石の範囲を中心にした正方形） */
  private minimapWorld(scene: Scene) {
    const b = scene.bounds;
    const pad = 3;
    const span = Math.max(14, b.maxX - b.minX + 1 + pad * 2, b.maxY - b.minY + 1 + pad * 2);
    const cx = (b.minX + b.maxX + 1) / 2;
    const cy = (b.minY + b.maxY + 1) / 2;
    return { x: cx - span / 2, y: cy - span / 2, span };
  }

  /** 画面上の点がミニマップ内なら、対応するワールド座標を返す */
  minimapHit(sx: number, sy: number, scene: Scene): [number, number] | null {
    const r = this.minimapRect();
    if (sx < r.x || sx > r.x + r.size || sy < r.y || sy > r.y + r.size) return null;
    const w = this.minimapWorld(scene);
    return [w.x + ((sx - r.x) / r.size) * w.span, w.y + ((sy - r.y) / r.size) * w.span];
  }

  private drawMinimap(scene: Scene): void {
    const { ctx, cam } = this;
    const r = this.minimapRect();
    const w = this.minimapWorld(scene);
    const k = r.size / w.span;
    ctx.fillStyle = C.minimapBg;
    ctx.strokeStyle = C.minimapFrame;
    ctx.lineWidth = 1;
    roundRect(ctx, r.x, r.y, r.size, r.size, 8);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    roundRect(ctx, r.x, r.y, r.size, r.size, 8);
    ctx.clip();
    const s = Math.max(1.5, k);
    for (const [key, color] of scene.board) {
      const p = parseKey(key);
      ctx.fillStyle = color === 'B' ? C.black : C.whiteRim;
      ctx.fillRect(r.x + (p.x - w.x) * k, r.y + (p.y - w.y) * k, s, s);
    }
    const [vx0, vy0] = cam.toWorld(0, 0);
    const [vx1, vy1] = cam.toWorld(cam.width, cam.height);
    ctx.strokeStyle = C.minimapView;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(r.x + (vx0 - w.x) * k, r.y + (vy0 - w.y) * k, (vx1 - vx0) * k, (vy1 - vy0) * k);
    ctx.restore();
  }
}

function easeOutBack(t: number): number {
  const c = 1.7;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
