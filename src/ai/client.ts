import type { Color, Game } from '../core/game.ts';
import type { Level, Position, SearchResult } from './search.ts';
import type { ThinkRequest } from './worker.ts';

export function toPosition(g: Game): Position {
  const stones: Array<[number, number, Color]> = [];
  for (const [k, c] of g.board) {
    const i = k.indexOf(',');
    stones.push([Number(k.slice(0, i)), Number(k.slice(i + 1)), c]);
  }
  return { stones, stock: { ...g.stock }, turn: g.turn };
}

/** Web Worker 上の思考を Promise で呼ぶ。cancel() で考え中の結果を捨てる */
export class CpuClient {
  private worker = this.spawn();
  private seq = 0;
  private pending: { id: number; resolve: (r: SearchResult | null) => void } | null = null;

  private spawn(): Worker {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ id: number; result: SearchResult | null }>) => {
      if (this.pending && e.data.id === this.pending.id) {
        const p = this.pending;
        this.pending = null;
        p.resolve(e.data.result);
      }
    };
    return w;
  }

  think(game: Game, level: Level): Promise<SearchResult | null> {
    this.cancel();
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending = { id, resolve };
      const req: ThinkRequest = { id, pos: toPosition(game), level };
      this.worker.postMessage(req);
    });
  }

  /** 考え中なら Worker ごと止める（長考中でもすぐ新しい対局を始められるように） */
  cancel(): void {
    if (!this.pending) return;
    this.pending.resolve(null);
    this.pending = null;
    this.worker.terminate();
    this.worker = this.spawn();
  }
}
