// コンピュータの思考を別スレッドで行い、画面を止めないようにする
import { chooseMove, type Level, type Position } from './search.ts';

export interface ThinkRequest {
  id: number;
  pos: Position;
  level: Level;
}

self.onmessage = (e: MessageEvent<ThinkRequest>) => {
  const { id, pos, level } = e.data;
  self.postMessage({ id, result: chooseMove(pos, level) });
};
