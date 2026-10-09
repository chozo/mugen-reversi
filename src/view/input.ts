import { CONFIG } from '../config.ts';
import type { Camera } from './camera.ts';

export interface InputHandlers {
  /** 移動せずに離したとき（1本指・左クリック） */
  onTap(sx: number, sy: number): void;
  /** マウスの位置（ホバー表示用）。盤外に出たら null */
  onHover(sx: number, sy: number): void;
  onHoverEnd(): void;
  /** カメラが動いたとき */
  onCameraChange(): void;
}

/**
 * ドラッグ移動・ピンチ拡大・ホイール拡大・タップを扱う。
 * 指の本数が何本でも「重心の移動 = パン」「指の広がりの比 = ズーム」で統一的に処理する。
 */
export function attachInput(el: HTMLElement, cam: Camera, h: InputHandlers): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let prev: { x: number; y: number; spread: number } | null = null;
  // 現在のジェスチャーがタップになり得るか
  let tapCandidate = false;
  let downAt = { x: 0, y: 0 };

  const local = (e: PointerEvent | WheelEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const summary = () => {
    let x = 0;
    let y = 0;
    for (const p of pointers.values()) {
      x += p.x;
      y += p.y;
    }
    x /= pointers.size;
    y /= pointers.size;
    let spread = 0;
    for (const p of pointers.values()) spread += Math.hypot(p.x - x, p.y - y);
    return { x, y, spread: spread / pointers.size };
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      tapCandidate = true;
      downAt = p;
    } else {
      tapCandidate = false;
    }
    prev = summary();
  });

  el.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') h.onHover(p.x, p.y);
      return;
    }
    pointers.set(e.pointerId, p);
    if (tapCandidate && Math.hypot(p.x - downAt.x, p.y - downAt.y) > CONFIG.input.tapSlopPx) tapCandidate = false;
    if (tapCandidate) return; // わずかな指のぶれで盤面が動かないようにする
    const cur = summary();
    if (prev) {
      cam.pan(cur.x - prev.x, cur.y - prev.y);
      if (pointers.size >= 2 && prev.spread > 0 && cur.spread > 0) cam.zoomAt(cur.x, cur.y, cur.spread / prev.spread);
      h.onCameraChange();
    }
    prev = cur;
    if (e.pointerType === 'mouse') h.onHover(p.x, p.y);
  });

  const end = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    pointers.delete(e.pointerId);
    if (e.type === 'pointerup' && tapCandidate && pointers.size === 0) h.onTap(p.x, p.y);
    if (pointers.size === 0) tapCandidate = false;
    prev = pointers.size > 0 ? summary() : null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !pointers.has(e.pointerId)) h.onHoverEnd();
  });

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      // deltaMode 1 は行単位（Firefox など）
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // トラックパッドのピンチは ctrlKey 付きの wheel として届くので強めに効かせる
      const speed = CONFIG.input.wheelZoomSpeed * (e.ctrlKey ? 6 : 1);
      cam.zoomAt(p.x, p.y, Math.exp(-dy * speed));
      h.onCameraChange();
    },
    { passive: false },
  );

  // Safari のジェスチャーイベントによるページ拡大を止める
  el.addEventListener('gesturestart', (e) => e.preventDefault());
}
