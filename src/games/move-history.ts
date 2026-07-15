import { MoveHistoryEntry, PlayerColor } from './games.types';

// gomoku·othello 세션이 리플레이용 moveHistory 를 축적하기 위한 최소 인터페이스.
export interface MoveHistoryHolder {
  moveHistory?: MoveHistoryEntry[];
}

// black=0 / white=1 — createState 의 players 순서·finishInfo winnerSeat 매핑과 일치.
export function seatOfColor(color: PlayerColor): number {
  return color === 'black' ? 0 : 1;
}

// 착수 성공 직후 호출 — 인간/AI/타이머 자동 수 모두 엔진의 apply 함수를 통과하므로 한 곳에서 전부 잡힌다.
export function recordMove(holder: MoveHistoryHolder, color: PlayerColor, row: number, col: number, at: string): void {
  const history = (holder.moveHistory ??= []);
  history.push({ n: history.length, type: 'move', seat: seatOfColor(color), color, x: col, y: row, at });
}

// 오델로 강제 pass(상대가 둘 곳이 없어 턴이 넘어가지 않는 경우) 기록 — 보드 변화 없음, 재생 시 직전 스냅샷 유지.
export function recordPass(holder: MoveHistoryHolder, color: PlayerColor, at: string): void {
  const history = (holder.moveHistory ??= []);
  history.push({ n: history.length, type: 'pass', seat: seatOfColor(color), color, at });
}
