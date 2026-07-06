import { BadRequestException } from '@nestjs/common';
import { GameAction, GameEngine, SeatInfo } from './engine/game-engine';
import { createSudoku, isSolvedSudoku } from './sudoku-generator';
import { Difficulty, GameMode, SudokuBattleState, SudokuProgress, SudokuSession, SudokuSide } from './games.types';

const SUDOKU_SIZE = 9;
const SUDOKU_OBSCURE_MS = 5_000;
export const SUDOKU_STATE_VERSION = 1;

export const SUDOKU_ENGINE: GameEngine<SudokuSession> = {
  descriptor: {
    key: 'sudoku',
    title: 'Sudoku',
    minPlayers: 1,
    maxPlayers: 6,
    modes: ['solo', 'friend_match'],
    turnType: 'simultaneous',
    hiddenInfo: true,
    supportsAi: true,
    supportsMatchSave: true,
    status: 'playable',
  },
  stateVersion: SUDOKU_STATE_VERSION,
  createState(players: SeatInfo[], config: Record<string, unknown>): SudokuSession {
    const difficulty = sudokuDifficultyFromConfig(config.difficulty);
    const generated = createSudoku(difficulty);
    return createSudokuSessionState({
      id: typeof config.id === 'string' ? config.id : '',
      mode: sudokuModeFromConfig(config.mode, players.length),
      ownerAccountId: players[0]?.accountId ?? '',
      difficulty,
      puzzle: generated.puzzle,
      solution: generated.solution,
      players: players.length > 1 ? sudokuPlayersFromSeats(players) : undefined,
    });
  },
  applyAction(state: SudokuSession, seat: number, action: GameAction) {
    if (action.type === 'set_cell') {
      const side = state.players ? sudokuSides(state)[seat] : undefined;
      applySudokuCell(state, side, Number(action.payload?.row), Number(action.payload?.col), Number(action.payload?.value));
      return { state };
    }
    if (action.type === 'submit') {
      const side = state.players ? sudokuSides(state)[seat] : undefined;
      submitSudokuState(state, side);
      return { state };
    }
    throw new BadRequestException('unsupported sudoku action');
  },
  viewFor(state: SudokuSession, seat: number | 'spectator') {
    if (seat === 'spectator' || !state.players) {
      return hideSudokuSolutionForAccount(state);
    }
    const side = sudokuSides(state)[seat];
    return hideSudokuSolutionForSide(state, side);
  },
  finishInfo(state: SudokuSession) {
    if (state.status !== 'finished' && state.status !== 'cleared') {
      return null;
    }
    const side = state.winnerSide;
    const winnerSeat = side ? sudokuSides(state).indexOf(side) : undefined;
    return {
      status: state.status,
      winnerSeat: winnerSeat === -1 ? undefined : winnerSeat,
      reason: state.finishReason,
    };
  },
};

function sudokuModeFromConfig(value: unknown, playerCount: number): GameMode {
  if (value === 'friend_match' || playerCount > 1) return 'friend_match';
  return 'solo';
}

function sudokuDifficultyFromConfig(value: unknown): Difficulty {
  return value === 'easy' || value === 'medium' || value === 'hard' ? value : 'medium';
}

function sudokuPlayersFromSeats(players: SeatInfo[]): Record<SudokuSide, string> {
  return Object.fromEntries(
    players.map((player, index) => [
      index === 0 ? 'challenger' : index === 1 ? 'opponent' : `seat${index}`,
      player.accountId ?? '',
    ]),
  );
}

export function createSudokuSessionState(input: {
  id: string;
  mode: GameMode;
  ownerAccountId: string;
  difficulty: Difficulty;
  puzzle: number[][];
  solution: number[][];
  players?: Record<SudokuSide, string>;
}): SudokuSession {
  const board = cloneSudokuGrid(input.puzzle);
  const session: SudokuSession = {
    id: input.id,
    mode: input.mode,
    ownerAccountId: input.ownerAccountId,
    difficulty: input.difficulty,
    puzzle: cloneSudokuGrid(input.puzzle),
    board,
    solution: cloneSudokuGrid(input.solution),
    status: 'playing',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (input.players) {
    session.players = { ...input.players };
    session.boards = Object.fromEntries(
      Object.keys(input.players).map((side) => [side, cloneSudokuGrid(board)]),
    ) as Record<SudokuSide, number[][]>;
    session.progress = createSudokuProgressMap(session);
    session.battle = createSudokuBattleMap(session);
  }
  return session;
}

export function applySudokuCell(
  session: SudokuSession,
  side: SudokuSide | undefined,
  row: number,
  col: number,
  value: number,
): void {
  validateSudokuIndex(row, 'row');
  validateSudokuIndex(col, 'col');
  if (!Number.isInteger(value) || value < 0 || value > 9) {
    throw new BadRequestException('value must be an integer from 0 to 9');
  }
  if (session.puzzle[row][col] !== 0) {
    throw new BadRequestException('given cells cannot be changed');
  }
  const board = side ? ensureSudokuPlayerBoard(session, side) : session.board;
  board[row][col] = value;
  if (side) {
    session.boards![side] = board;
    applySudokuBattleMove(session, side);
    session.progress = createSudokuProgressMap(session);
    session.board = board;
  } else {
    session.board = board;
  }
  session.updatedAt = new Date().toISOString();
}

export function submitSudokuState(session: SudokuSession, side: SudokuSide | undefined): boolean {
  const currentBoard = side ? ensureSudokuPlayerBoard(session, side) : session.board;
  const solved = isSolvedSudoku(currentBoard, session.solution);
  if (side) {
    if (solved) {
      session.status = 'finished';
      session.winnerSide = side;
      session.winnerAccountId = session.players?.[side];
      session.finishReason = 'sudoku_first_clear';
    }
  } else {
    session.status = solved ? 'cleared' : 'failed';
    if (solved) {
      session.clearedAt = new Date().toISOString();
    }
  }
  session.updatedAt = new Date().toISOString();
  return solved;
}

export function hideSudokuSolutionForAccount(session: SudokuSession, accountId?: string): Omit<SudokuSession, 'solution'> {
  if (!session.players || !accountId) {
    const { solution: _solution, ...visible } = session;
    return visible;
  }
  const side = sudokuSideForAccount(session, accountId) ?? 'challenger';
  return hideSudokuSolutionForSide(session, side);
}

function hideSudokuSolutionForSide(session: SudokuSession, side: SudokuSide): Omit<SudokuSession, 'solution'> {
  const { solution: _solution, ...visible } = session;
  return {
    ...visible,
    board: cloneSudokuGrid(ensureSudokuPlayerBoard(session, side)),
    boards: undefined,
    battle: undefined,
    progress: createSudokuProgressMap(session),
    obscuredCells: activeObscuredCells(session, side),
    pendingDamage: session.battle?.[side]?.pendingDamage ?? 0,
    combo: session.battle?.[side]?.combo ?? 0,
    mySide: side,
  } as Omit<SudokuSession, 'solution'> & {
    obscuredCells: Array<{ row: number; col: number; until: string }>;
    pendingDamage: number;
    combo: number;
    mySide: SudokuSide;
  };
}

export function cloneSudokuGrid(grid: number[][]): number[][] {
  return grid.map((row) => [...row]);
}

export function ensureSudokuPlayerBoard(session: SudokuSession, side: SudokuSide): number[][] {
  session.boards ??= {};
  for (const playerSide of sudokuSides(session)) {
    session.boards[playerSide] ??= cloneSudokuGrid(session.board);
  }
  session.boards[side] ??= cloneSudokuGrid(session.board);
  return session.boards[side];
}

export function sudokuSideForAccount(session: SudokuSession, accountId: string): SudokuSide | undefined {
  for (const [side, playerAccountId] of Object.entries(session.players ?? {})) {
    if (playerAccountId === accountId) return side;
  }
  return undefined;
}

export function createSudokuProgressMap(session: SudokuSession): Record<SudokuSide, SudokuProgress> {
  return Object.fromEntries(sudokuSides(session).map((side) => [side, sudokuProgress(session, side)]));
}

export function sudokuSides(session: SudokuSession): SudokuSide[] {
  const sides = Object.keys(session.players ?? {});
  return sides.length > 0 ? sides : ['challenger', 'opponent'];
}

function sudokuProgress(session: SudokuSession, side: SudokuSide): SudokuProgress {
  const board = ensureSudokuPlayerBoard(session, side);
  let total = 0;
  let filled = 0;
  for (let row = 0; row < SUDOKU_SIZE; row += 1) {
    for (let col = 0; col < SUDOKU_SIZE; col += 1) {
      if (session.puzzle[row][col] === 0) {
        total += 1;
        if (board[row][col] !== 0) filled += 1;
      }
    }
  }
  return {
    filled,
    total,
    percent: total === 0 ? 100 : Math.round((filled / total) * 1000) / 10,
  };
}

function sudokuDamageTargetSide(session: SudokuSession, attacker: SudokuSide): SudokuSide | undefined {
  const attackerProgress = sudokuProgress(session, attacker).percent;
  const ahead = sudokuSides(session)
    .filter((side) => side !== attacker)
    .map((side) => ({ side, progress: sudokuProgress(session, side).percent }))
    .filter((entry) => entry.progress > attackerProgress)
    .sort((a, b) => a.progress - b.progress);
  return ahead[0]?.side;
}

export function createSudokuBattleState(board: number[][], solution: number[][]): SudokuBattleState {
  return {
    combo: 0,
    pendingDamage: 0,
    completedUnits: completedSudokuUnits(board, solution),
    obscuredCells: [],
  };
}

export function createSudokuBattleMap(session: SudokuSession): Record<SudokuSide, SudokuBattleState> {
  return Object.fromEntries(
    sudokuSides(session).map((side) => [
      side,
      createSudokuBattleState(ensureSudokuPlayerBoard(session, side), session.solution),
    ]),
  );
}

export function applySudokuBattleMove(session: SudokuSession, side: SudokuSide): void {
  if (!session.players) return;
  session.battle ??= createSudokuBattleMap(session);
  for (const playerSide of sudokuSides(session)) {
    session.battle[playerSide] ??= createSudokuBattleState(ensureSudokuPlayerBoard(session, playerSide), session.solution);
  }
  const self = session.battle[side];
  self.obscuredCells = activeObscuredCells(session, side);
  for (const rivalSide of sudokuSides(session).filter((candidate) => candidate !== side)) {
    session.battle[rivalSide].obscuredCells = activeObscuredCells(session, rivalSide);
  }

  const board = ensureSudokuPlayerBoard(session, side);
  const previousUnits = new Set(self.completedUnits);
  const nextUnits = completedSudokuUnits(board, session.solution);
  const completedThisMove = nextUnits.some((unit) => !previousUnits.has(unit));
  self.completedUnits = nextUnits;

  if (self.pendingDamage > 0) {
    if (completedThisMove) {
      self.pendingDamage = 0;
    } else {
      self.obscuredCells = applySudokuObscure(session, side, self.pendingDamage);
      self.pendingDamage = 0;
    }
  }

  if (!completedThisMove) {
    self.combo = 0;
    return;
  }
  self.combo += 1;
  const rivalSide = sudokuDamageTargetSide(session, side);
  if (rivalSide) {
    session.battle[rivalSide].pendingDamage += sudokuDamageForCombo(self.combo);
  }
}

function completedSudokuUnits(board: number[][], solution: number[][]): string[] {
  const units: string[] = [];
  for (let row = 0; row < SUDOKU_SIZE; row += 1) {
    if (Array.from({ length: SUDOKU_SIZE }, (_, col) => board[row][col] === solution[row][col]).every(Boolean)) {
      units.push(`r${row}`);
    }
  }
  for (let col = 0; col < SUDOKU_SIZE; col += 1) {
    if (Array.from({ length: SUDOKU_SIZE }, (_, row) => board[row][col] === solution[row][col]).every(Boolean)) {
      units.push(`c${col}`);
    }
  }
  for (let boxRow = 0; boxRow < 3; boxRow += 1) {
    for (let boxCol = 0; boxCol < 3; boxCol += 1) {
      const complete = Array.from({ length: SUDOKU_SIZE }, (_, index) => {
        const row = boxRow * 3 + Math.floor(index / 3);
        const col = boxCol * 3 + (index % 3);
        return board[row][col] === solution[row][col];
      }).every(Boolean);
      if (complete) units.push(`b${boxRow}${boxCol}`);
    }
  }
  return units;
}

function sudokuDamageForCombo(combo: number): number {
  if (combo <= 0) return 0;
  if (combo === 1) return 1;
  if (combo === 2) return 2;
  return 5 + (combo - 3) * 3;
}

export function activeObscuredCells(session: SudokuSession, side: SudokuSide): Array<{ row: number; col: number; until: string }> {
  const now = Date.now();
  return (session.battle?.[side]?.obscuredCells ?? []).filter((cell) => Date.parse(cell.until) > now);
}

function applySudokuObscure(session: SudokuSession, side: SudokuSide, amount: number): Array<{ row: number; col: number; until: string }> {
  const existing = activeObscuredCells(session, side);
  const existingKeys = new Set(existing.map((cell) => `${cell.row}:${cell.col}`));
  const candidates: Array<{ row: number; col: number }> = [];
  for (let row = 0; row < SUDOKU_SIZE; row += 1) {
    for (let col = 0; col < SUDOKU_SIZE; col += 1) {
      if (session.puzzle[row][col] !== 0 && !existingKeys.has(`${row}:${col}`)) {
        candidates.push({ row, col });
      }
    }
  }
  const seed = Math.abs(hashText(`${session.id}:${side}:${Date.now()}`));
  const selected: Array<{ row: number; col: number; until: string }> = [];
  for (let index = 0; index < Math.min(amount, candidates.length); index += 1) {
    const pick = (seed + index * 17) % candidates.length;
    const [candidate] = candidates.splice(pick, 1);
    selected.push({
      ...candidate,
      until: new Date(Date.now() + SUDOKU_OBSCURE_MS).toISOString(),
    });
  }
  return [...existing, ...selected];
}

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

export function validateSudokuBoard(board: number[][]): void {
  if (!Array.isArray(board) || board.length !== SUDOKU_SIZE) {
    throw new BadRequestException('board must be a 9x9 array');
  }
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== SUDOKU_SIZE) {
      throw new BadRequestException('board must be a 9x9 array');
    }
    for (const value of row) {
      if (!Number.isInteger(value) || value < 0 || value > 9) {
        throw new BadRequestException('board values must be integers from 0 to 9');
      }
    }
  }
}

export function validateSudokuIndex(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= SUDOKU_SIZE) {
    throw new BadRequestException(`${name} must be an integer from 0 to ${SUDOKU_SIZE - 1}`);
  }
}
