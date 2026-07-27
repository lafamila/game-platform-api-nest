import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { Difficulty, GameMode, GomokuSession, PlayerColor } from './games.types';
import { ForbiddenReason, getForbiddenReason, isExactFive } from './gomoku-rules';
import { recordMove } from './move-history';

export const GOMOKU_SIZE = 15;
export const GOMOKU_AI_BUDGET_MS = 900;
export const GOMOKU_STATE_VERSION = 1;

// Flutter 가 부분매칭하는 계약 문구 — 절대 변경 금지.
export const GOMOKU_FORBIDDEN_MESSAGES: Record<ForbiddenReason, string> = {
  'double-three': 'forbidden move for black: double-three (삼삼)',
  'double-four': 'forbidden move for black: double-four (사사)',
  overline: 'forbidden move for black: overline (장목)',
};

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
      moveHistory: [],
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
  viewFor(state: GomokuSession, viewer) {
    const viewerAccountId =
      viewer === 0
        ? state.players.black
        : viewer === 1
          ? state.players.white
          : undefined;
    if (!state.pendingMove || state.pendingMove.accountId === viewerAccountId) {
      return state;
    }
    return { ...state, pendingMove: undefined };
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
  if (color === 'black') {
    const reason = getForbiddenReason(session.board, row, col);
    if (reason) {
      throw new BadRequestException(GOMOKU_FORBIDDEN_MESSAGES[reason]);
    }
  }
  const at = new Date().toISOString();
  delete session.pendingMove;
  session.board[row][col] = color;
  session.moves.push({ row, col, color, accountId, createdAt: at, source });
  recordMove(session, color, row, col, at);
  if (isExactFive(session.board, row, col, color)) {
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

export function chooseGomokuAiMove(
  session: GomokuSession,
  difficulty: Difficulty,
  deadlineMs = Date.now() + GOMOKU_AI_BUDGET_MS,
): GomokuAiMove | undefined {
  const ai = session.currentTurn;
  const opponent = oppositeGomokuColor(ai);
  const winNow = findImmediateGomokuMove(session.board, ai);
  if (winNow) return winNow; // an exact five is never a forbidden move
  if (Date.now() >= deadlineMs) return safeGomokuFallback(session.board, ai);
  const blockNow = findImmediateGomokuMove(session.board, opponent);
  if (blockNow && isPlayableGomokuMove(session.board, ai, blockNow) && (difficulty !== 'easy' || Math.random() < 0.7)) {
    return blockNow;
  }
  if (Date.now() >= deadlineMs) return safeGomokuFallback(session.board, ai);

  const ranked = filterPlayableGomokuMoves(session.board, ai, rankedGomokuCandidates(session.board, ai, difficulty));
  if (ranked.length === 0) return safeGomokuFallback(session.board, ai);
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
    const score = isExactFive(session.board, move.row, move.col, ai)
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
    return ranked[0] ?? safeGomokuFallback(session.board, ai);
  }
  const pool = difficulty === 'medium' ? best.slice(0, 3) : best;
  return pool[Math.floor(Math.random() * pool.length)];
}

// 흑은 금수(삼삼·사사·장목)를 둘 수 없으므로 후보에서 배제한다. 백은 제약이 없어 그대로 통과.
function isPlayableGomokuMove(board: (PlayerColor | null)[][], color: PlayerColor, move: GomokuAiMove): boolean {
  return color !== 'black' || getForbiddenReason(board, move.row, move.col) === null;
}

function filterPlayableGomokuMoves(
  board: (PlayerColor | null)[][],
  color: PlayerColor,
  moves: GomokuAiMove[],
): GomokuAiMove[] {
  return color === 'black' ? moves.filter((move) => isPlayableGomokuMove(board, color, move)) : moves;
}

// 예산 소진/후보 소진 시의 폴백. 흑이면 금수가 아닌 빈칸을 우선한다(백은 무제한 랜덤 — 기존 동작 동일).
function safeGomokuFallback(board: (PlayerColor | null)[][], color: PlayerColor): GomokuAiMove | undefined {
  const empty = availableGomokuCells(board);
  if (empty.length === 0) return undefined;
  const legal = color === 'black' ? empty.filter(([row, col]) => getForbiddenReason(board, row, col) === null) : empty;
  const pool = legal.length > 0 ? legal : empty;
  const [row, col] = pool[Math.floor(Math.random() * pool.length)];
  return { row, col };
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
    const score = isExactFive(board, move.row, move.col, current)
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
      const attack = isExactFive(board, move.row, move.col, color) ? 9_000_000 : evaluateGomokuBoard(board, color);
      board[move.row][move.col] = opponent;
      const defense = isExactFive(board, move.row, move.col, opponent) ? 8_000_000 : evaluateGomokuBoard(board, opponent) * 0.82;
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
    const wins = isExactFive(board, move.row, move.col, color);
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
