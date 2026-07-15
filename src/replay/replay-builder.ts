import { MoveHistoryEntry, PlayerColor } from '../games/games.types';
import { initialGomokuBoard } from '../games/gomoku-engine';
import { initialOthelloBoard, othelloFlips } from '../games/othello-engine';

// D4: 수 간격은 30초로 클램프하고 첫 수는 0 으로 재생한다.
export const REPLAY_DELAY_CLAMP_MS = 30000;

// games.service.ts 의 LOCAL_AI_ACCOUNT_ID sentinel 과 동일 (그쪽은 private 이라 값만 복제).
const LOCAL_AI_ACCOUNT_ID = '__game_platform_local_ai__';

export type ReplayGameKey = 'gomoku' | 'othello';
export type Cell = PlayerColor | null;
export type Board = Cell[][];

export interface ReplayMove {
  n: number;
  type: 'move' | 'pass';
  seat: number;
  color: PlayerColor;
  x?: number;
  y?: number;
  at: string;
  delayMs: number;
}

export function isReplayGameKey(value: unknown): value is ReplayGameKey {
  return value === 'gomoku' || value === 'othello';
}

export function isLocalAiSentinel(accountId: unknown): boolean {
  return (
    typeof accountId === 'string' &&
    (accountId === LOCAL_AI_ACCOUNT_ID || accountId.startsWith(`${LOCAL_AI_ACCOUNT_ID}#`))
  );
}

export function normalizeMoveHistory(value: unknown): MoveHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is MoveHistoryEntry => {
    return (
      Boolean(entry) &&
      typeof entry === 'object' &&
      (entry as MoveHistoryEntry).type !== undefined &&
      typeof (entry as MoveHistoryEntry).at === 'string'
    );
  });
}

/**
 * 각 수의 재생 지연(delayMs)을 계산한다 — 직전 수와의 실제 간격을 30초로 클램프하고 첫 수는 0.
 * pass 는 유발한 착수와 같은 타임스탬프를 갖도록 기록되므로 보통 delayMs≈0 이 된다.
 */
export function computeReplayMoves(moveHistory: MoveHistoryEntry[]): ReplayMove[] {
  let prevMs: number | null = null;
  return moveHistory.map((entry, index) => {
    const atMs = Date.parse(entry.at);
    let delayMs = 0;
    if (index > 0 && prevMs !== null && Number.isFinite(atMs)) {
      delayMs = Math.min(Math.max(atMs - prevMs, 0), REPLAY_DELAY_CLAMP_MS);
    }
    if (Number.isFinite(atMs)) {
      prevMs = atMs;
    }
    return {
      n: entry.n,
      type: entry.type,
      seat: entry.seat,
      color: entry.color,
      x: entry.x,
      y: entry.y,
      at: entry.at,
      delayMs,
    };
  });
}

function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

/**
 * moveHistory 를 엔진 로직으로 재생해 수별 보드 스냅샷을 재구성한다 (D4).
 * 오델로 뒤집기는 엔진의 othelloFlips 를 그대로 사용해 실제 게임과 정확히 일치시킨다.
 * pass 엔트리는 직전 보드를 그대로 복제한다. 반환 배열은 moveHistory 와 1:1 정렬된다.
 */
export function reconstructSnapshots(gameKey: ReplayGameKey, moveHistory: MoveHistoryEntry[]): Board[] {
  const board: Board = gameKey === 'gomoku' ? initialGomokuBoard() : initialOthelloBoard();
  return moveHistory.map((entry) => {
    if (entry.type === 'move' && typeof entry.x === 'number' && typeof entry.y === 'number') {
      if (gameKey === 'othello') {
        for (const [r, c] of othelloFlips(board, entry.y, entry.x, entry.color)) {
          board[r][c] = entry.color;
        }
      }
      board[entry.y][entry.x] = entry.color;
    }
    return cloneBoard(board);
  });
}

/**
 * 승자 표기 값을 정한다 (목록/상세 공통). state.winner 는 gomoku/othello 에서 색(black|white)이며
 * players[색] 이 실제 계정이다. AI sentinel 이면 'ai', 무승부(finishReason 'draw' 이며 winner 미설정)면
 * 'draw', 그 외 승자 미기록(server_restart/abandoned 등)이면 null.
 */
export function resolveReplayWinner(state: Record<string, unknown>): string | null {
  const players = state.players && typeof state.players === 'object' ? (state.players as Record<string, unknown>) : {};
  const winnerColor = typeof state.winner === 'string' ? state.winner : undefined;
  if (winnerColor) {
    const accountId = players[winnerColor];
    if (typeof accountId === 'string' && accountId) {
      return isLocalAiSentinel(accountId) ? 'ai' : accountId;
    }
    return null;
  }
  return state.finishReason === 'draw' ? 'draw' : null;
}
