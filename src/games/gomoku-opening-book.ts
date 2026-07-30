import type { PlayerColor } from './games.types';
import type { GomokuAiBoard } from './gomoku-ai-position';
import type { AiWorkerMove } from './engine/ai-worker-protocol';
import { getForbiddenReason } from './gomoku-rules';

const BOARD_SIZE = 15;
const LAST = BOARD_SIZE - 1;

type DihedralTransform = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * Generator-facing wire format. Keys contain the side to move followed by
 * row-major, base-36 packed stones in canonical orientation. Each candidate
 * contains a canonical row-major index and a positive integer weight. A
 * generator can emit this object as JSON/TS.
 */
export type GomokuOpeningBookCandidate = readonly [canonicalMove: number, weight: number];
export type GomokuOpeningBookEntry = readonly [
  canonicalKey: string,
  candidates: readonly GomokuOpeningBookCandidate[],
];
export type EncodedGomokuOpeningMove = readonly [canonicalKey: string, canonicalMove: number];

export interface GomokuOpeningBookDataV2 {
  readonly format: 'gomoku-opening-book-v2';
  readonly boardSize: 15;
  readonly entries: readonly GomokuOpeningBookEntry[];
}

// The base line was generated with a 75k-node-per-move offline analysis.
// The two extra white entries cover the first divergence found in five
// production losses. Symmetric positions share the same compact entry.
export const GOMOKU_OPENING_BOOK: GomokuOpeningBookDataV2 = {
  format: 'gomoku-opening-book-v2',
  boardSize: BOARD_SIZE,
  entries: [
    ['b:', [[112, 1]]],
    // Four rotationally equivalent adjacent replies prevent a fixed opening
    // while preserving the analyzed line through canonical symmetry.
    ['w:68', [[111, 1], [97, 1], [113, 1], [127, 1]]],
    ['b:5f68', [[126, 1]]],
    ['w:5c686b', [[128, 1]]],
    ['b:5c686b75', [[98, 1]]],
    ['w:5c5f5h6870', [[111, 1]]],
    ['b:5c5f5g676871', [[128, 1]]],
    ['w:5c5f5g67687174', [[80, 1]]],
    ['b:4h5c5f5g67687174', [[83, 1]]],
    ['w:4h4m5c5f5g67687174', [[113, 1]]],
    ['b:4h4m5c5f5g67686b7174', [[81, 1]]],
    ['w:4h4i4m5c5f5g67686b7174', [[99, 1]]],
    // Production-loss branch: after center, white-adjacent, black diagonal.
    ['w:5c5f68', [[128, 1]]],
    // A 120s/depth-9 analysis preferred canonical 113 over the repeatedly
    // timed-out canonical 68 move by 24,798 evaluation points.
    ['w:4k5c5f6875', [[113, 1]]],
  ],
};

const BOOK_BY_KEY = new Map<string, readonly GomokuOpeningBookCandidate[]>(GOMOKU_OPENING_BOOK.entries);
const INVERSE_TRANSFORM: readonly DihedralTransform[] = [0, 3, 2, 1, 4, 5, 6, 7];

function transformCoordinate(row: number, col: number, transform: DihedralTransform): readonly [number, number] {
  switch (transform) {
    case 0: return [row, col];
    case 1: return [col, LAST - row];
    case 2: return [LAST - row, LAST - col];
    case 3: return [LAST - col, row];
    case 4: return [row, LAST - col];
    case 5: return [LAST - col, LAST - row];
    case 6: return [LAST - row, col];
    case 7: return [col, row];
  }
}

function validBoard(board: GomokuAiBoard): boolean {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) return false;
  return board.every((row) =>
    Array.isArray(row) &&
    row.length === BOARD_SIZE &&
    row.every((cell) => cell === null || cell === 'black' || cell === 'white'),
  );
}

function encodePosition(board: GomokuAiBoard, turn: PlayerColor, transform: DihedralTransform): string {
  let key = turn === 'black' ? 'b:' : 'w:';
  const inverse = INVERSE_TRANSFORM[transform];

  // Scan the transformed board in row-major order. Packing index*2 plus one
  // color bit yields a fixed two-character base-36 token for every stone.
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      const [sourceRow, sourceCol] = transformCoordinate(row, col, inverse);
      const color = board[sourceRow][sourceCol];
      if (color === null) continue;
      const packed = (2 * (row * BOARD_SIZE + col)) + (color === 'white' ? 1 : 0);
      key += packed.toString(36).padStart(2, '0');
    }
  }
  return key;
}

function canonicalPosition(board: GomokuAiBoard, turn: PlayerColor): { key: string; transform: DihedralTransform } {
  let key = encodePosition(board, turn, 0);
  let transform: DihedralTransform = 0;

  for (let candidate = 1 as DihedralTransform; candidate < 8; candidate += 1) {
    const candidateKey = encodePosition(board, turn, candidate);
    if (candidateKey < key) {
      key = candidateKey;
      transform = candidate;
    }
  }
  return { key, transform };
}

export function encodeGomokuOpeningBookEntry(
  board: GomokuAiBoard,
  turn: PlayerColor,
  move: AiWorkerMove,
): EncodedGomokuOpeningMove | null {
  if (!validBoard(board) || !Number.isInteger(move.row) || !Number.isInteger(move.col)) return null;
  if (move.row < 0 || move.row >= BOARD_SIZE || move.col < 0 || move.col >= BOARD_SIZE) return null;
  if (board[move.row][move.col] !== null) return null;
  const canonical = canonicalPosition(board, turn);
  const [row, col] = transformCoordinate(move.row, move.col, canonical.transform);
  return [canonical.key, row * BOARD_SIZE + col];
}

function selectCandidate(
  candidates: readonly GomokuOpeningBookCandidate[],
  selectionSeed?: number,
): number | null {
  if (candidates.length === 0) return null;
  if (selectionSeed === undefined) return candidates[0][0];

  let totalWeight = 0;
  for (const [move, weight] of candidates) {
    if (!Number.isInteger(move) || move < 0 || move >= BOARD_SIZE ** 2) continue;
    if (!Number.isInteger(weight) || weight <= 0) continue;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;

  let sample = (selectionSeed >>> 0) % totalWeight;
  for (const [move, weight] of candidates) {
    if (!Number.isInteger(move) || move < 0 || move >= BOARD_SIZE ** 2) continue;
    if (!Number.isInteger(weight) || weight <= 0) continue;
    if (sample < weight) return move;
    sample -= weight;
  }
  return null;
}

/** Returns a reproducibly selected book move for an exact 15x15 position. */
export function lookupGomokuOpeningMove(
  board: GomokuAiBoard,
  turn: PlayerColor,
  selectionSeed?: number,
): AiWorkerMove | null {
  if ((turn !== 'black' && turn !== 'white') || !validBoard(board)) return null;

  const canonical = canonicalPosition(board, turn);
  const candidates = BOOK_BY_KEY.get(canonical.key);
  const canonicalMove = candidates ? selectCandidate(candidates, selectionSeed) : null;
  if (canonicalMove === null) return null;

  const canonicalRow = Math.floor(canonicalMove / BOARD_SIZE);
  const canonicalCol = canonicalMove % BOARD_SIZE;
  const [row, col] = transformCoordinate(canonicalRow, canonicalCol, INVERSE_TRANSFORM[canonical.transform]);
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE || board[row][col] !== null) return null;

  // The current engine's exact-five-priority Renju restrictions apply only to
  // black. Check on a copy because the canonical rules helper probes in place.
  if (turn === 'black' && getForbiddenReason(board.map((sourceRow) => sourceRow.slice()), row, col) !== null) return null;
  return { row, col };
}
