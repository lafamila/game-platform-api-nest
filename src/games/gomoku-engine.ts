import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { Difficulty, GameMode, GomokuSession, PlayerColor } from './games.types';

export const GOMOKU_SIZE = 15;
export const GOMOKU_AI_BUDGET_MS = 900;
export const GOMOKU_STATE_VERSION = 1;

export interface GomokuAiMove {
  row: number;
  col: number;
}

export const GOMOKU_ENGINE: GameEngine<GomokuSession> = {
  descriptor: {
    key: 'gomoku',
    title: 'Gomoku',
    minPlayers: 2,
    maxPlayers: 2,
    modes: ['local_ai', 'friend_match'],
    turnType: 'turnBased',
    hiddenInfo: false,
    supportsAi: true,
    supportsMatchSave: true,
    turnTimerSeconds: 15,
    graceSeconds: 60,
    status: 'playable',
  },
  stateVersion: GOMOKU_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): GomokuSession {
    const now = new Date().toISOString();
    return {
      id: typeof config.id === 'string' ? config.id : '',
      mode: gomokuModeFromConfig(config.mode),
      aiDifficulty: gomokuDifficultyFromConfig(config.aiDifficulty),
      board: initialGomokuBoard(),
      currentTurn: 'black',
      status: 'playing',
      players: {
        black: players[0]?.accountId ?? '',
        white: players[1]?.accountId ?? '',
      },
      moves: [],
      createdAt: now,
      updatedAt: now,
    };
  },
  applyAction(state: GomokuSession, seat: number, action: GameAction) {
    if (action.type !== 'move') {
      throw new BadRequestException('unsupported gomoku action');
    }
    const color: PlayerColor = seat === 0 ? 'black' : 'white';
    if (state.currentTurn !== color) {
      throw new BadRequestException('not your turn');
    }
    const accountId = state.players[color];
    if (!accountId) {
      throw new BadRequestException('gomoku player is missing');
    }
    const payload = action.payload ?? {};
    applyGomokuMove(state, accountId, Number(payload.row), Number(payload.col), 'manual');
    return { state };
  },
  viewFor(state: GomokuSession) {
    return state;
  },
  finishInfo(state: GomokuSession) {
    if (state.status !== 'finished') {
      return null;
    }
    const winnerSeat = state.winner === 'black' ? 0 : state.winner === 'white' ? 1 : undefined;
    return { status: 'finished', winnerSeat, reason: state.finishReason };
  },
  aiAction(state: GomokuSession) {
    const move = chooseGomokuAiMove(state, state.aiDifficulty ?? 'medium');
    return { type: 'move', payload: move ?? {} };
  },
};

function gomokuModeFromConfig(value: unknown): GameMode {
  return value === 'friend_match' ? 'friend_match' : 'local_ai';
}

function gomokuDifficultyFromConfig(value: unknown): Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
}

export function initialGomokuBoard(): (PlayerColor | null)[][] {
  return Array.from({ length: GOMOKU_SIZE }, () =>
    Array.from({ length: GOMOKU_SIZE }, () => null as PlayerColor | null),
  );
}

export function validateGomokuIndex(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= GOMOKU_SIZE) {
    throw new BadRequestException(`${name} must be an integer from 0 to ${GOMOKU_SIZE - 1}`);
  }
}

export function applyGomokuMove(
  session: GomokuSession,
  accountId: string,
  row: number,
  col: number,
  source: 'manual' | 'timeout' | 'ai',
): void {
  validateGomokuIndex(row, 'row');
  validateGomokuIndex(col, 'col');
  if (session.board[row][col] !== null) {
    throw new BadRequestException('cell is already occupied');
  }
  const color = session.currentTurn;
  session.board[row][col] = color;
  session.moves.push({ row, col, color, accountId, createdAt: new Date().toISOString(), source });
  if (hasFive(session.board, row, col, color)) {
    session.status = 'finished';
    session.winner = color;
    session.finishReason = source === 'timeout' ? 'timeout_random_win' : undefined;
  } else if (session.board.every((boardRow) => boardRow.every((cell) => cell !== null))) {
    session.status = 'finished';
    session.finishReason = 'draw';
  } else {
    session.currentTurn = oppositeGomokuColor(color);
  }
  session.updatedAt = new Date().toISOString();
}

export function hasFive(board: (PlayerColor | null)[][], row: number, col: number, color: PlayerColor): boolean {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  return directions.some(([dr, dc]) => 1 + count(board, row, col, dr, dc, color) + count(board, row, col, -dr, -dc, color) >= 5);
}

function count(board: (PlayerColor | null)[][], row: number, col: number, dr: number, dc: number, color: PlayerColor): number {
  let total = 0;
  let currentRow = row + dr;
  let currentCol = col + dc;
  while (
    currentRow >= 0 &&
    currentRow < GOMOKU_SIZE &&
    currentCol >= 0 &&
    currentCol < GOMOKU_SIZE &&
    board[currentRow][currentCol] === color
  ) {
    total += 1;
    currentRow += dr;
    currentCol += dc;
  }
  return total;
}

export function chooseGomokuAiMove(
  session: GomokuSession,
  difficulty: Difficulty,
  deadlineMs = Date.now() + GOMOKU_AI_BUDGET_MS,
): GomokuAiMove | undefined {
  const ai = session.currentTurn;
  const opponent = oppositeGomokuColor(ai);
  const winNow = findImmediateGomokuMove(session.board, ai);
  if (winNow) return winNow;
  if (Date.now() >= deadlineMs) return randomGomokuMove(session.board);
  const blockNow = findImmediateGomokuMove(session.board, opponent);
  if (blockNow && (difficulty !== 'easy' || Math.random() < 0.7)) return blockNow;
  if (Date.now() >= deadlineMs) return randomGomokuMove(session.board);

  const ranked = rankedGomokuCandidates(session.board, ai, difficulty);
  if (ranked.length === 0) return undefined;
  if (difficulty === 'easy') {
    const loosePool = ranked.slice(0, Math.min(ranked.length, 10));
    return loosePool[Math.floor(Math.random() * loosePool.length)];
  }

  const depth = difficulty === 'hard' ? 3 : 2;
  const limit = difficulty === 'hard' ? 18 : 12;
  let bestScore = Number.NEGATIVE_INFINITY;
  const best: GomokuAiMove[] = [];
  for (const move of ranked.slice(0, limit)) {
    if (Date.now() >= deadlineMs) break;
    session.board[move.row][move.col] = ai;
    const score = hasFive(session.board, move.row, move.col, ai)
      ? 10_000_000
      : gomokuMinimax(session.board, opponent, ai, depth - 1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, deadlineMs);
    session.board[move.row][move.col] = null;
    if (score > bestScore) {
      bestScore = score;
      best.length = 0;
      best.push(move);
    } else if (score === bestScore) {
      best.push(move);
    }
  }
  if (best.length === 0) {
    return ranked[0] ?? randomGomokuMove(session.board);
  }
  const pool = difficulty === 'medium' ? best.slice(0, 3) : best;
  return pool[Math.floor(Math.random() * pool.length)];
}

function gomokuMinimax(
  board: (PlayerColor | null)[][],
  current: PlayerColor,
  ai: PlayerColor,
  depth: number,
  alpha: number,
  beta: number,
  deadlineMs: number,
): number {
  if (depth <= 0 || Date.now() >= deadlineMs) {
    return evaluateGomokuBoard(board, ai);
  }
  const candidates = rankedGomokuCandidates(board, current, 'medium').slice(0, 14);
  if (candidates.length === 0) {
    return evaluateGomokuBoard(board, ai);
  }
  const maximizing = current === ai;
  let best = maximizing ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const next = oppositeGomokuColor(current);
  for (const move of candidates) {
    if (Date.now() >= deadlineMs) break;
    board[move.row][move.col] = current;
    const score = hasFive(board, move.row, move.col, current)
      ? (maximizing ? 10_000_000 + depth : -10_000_000 - depth)
      : gomokuMinimax(board, next, ai, depth - 1, alpha, beta, deadlineMs);
    board[move.row][move.col] = null;
    if (maximizing) {
      best = Math.max(best, score);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, score);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }
  return best;
}

export function randomGomokuMove(board: (PlayerColor | null)[][]): GomokuAiMove | undefined {
  const empty = availableGomokuCells(board);
  if (empty.length === 0) return undefined;
  const [row, col] = empty[Math.floor(Math.random() * empty.length)];
  return { row, col };
}

function rankedGomokuCandidates(board: (PlayerColor | null)[][], color: PlayerColor, difficulty: Difficulty): GomokuAiMove[] {
  const candidates = gomokuCandidateCells(board, difficulty === 'hard' ? 2 : 1);
  const opponent = oppositeGomokuColor(color);
  return candidates
    .map((move) => {
      board[move.row][move.col] = color;
      const attack = hasFive(board, move.row, move.col, color) ? 9_000_000 : evaluateGomokuBoard(board, color);
      board[move.row][move.col] = opponent;
      const defense = hasFive(board, move.row, move.col, opponent) ? 8_000_000 : evaluateGomokuBoard(board, opponent) * 0.82;
      board[move.row][move.col] = null;
      const center = 7 - Math.abs(move.row - 7) - Math.abs(move.col - 7) * 0.08;
      return { ...move, score: attack + defense + center + Math.random() * (difficulty === 'easy' ? 900 : 4) };
    })
    .sort((left, right) => right.score - left.score)
    .map(({ row, col }) => ({ row, col }));
}

function gomokuCandidateCells(board: (PlayerColor | null)[][], radius: number): GomokuAiMove[] {
  const occupied: GomokuAiMove[] = [];
  for (let row = 0; row < GOMOKU_SIZE; row += 1) {
    for (let col = 0; col < GOMOKU_SIZE; col += 1) {
      if (board[row][col] !== null) occupied.push({ row, col });
    }
  }
  if (occupied.length === 0) {
    return [{ row: 7, col: 7 }];
  }
  const seen = new Set<string>();
  const cells: GomokuAiMove[] = [];
  for (const stone of occupied) {
    for (let row = Math.max(0, stone.row - radius); row <= Math.min(GOMOKU_SIZE - 1, stone.row + radius); row += 1) {
      for (let col = Math.max(0, stone.col - radius); col <= Math.min(GOMOKU_SIZE - 1, stone.col + radius); col += 1) {
        const key = `${row}:${col}`;
        if (board[row][col] === null && !seen.has(key)) {
          seen.add(key);
          cells.push({ row, col });
        }
      }
    }
  }
  return cells.length === 0 ? availableGomokuCells(board).map(([row, col]) => ({ row, col })) : cells;
}

function findImmediateGomokuMove(board: (PlayerColor | null)[][], color: PlayerColor): GomokuAiMove | undefined {
  for (const move of gomokuCandidateCells(board, 1)) {
    board[move.row][move.col] = color;
    const wins = hasFive(board, move.row, move.col, color);
    board[move.row][move.col] = null;
    if (wins) return move;
  }
  return undefined;
}

function evaluateGomokuBoard(board: (PlayerColor | null)[][], ai: PlayerColor): number {
  let score = 0;
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (let row = 0; row < GOMOKU_SIZE; row += 1) {
    for (let col = 0; col < GOMOKU_SIZE; col += 1) {
      for (const [dr, dc] of directions) {
        const endRow = row + dr * 4;
        const endCol = col + dc * 4;
        if (endRow < 0 || endRow >= GOMOKU_SIZE || endCol < 0 || endCol >= GOMOKU_SIZE) continue;
        let own = 0;
        let enemy = 0;
        for (let step = 0; step < 5; step += 1) {
          const cell = board[row + dr * step][col + dc * step];
          if (cell === ai) own += 1;
          else if (cell !== null) enemy += 1;
        }
        score += gomokuWindowScore(own, enemy);
      }
    }
  }
  return score;
}

function gomokuWindowScore(own: number, enemy: number): number {
  if (own > 0 && enemy > 0) return 0;
  if (own === 5) return 10_000_000;
  if (enemy === 5) return -10_000_000;
  const values = [0, 12, 120, 1_400, 75_000, 10_000_000];
  if (own > 0) return values[own];
  if (enemy > 0) return -values[enemy] * 1.08;
  return 0;
}

export function oppositeGomokuColor(color: PlayerColor): PlayerColor {
  return color === 'black' ? 'white' : 'black';
}

export function availableGomokuCells(board: (PlayerColor | null)[][]): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      if (board[row][col] === null) {
        cells.push([row, col]);
      }
    }
  }
  return cells;
}
