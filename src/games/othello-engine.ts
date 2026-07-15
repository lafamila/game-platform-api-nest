import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { Difficulty, GameMode, OthelloColor, OthelloSession } from './games.types';
import { recordMove, recordPass } from './move-history';

export const OTHELLO_SIZE = 8;
export const OTHELLO_STATE_VERSION = 1;

export const OTHELLO_ENGINE: GameEngine<OthelloSession> = {
  descriptor: {
    key: 'othello',
    title: 'Othello',
    minPlayers: 2,
    maxPlayers: 2,
    modes: ['local_ai', 'friend_match'],
    turnType: 'turnBased',
    hiddenInfo: false,
    supportsAi: true,
    supportsMatchSave: true,
    turnTimerSeconds: 20,
    graceSeconds: 60,
    status: 'playable',
  },
  stateVersion: OTHELLO_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): OthelloSession {
    const now = new Date().toISOString();
    return {
      id: typeof config.id === 'string' ? config.id : '',
      mode: othelloModeFromConfig(config.mode),
      aiDifficulty: othelloDifficultyFromConfig(config.aiDifficulty),
      board: initialOthelloBoard(),
      currentTurn: 'black',
      status: 'playing',
      players: {
        black: players[0]?.accountId ?? '',
        white: players[1]?.accountId ?? '',
      },
      moves: [],
      moveHistory: [],
      createdAt: now,
      updatedAt: now,
    };
  },
  applyAction(state: OthelloSession, seat: number, action: GameAction) {
    if (action.type !== 'move') {
      throw new BadRequestException('unsupported othello action');
    }
    const color: OthelloColor = seat === 0 ? 'black' : 'white';
    const accountId = state.players[color];
    if (!accountId) {
      throw new BadRequestException('othello player is missing');
    }
    const payload = action.payload ?? {};
    applyOthelloMove(state, accountId, Number(payload.row), Number(payload.col), 'manual');
    return { state };
  },
  viewFor(state: OthelloSession) {
    return state;
  },
  finishInfo(state: OthelloSession) {
    if (state.status !== 'finished') {
      return null;
    }
    const winnerSeat = state.winner === 'black' ? 0 : state.winner === 'white' ? 1 : undefined;
    return { status: 'finished', winnerSeat, reason: state.finishReason };
  },
  aiAction(state: OthelloSession) {
    const move = chooseOthelloAiMove(state);
    return { type: 'move', payload: move ?? {} };
  },
};

function othelloModeFromConfig(value: unknown): GameMode {
  return value === 'friend_match' ? 'friend_match' : 'local_ai';
}

function othelloDifficultyFromConfig(value: unknown): Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
}

export function initialOthelloBoard(): (OthelloColor | null)[][] {
  const board: (OthelloColor | null)[][] = Array.from({ length: OTHELLO_SIZE }, () =>
    Array.from({ length: OTHELLO_SIZE }, () => null as OthelloColor | null),
  );
  board[3][3] = 'white';
  board[3][4] = 'black';
  board[4][3] = 'black';
  board[4][4] = 'white';
  return board;
}

export function oppositeOthello(color: OthelloColor): OthelloColor {
  return color === 'black' ? 'white' : 'black';
}

export function othelloFlips(
  board: (OthelloColor | null)[][],
  row: number,
  col: number,
  color: OthelloColor,
): Array<[number, number]> {
  if (board[row]?.[col] !== null) {
    return [];
  }
  const enemy = oppositeOthello(color);
  const flips: Array<[number, number]> = [];
  for (const [dr, dc] of [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, -1],
    [0, 1],
    [1, -1],
    [1, 0],
    [1, 1],
  ]) {
    const line: Array<[number, number]> = [];
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < OTHELLO_SIZE && c >= 0 && c < OTHELLO_SIZE && board[r][c] === enemy) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }
    if (
      line.length > 0 &&
      r >= 0 &&
      r < OTHELLO_SIZE &&
      c >= 0 &&
      c < OTHELLO_SIZE &&
      board[r][c] === color
    ) {
      flips.push(...line);
    }
  }
  return flips;
}

export function othelloLegalMoves(
  board: (OthelloColor | null)[][],
  color: OthelloColor,
): Array<{ row: number; col: number; flips: number }> {
  const moves: Array<{ row: number; col: number; flips: number }> = [];
  for (let row = 0; row < OTHELLO_SIZE; row += 1) {
    for (let col = 0; col < OTHELLO_SIZE; col += 1) {
      const flips = othelloFlips(board, row, col, color).length;
      if (flips > 0) {
        moves.push({ row, col, flips });
      }
    }
  }
  return moves;
}

export function applyOthelloMove(
  session: OthelloSession,
  accountId: string,
  row: number,
  col: number,
  source: 'manual' | 'timeout' | 'ai',
): void {
  const color = session.currentTurn;
  const flips = othelloFlips(session.board, row, col, color);
  if (flips.length === 0) {
    throw new BadRequestException('not a legal othello move');
  }
  const at = new Date().toISOString();
  session.board[row][col] = color;
  for (const [r, c] of flips) {
    session.board[r][c] = color;
  }
  session.moves.push({
    row,
    col,
    color,
    accountId,
    flipped: flips.length,
    createdAt: at,
    source,
  });
  recordMove(session, color, row, col, at);
  const next = oppositeOthello(color);
  if (othelloLegalMoves(session.board, next).length > 0) {
    session.currentTurn = next;
  } else if (othelloLegalMoves(session.board, color).length > 0) {
    // 상대(next)가 둘 곳이 없어 턴이 넘어가지 않는다 = next 의 강제 pass. 재생 정확성을 위해 기록한다.
    session.currentTurn = color;
    recordPass(session, next, at);
  } else {
    finishOthello(session);
  }
  session.updatedAt = new Date().toISOString();
}

export function finishOthello(session: OthelloSession): void {
  const score = othelloScore(session.board);
  session.status = 'finished';
  session.finishReason = score.black === score.white ? 'draw' : 'board_complete';
  if (score.black !== score.white) {
    session.winner = score.black > score.white ? 'black' : 'white';
  }
}

export function othelloScore(board: (OthelloColor | null)[][]): Record<OthelloColor, number> {
  let black = 0;
  let white = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === 'black') black += 1;
      if (cell === 'white') white += 1;
    }
  }
  return { black, white };
}

export function chooseOthelloAiMove(session: OthelloSession): { row: number; col: number } | undefined {
  const moves = othelloLegalMoves(session.board, session.currentTurn);
  if (moves.length === 0) {
    return undefined;
  }
  const difficulty = session.aiDifficulty ?? 'medium';
  if (difficulty === 'easy') {
    return moves[Math.floor(Math.random() * moves.length)];
  }
  const scored = moves
    .map((move) => {
      const corner = (move.row === 0 || move.row === 7) && (move.col === 0 || move.col === 7) ? 20 : 0;
      const edge = move.row === 0 || move.row === 7 || move.col === 0 || move.col === 7 ? 4 : 0;
      return { ...move, score: move.flips + corner + edge };
    })
    .sort((a, b) => b.score - a.score);
  if (difficulty === 'medium' && Math.random() < 0.28) {
    return scored[Math.floor(Math.random() * Math.min(scored.length, 3))];
  }
  return scored[0];
}
