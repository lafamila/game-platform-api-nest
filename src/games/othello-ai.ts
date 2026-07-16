import { OthelloColor } from './games.types';
import {
  AiDepthReporter,
  AiSearchDiagnostics,
  AiSearchResult,
  AiWorkerMove,
} from './engine/ai-worker-protocol';
import { DualZobrist32, TTFlag } from './engine/zobrist';

// Othello hard engine. The board and move buffers are numeric and reusable so
// the search hot path does not allocate arrays for every legal move.

const SIZE = 8;
const CELLS = 64;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const CONSERVATIVE_EXACT_EMPTIES = 14;
const OPPORTUNISTIC_EXACT_EMPTIES = 18;
const TERMINAL_BASE = 1_000_000;
const WIN_GUARD = 500_000;
const MAX_SEARCH_PLIES = 128;
export const OTHELLO_AI_ENGINE_VERSION = 'othello-hard-v2';
const TIMEOUT = Symbol('othello-ai-timeout');
const NODE_LIMIT = Symbol('othello-ai-node-limit');
const WORKER_RETURN_MARGIN_MS = 5;

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

const CARDINAL_DIRS = [1, 3, 4, 6];
const STEP: Int8Array[] = buildSteps();
const ZOBRIST_KEYS = buildZobristKeys();

function buildSteps(): Int8Array[] {
  const steps: Int8Array[] = [];
  for (let sq = 0; sq < CELLS; sq += 1) {
    const row = Math.floor(sq / SIZE);
    const col = sq % SIZE;
    const arr = new Int8Array(DIRS.length);
    for (let d = 0; d < DIRS.length; d += 1) {
      const nr = row + DIRS[d][0];
      const nc = col + DIRS[d][1];
      arr[d] = nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE ? nr * SIZE + nc : -1;
    }
    steps.push(arr);
  }
  return steps;
}

function buildZobristKeys(): {
  primary: Uint32Array;
  verifier: Uint32Array;
  turnPrimary: number;
  turnVerifier: number;
} {
  const zobrist = new DualZobrist32(CELLS, 3);
  const primary = new Uint32Array(CELLS * 2);
  const verifier = new Uint32Array(CELLS * 2);
  for (let sq = 0; sq < CELLS; sq += 1) {
    for (let piece = 0; piece < 2; piece += 1) {
      const keys = zobrist.key(sq, piece);
      const index = sq * 2 + piece;
      primary[index] = keys[0];
      verifier[index] = keys[1];
    }
  }
  const turn = zobrist.key(0, 2);
  return { primary, verifier, turnPrimary: turn[0], turnVerifier: turn[1] };
}

const SQUARE_VALUE = new Int16Array([
  100, -20, 10, 5, 5, 10, -20, 100,
  -20, -50, -2, -2, -2, -2, -50, -20,
  10, -2, -1, -1, -1, -1, -2, 10,
  5, -2, -1, -1, -1, -1, -2, 5,
  5, -2, -1, -1, -1, -1, -2, 5,
  10, -2, -1, -1, -1, -1, -2, 10,
  -20, -50, -2, -2, -2, -2, -50, -20,
  100, -20, 10, 5, 5, 10, -20, 100,
]);

const CORNERS = [0, 7, 56, 63];
const CORNER_ADJ: Record<number, number[]> = {
  0: [1, 8, 9],
  7: [6, 14, 15],
  56: [48, 49, 57],
  63: [54, 55, 62],
};

interface PhaseWeights {
  corner: number;
  cornerAdj: number;
  mobility: number;
  potential: number;
  frontier: number;
  disc: number;
  positional: number;
}

interface OthelloTtEntry {
  verifier: number;
  depth: number;
  score: number;
  flag: TTFlag;
  move: number;
}

interface MoveBuffer {
  count: number;
  squares: Uint8Array;
  flipCounts: Uint8Array;
  flips: Uint8Array;
  order: Uint8Array;
  scores: Int32Array;
}

interface OthelloMetrics {
  evaluationCalls: number;
  candidateGenerations: number;
}

type ExitReason = AiSearchDiagnostics['exitReason'];

export interface OthelloSearchOptions {
  maxSearchNodes?: number;
  exactMode?: 'auto' | 'off';
  deadlineAt?: number;
}

function weightsFor(empties: number): PhaseWeights {
  if (empties > 40) {
    return { corner: 45, cornerAdj: 18, mobility: 12, potential: 2.5, frontier: 3, disc: 0, positional: 1 };
  }
  if (empties > CONSERVATIVE_EXACT_EMPTIES) {
    return { corner: 45, cornerAdj: 14, mobility: 9, potential: 1.5, frontier: 3, disc: 1, positional: 1 };
  }
  return { corner: 45, cornerAdj: 8, mobility: 5, potential: 0.5, frontier: 1.5, disc: 4, positional: 1 };
}

function toInternal(board: (OthelloColor | null)[][]): Int8Array {
  const result = new Int8Array(CELLS);
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      const cell = board[row]?.[col] ?? null;
      result[row * SIZE + col] = cell === 'black' ? BLACK : cell === 'white' ? WHITE : EMPTY;
    }
  }
  return result;
}

function countExternalEmpties(board: (OthelloColor | null)[][]): number {
  let empties = 0;
  for (const row of board) for (const cell of row) if (!cell) empties += 1;
  return empties;
}

function sqToRC(sq: number): AiWorkerMove {
  return { row: Math.floor(sq / SIZE), col: sq % SIZE };
}

function createMoveBuffer(): MoveBuffer {
  return {
    count: 0,
    squares: new Uint8Array(CELLS),
    flipCounts: new Uint8Array(CELLS),
    flips: new Uint8Array(CELLS * CELLS),
    order: new Uint8Array(CELLS),
    scores: new Int32Array(CELLS),
  };
}

export function othelloPhaseBudgetMs(
  board: (OthelloColor | null)[][],
  configuredBudgetMs: number,
): number {
  const safeBudget = Math.max(1, configuredBudgetMs);
  if (safeBudget < 500) return safeBudget;
  return countExternalEmpties(board) >= 50 ? Math.min(safeBudget, 3_000) : safeBudget;
}

function expectedNextDepthMs(depthTimes: number[]): number | null {
  if (depthTimes.length < 2) return null;
  const ratios: number[] = [];
  const first = Math.max(1, depthTimes.length - 3);
  for (let index = first; index < depthTimes.length; index += 1) {
    const previous = Math.max(1, depthTimes[index - 1]);
    ratios.push(depthTimes[index] / previous);
  }
  const growth = Math.min(8, Math.max(1.6, ...ratios));
  return Math.ceil(depthTimes[depthTimes.length - 1] * growth * 1.15);
}

class OthelloSearch {
  readonly b: Int8Array;
  readonly startedAt = Date.now();
  readonly budgetMs: number;
  readonly initialBoardHash: string;
  readonly metrics: OthelloMetrics = { evaluationCalls: 0, candidateGenerations: 0 };
  readonly tt = new Map<number, OthelloTtEntry>();
  readonly exactTt = new Map<number, OthelloTtEntry>();

  private readonly initialBoard: Int8Array;
  private readonly piecePrimary = ZOBRIST_KEYS.primary;
  private readonly pieceVerifier = ZOBRIST_KEYS.verifier;
  private readonly moveBuffers = Array.from({ length: MAX_SEARCH_PLIES }, createMoveBuffer);
  private readonly visitMarks = new Uint16Array(CELLS);
  private readonly regionStack = new Uint8Array(CELLS);
  private readonly maxSearchNodes?: number;
  private readonly turnPrimary: number;
  private readonly turnVerifier: number;
  private visitGeneration = 0;
  private hashPrimary = 0;
  private hashVerifier = 0;
  private blackCount = 0;
  private whiteCount = 0;
  private empties = 0;

  nodes = 0;
  deadline: number;

  constructor(board: (OthelloColor | null)[][], budgetMs: number, options?: OthelloSearchOptions) {
    this.b = toInternal(board);
    this.initialBoard = this.b.slice();
    this.budgetMs = budgetMs;
    this.maxSearchNodes = options?.maxSearchNodes;
    this.turnPrimary = ZOBRIST_KEYS.turnPrimary;
    this.turnVerifier = ZOBRIST_KEYS.turnVerifier;
    for (let sq = 0; sq < CELLS; sq += 1) {
      const value = this.b[sq];
      if (value === EMPTY) {
        this.empties += 1;
        continue;
      }
      if (value === BLACK) this.blackCount += 1;
      else this.whiteCount += 1;
      const index = sq * 2 + (value === BLACK ? 0 : 1);
      const primary = this.piecePrimary[index];
      const verifier = this.pieceVerifier[index];
      this.hashPrimary = (this.hashPrimary ^ primary) >>> 0;
      this.hashVerifier = (this.hashVerifier ^ verifier) >>> 0;
    }
    this.initialBoardHash = `${this.hashPrimary.toString(16).padStart(8, '0')}${this.hashVerifier.toString(16).padStart(8, '0')}`;
    this.deadline = this.startedAt + budgetMs;
  }

  setDeadline(deadline: number): void {
    this.deadline = deadline;
  }

  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  emptyCount(): number {
    return this.empties;
  }

  assertRootRestored(): void {
    let blackCount = 0;
    let whiteCount = 0;
    let empties = 0;
    for (let sq = 0; sq < CELLS; sq += 1) {
      if (this.b[sq] !== this.initialBoard[sq]) {
        throw new Error(`othello search did not restore board square ${sq}`);
      }
      if (this.b[sq] === BLACK) blackCount += 1;
      else if (this.b[sq] === WHITE) whiteCount += 1;
      else empties += 1;
    }
    if (blackCount !== this.blackCount || whiteCount !== this.whiteCount || empties !== this.empties) {
      throw new Error('othello search did not restore its incremental counters');
    }
    let primary = 0;
    let verifier = 0;
    for (let sq = 0; sq < CELLS; sq += 1) {
      const value = this.b[sq];
      if (value === EMPTY) continue;
      const index = sq * 2 + (value === BLACK ? 0 : 1);
      primary = (primary ^ this.piecePrimary[index]) >>> 0;
      verifier = (verifier ^ this.pieceVerifier[index]) >>> 0;
    }
    if (primary !== this.hashPrimary || verifier !== this.hashVerifier) {
      throw new Error('othello search did not restore its incremental hash');
    }
  }

  private opposite(color: number): number {
    return color === BLACK ? WHITE : BLACK;
  }

  private pieceIndex(color: number): number {
    return color === BLACK ? 0 : 1;
  }

  private mapPrimary(color: number): number {
    return color === WHITE ? (this.hashPrimary ^ this.turnPrimary) >>> 0 : this.hashPrimary;
  }

  private mapVerifier(color: number): number {
    return color === WHITE ? (this.hashVerifier ^ this.turnVerifier) >>> 0 : this.hashVerifier;
  }

  private probe(table: Map<number, OthelloTtEntry>, color: number): OthelloTtEntry | undefined {
    const entry = table.get(this.mapPrimary(color));
    return entry?.verifier === this.mapVerifier(color) ? entry : undefined;
  }

  private store(
    table: Map<number, OthelloTtEntry>,
    color: number,
    depth: number,
    score: number,
    flag: TTFlag,
    move: number,
  ): void {
    const primary = this.mapPrimary(color);
    const verifier = this.mapVerifier(color);
    const existing = table.get(primary);
    if (!existing || existing.verifier !== verifier || existing.depth <= depth) {
      table.set(primary, { verifier, depth, score, flag, move });
    }
  }

  private checkDeadline(force = false): void {
    if (this.maxSearchNodes !== undefined && this.nodes >= this.maxSearchNodes) throw NODE_LIMIT;
    if ((force || (this.nodes & 255) === 0) && Date.now() >= this.deadline) throw TIMEOUT;
  }

  private buffer(ply: number): MoveBuffer {
    if (ply >= MAX_SEARCH_PLIES) throw new Error('othello search exceeded its maximum ply');
    return this.moveBuffers[ply];
  }

  generateMoves(color: number, ply: number): MoveBuffer {
    this.metrics.candidateGenerations += 1;
    const out = this.buffer(ply);
    out.count = 0;
    const opponent = this.opposite(color);
    for (let sq = 0; sq < CELLS; sq += 1) {
      if (this.b[sq] !== EMPTY) continue;
      const slot = out.count;
      const base = slot * CELLS;
      let flipCount = 0;
      for (let direction = 0; direction < DIRS.length; direction += 1) {
        const directionStart = flipCount;
        let current = STEP[sq][direction];
        while (current >= 0 && this.b[current] === opponent) {
          out.flips[base + flipCount] = current;
          flipCount += 1;
          current = STEP[current][direction];
        }
        if (directionStart === flipCount || current < 0 || this.b[current] !== color) {
          flipCount = directionStart;
        }
      }
      if (flipCount === 0) continue;
      out.squares[slot] = sq;
      out.flipCounts[slot] = flipCount;
      out.order[slot] = slot;
      out.count += 1;
    }
    return out;
  }

  private hasFlip(sq: number, color: number): boolean {
    const opponent = this.opposite(color);
    for (let direction = 0; direction < DIRS.length; direction += 1) {
      let current = STEP[sq][direction];
      let seenOpponent = false;
      while (current >= 0 && this.b[current] === opponent) {
        seenOpponent = true;
        current = STEP[current][direction];
      }
      if (seenOpponent && current >= 0 && this.b[current] === color) return true;
    }
    return false;
  }

  private countMoves(color: number): number {
    let count = 0;
    for (let sq = 0; sq < CELLS; sq += 1) {
      if (this.b[sq] === EMPTY && this.hasFlip(sq, color)) count += 1;
    }
    return count;
  }

  private make(buffer: MoveBuffer, slot: number, color: number): void {
    const sq = buffer.squares[slot];
    const flipCount = buffer.flipCounts[slot];
    const base = slot * CELLS;
    const opponent = this.opposite(color);
    this.b[sq] = color;
    this.empties -= 1;
    if (color === BLACK) {
      this.blackCount += 1 + flipCount;
      this.whiteCount -= flipCount;
    } else {
      this.whiteCount += 1 + flipCount;
      this.blackCount -= flipCount;
    }
    const placedIndex = sq * 2 + this.pieceIndex(color);
    this.hashPrimary = (this.hashPrimary ^ this.piecePrimary[placedIndex]) >>> 0;
    this.hashVerifier = (this.hashVerifier ^ this.pieceVerifier[placedIndex]) >>> 0;
    for (let index = 0; index < flipCount; index += 1) {
      const flipped = buffer.flips[base + index];
      this.b[flipped] = color;
      const oldIndex = flipped * 2 + this.pieceIndex(opponent);
      const newIndex = flipped * 2 + this.pieceIndex(color);
      this.hashPrimary = (this.hashPrimary ^ this.piecePrimary[oldIndex] ^ this.piecePrimary[newIndex]) >>> 0;
      this.hashVerifier = (this.hashVerifier ^ this.pieceVerifier[oldIndex] ^ this.pieceVerifier[newIndex]) >>> 0;
    }
  }

  private unmake(buffer: MoveBuffer, slot: number, color: number): void {
    const sq = buffer.squares[slot];
    const flipCount = buffer.flipCounts[slot];
    const base = slot * CELLS;
    const opponent = this.opposite(color);
    for (let index = 0; index < flipCount; index += 1) {
      const flipped = buffer.flips[base + index];
      this.b[flipped] = opponent;
      const oldIndex = flipped * 2 + this.pieceIndex(color);
      const newIndex = flipped * 2 + this.pieceIndex(opponent);
      this.hashPrimary = (this.hashPrimary ^ this.piecePrimary[oldIndex] ^ this.piecePrimary[newIndex]) >>> 0;
      this.hashVerifier = (this.hashVerifier ^ this.pieceVerifier[oldIndex] ^ this.pieceVerifier[newIndex]) >>> 0;
    }
    const placedIndex = sq * 2 + this.pieceIndex(color);
    this.hashPrimary = (this.hashPrimary ^ this.piecePrimary[placedIndex]) >>> 0;
    this.hashVerifier = (this.hashVerifier ^ this.pieceVerifier[placedIndex]) >>> 0;
    this.b[sq] = EMPTY;
    this.empties += 1;
    if (color === BLACK) {
      this.blackCount -= 1 + flipCount;
      this.whiteCount += flipCount;
    } else {
      this.whiteCount -= 1 + flipCount;
      this.blackCount += flipCount;
    }
  }

  private discDiff(color: number): number {
    return color === BLACK ? this.blackCount - this.whiteCount : this.whiteCount - this.blackCount;
  }

  private terminalScore(color: number): number {
    const difference = this.discDiff(color);
    if (difference > 0) return TERMINAL_BASE + difference;
    if (difference < 0) return -TERMINAL_BASE + difference;
    return 0;
  }

  private evaluate(color: number, myMobility: number): number {
    this.metrics.evaluationCalls += 1;
    const opponent = this.opposite(color);
    const weights = weightsFor(this.empties);
    let positional = 0;
    let frontier = 0;
    let potential = 0;
    for (let sq = 0; sq < CELLS; sq += 1) {
      const value = this.b[sq];
      if (value === EMPTY) {
        let nearOpponent = false;
        let nearMine = false;
        for (let direction = 0; direction < DIRS.length; direction += 1) {
          const neighbor = STEP[sq][direction];
          if (neighbor < 0) continue;
          if (this.b[neighbor] === opponent) nearOpponent = true;
          else if (this.b[neighbor] === color) nearMine = true;
        }
        potential += (nearOpponent ? 1 : 0) - (nearMine ? 1 : 0);
        continue;
      }
      const sign = value === color ? 1 : -1;
      positional += sign * SQUARE_VALUE[sq];
      for (let direction = 0; direction < DIRS.length; direction += 1) {
        const neighbor = STEP[sq][direction];
        if (neighbor >= 0 && this.b[neighbor] === EMPTY) {
          frontier += sign;
          break;
        }
      }
    }

    let corner = 0;
    let cornerAdj = 0;
    for (const cornerSquare of CORNERS) {
      if (this.b[cornerSquare] === color) corner += 1;
      else if (this.b[cornerSquare] === opponent) corner -= 1;
      else {
        for (const adjacent of CORNER_ADJ[cornerSquare]) {
          if (this.b[adjacent] === color) cornerAdj -= 1;
          else if (this.b[adjacent] === opponent) cornerAdj += 1;
        }
      }
    }
    const opponentMobility = this.countMoves(opponent);
    const mobility = myMobility - opponentMobility;
    return (
      weights.corner * corner +
      weights.cornerAdj * cornerAdj +
      weights.mobility * mobility +
      weights.potential * potential -
      weights.frontier * frontier +
      weights.disc * this.discDiff(color) +
      weights.positional * positional
    );
  }

  private emptyRegionSize(start: number): number {
    this.visitGeneration += 1;
    if (this.visitGeneration >= 65_535) {
      this.visitMarks.fill(0);
      this.visitGeneration = 1;
    }
    const generation = this.visitGeneration;
    let head = 0;
    let tail = 1;
    let size = 0;
    this.regionStack[0] = start;
    this.visitMarks[start] = generation;
    while (head < tail) {
      const square = this.regionStack[head];
      head += 1;
      size += 1;
      for (const direction of CARDINAL_DIRS) {
        const neighbor = STEP[square][direction];
        if (neighbor < 0 || this.b[neighbor] !== EMPTY || this.visitMarks[neighbor] === generation) continue;
        this.visitMarks[neighbor] = generation;
        this.regionStack[tail] = neighbor;
        tail += 1;
      }
    }
    return size;
  }

  private orderMoves(
    buffer: MoveBuffer,
    color: number,
    ttMove: number,
    ply: number,
    depth: number,
    exact: boolean,
  ): void {
    const opponent = this.opposite(color);
    const useMobility = exact || ply <= 2 || (depth >= 6 && ply <= 4);
    for (let slot = 0; slot < buffer.count; slot += 1) {
      const square = buffer.squares[slot];
      let score = SQUARE_VALUE[square] * 100 - buffer.flipCounts[slot] * (exact ? 0 : 3);
      if (square === ttMove) score += 10_000_000;
      if (CORNERS.includes(square)) score += 1_000_000;
      if (exact && this.emptyRegionSize(square) % 2 === 1) score += 50_000;
      if (useMobility) {
        this.checkDeadline(true);
        this.make(buffer, slot, color);
        try {
          score -= this.countMoves(opponent) * (exact ? 1_000 : 120);
        } finally {
          this.unmake(buffer, slot, color);
        }
      }
      buffer.scores[slot] = score;
      buffer.order[slot] = slot;
    }

    for (let index = 1; index < buffer.count; index += 1) {
      const slot = buffer.order[index];
      const score = buffer.scores[slot];
      let cursor = index - 1;
      while (cursor >= 0 && buffer.scores[buffer.order[cursor]] < score) {
        buffer.order[cursor + 1] = buffer.order[cursor];
        cursor -= 1;
      }
      buffer.order[cursor + 1] = slot;
    }
  }

  private negamax(color: number, depth: number, alphaIn: number, betaIn: number, ply: number): number {
    this.nodes += 1;
    this.checkDeadline();
    let alpha = alphaIn;
    let beta = betaIn;
    const entry = this.probe(this.tt, color);
    let ttMove = -1;
    if (entry) {
      ttMove = entry.move;
      if (entry.depth >= depth) {
        if (entry.flag === 'exact') return entry.score;
        if (entry.flag === 'lower') alpha = Math.max(alpha, entry.score);
        else beta = Math.min(beta, entry.score);
        if (alpha >= beta) return entry.score;
      }
    }
    const searchedAlpha = alpha;
    const searchedBeta = beta;

    const opponent = this.opposite(color);
    const moves = this.generateMoves(color, ply);
    if (moves.count === 0) {
      const opponentMoves = this.generateMoves(opponent, ply + 1);
      if (opponentMoves.count === 0) return this.terminalScore(color);
      const score = -this.negamax(opponent, depth, -beta, -alpha, ply + 1);
      const flag: TTFlag = score <= searchedAlpha ? 'upper' : score >= searchedBeta ? 'lower' : 'exact';
      this.store(this.tt, color, depth, score, flag, -1);
      return score;
    }
    if (depth <= 0) return this.evaluate(color, moves.count);

    this.orderMoves(moves, color, ttMove, ply, depth, false);
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves.squares[moves.order[0]];
    for (let orderIndex = 0; orderIndex < moves.count; orderIndex += 1) {
      const slot = moves.order[orderIndex];
      this.make(moves, slot, color);
      let score: number;
      try {
        score = -this.negamax(opponent, depth - 1, -beta, -alpha, ply + 1);
      } finally {
        this.unmake(moves, slot, color);
      }
      if (score > best) {
        best = score;
        bestMove = moves.squares[slot];
      }
      alpha = Math.max(alpha, best);
      if (alpha >= beta) break;
    }
    const flag: TTFlag = best <= searchedAlpha ? 'upper' : best >= searchedBeta ? 'lower' : 'exact';
    this.store(this.tt, color, depth, best, flag, bestMove);
    return best;
  }

  private negamaxExact(color: number, alphaIn: number, betaIn: number, ply: number): number {
    this.nodes += 1;
    this.checkDeadline();
    let alpha = alphaIn;
    let beta = betaIn;
    const depth = this.empties;
    const entry = this.probe(this.exactTt, color);
    let ttMove = -1;
    if (entry) {
      ttMove = entry.move;
      if (entry.depth >= depth) {
        if (entry.flag === 'exact') return entry.score;
        if (entry.flag === 'lower') alpha = Math.max(alpha, entry.score);
        else beta = Math.min(beta, entry.score);
        if (alpha >= beta) return entry.score;
      }
    }
    const searchedAlpha = alpha;
    const searchedBeta = beta;

    const opponent = this.opposite(color);
    const moves = this.generateMoves(color, ply);
    if (moves.count === 0) {
      const opponentMoves = this.generateMoves(opponent, ply + 1);
      if (opponentMoves.count === 0) return this.terminalScore(color);
      const score = -this.negamaxExact(opponent, -beta, -alpha, ply + 1);
      const flag: TTFlag = score <= searchedAlpha ? 'upper' : score >= searchedBeta ? 'lower' : 'exact';
      this.store(this.exactTt, color, depth, score, flag, -1);
      return score;
    }

    this.orderMoves(moves, color, ttMove, ply, depth, true);
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves.squares[moves.order[0]];
    for (let orderIndex = 0; orderIndex < moves.count; orderIndex += 1) {
      const slot = moves.order[orderIndex];
      this.make(moves, slot, color);
      let score: number;
      try {
        score = -this.negamaxExact(opponent, -beta, -alpha, ply + 1);
      } finally {
        this.unmake(moves, slot, color);
      }
      if (score > best) {
        best = score;
        bestMove = moves.squares[slot];
      }
      alpha = Math.max(alpha, best);
      if (alpha >= beta) break;
    }
    const flag: TTFlag = best <= searchedAlpha ? 'upper' : best >= searchedBeta ? 'lower' : 'exact';
    this.store(this.exactTt, color, depth, best, flag, bestMove);
    return best;
  }

  searchRoot(color: number, depth: number): { move: number; score: number } {
    this.checkDeadline(true);
    const moves = this.generateMoves(color, 0);
    const ttMove = this.probe(this.tt, color)?.move ?? -1;
    this.orderMoves(moves, color, ttMove, 0, depth, false);
    const opponent = this.opposite(color);
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves.squares[moves.order[0]];
    let alpha = Number.NEGATIVE_INFINITY;
    const beta = Number.POSITIVE_INFINITY;
    for (let orderIndex = 0; orderIndex < moves.count; orderIndex += 1) {
      this.checkDeadline(true);
      const slot = moves.order[orderIndex];
      this.make(moves, slot, color);
      let score: number;
      try {
        score = -this.negamax(opponent, depth - 1, -beta, -alpha, 1);
      } finally {
        this.unmake(moves, slot, color);
      }
      if (score > best) {
        best = score;
        bestMove = moves.squares[slot];
      }
      alpha = Math.max(alpha, best);
    }
    this.store(this.tt, color, depth, best, 'exact', bestMove);
    return { move: bestMove, score: best };
  }

  searchRootExact(color: number): { move: number; score: number } {
    this.checkDeadline(true);
    const moves = this.generateMoves(color, 0);
    const ttMove = this.probe(this.exactTt, color)?.move ?? -1;
    this.orderMoves(moves, color, ttMove, 0, this.empties, true);
    const opponent = this.opposite(color);
    let best = Number.NEGATIVE_INFINITY;
    let bestMove = moves.squares[moves.order[0]];
    let alpha = Number.NEGATIVE_INFINITY;
    const beta = Number.POSITIVE_INFINITY;
    for (let orderIndex = 0; orderIndex < moves.count; orderIndex += 1) {
      this.checkDeadline(true);
      const slot = moves.order[orderIndex];
      this.make(moves, slot, color);
      let score: number;
      try {
        score = -this.negamaxExact(opponent, -beta, -alpha, 1);
      } finally {
        this.unmake(moves, slot, color);
      }
      if (score > best) {
        best = score;
        bestMove = moves.squares[slot];
      }
      alpha = Math.max(alpha, best);
    }
    this.store(this.exactTt, color, this.empties, best, 'exact', bestMove);
    return { move: bestMove, score: best };
  }

  result(move: number | null, depth: number, score: number, exitReason: ExitReason): AiSearchResult {
    this.assertRootRestored();
    const converted = move === null ? null : sqToRC(move);
    return {
      move: converted,
      depth,
      score,
      nodes: this.nodes,
      diagnostics: {
        engineVersion: OTHELLO_AI_ENGINE_VERSION,
        boardHash: this.initialBoardHash,
        budgetMs: this.budgetMs,
        elapsedMs: Date.now() - this.startedAt,
        completedDepth: depth,
        searchNodes: this.nodes,
        vcfNodes: 0,
        vctNodes: 0,
        evaluationCalls: this.metrics.evaluationCalls,
        forbiddenChecks: 0,
        candidateGenerations: this.metrics.candidateGenerations,
        principalVariation: converted ? [converted] : [],
        exitReason,
      },
    };
  }
}

export function searchOthelloMove(
  board: (OthelloColor | null)[][],
  turn: OthelloColor,
  configuredBudgetMs: number,
  onDepth?: AiDepthReporter,
  options?: OthelloSearchOptions,
): AiSearchResult {
  const phaseBudgetMs = othelloPhaseBudgetMs(board, configuredBudgetMs);
  const absoluteRemainingMs = options?.deadlineAt === undefined
    ? phaseBudgetMs
    : options.deadlineAt - Date.now() - WORKER_RETURN_MARGIN_MS;
  const budgetMs = Math.max(0, Math.min(phaseBudgetMs, absoluteRemainingMs));
  const search = new OthelloSearch(board, budgetMs, options);
  const color = turn === 'black' ? BLACK : WHITE;
  const rootMoves = search.generateMoves(color, 0);
  if (rootMoves.count === 0) return search.result(null, 0, 0, 'no_legal_move');
  onDepth?.({ depth: 0, move: sqToRC(rootMoves.squares[0]), score: 0 });
  if (budgetMs === 0) return search.result(rootMoves.squares[0], 0, 0, 'timeout');

  const empties = search.emptyCount();
  const overallDeadline = search.startedAt + budgetMs;
  const exactEligible = options?.exactMode !== 'off' && empties <= OPPORTUNISTIC_EXACT_EMPTIES;
  const baselineFraction = empties <= CONSERVATIVE_EXACT_EMPTIES ? 0.2 : 0.35;
  const baselineDeadline = exactEligible
    ? Math.min(overallDeadline, search.startedAt + Math.max(10, Math.floor(budgetMs * baselineFraction)))
    : overallDeadline;
  search.setDeadline(baselineDeadline);

  let best = { move: rootMoves.squares[0] as number | null, score: 0, depth: 0 };
  let exitReason: ExitReason = 'completed';
  let nodeLimitReached = false;
  const depthTimes: number[] = [];
  try {
    for (let depth = 1; depth <= empties; depth += 1) {
      const depthStartedAt = Date.now();
      const result = search.searchRoot(color, depth);
      depthTimes.push(Math.max(1, Date.now() - depthStartedAt));
      best = { move: result.move, score: result.score, depth };
      onDepth?.({ depth, move: sqToRC(result.move), score: result.score });
      if (Math.abs(result.score) >= WIN_GUARD) {
        exitReason = 'proven';
        break;
      }
      const expected = expectedNextDepthMs(depthTimes);
      if (expected !== null && search.remainingMs() <= expected) {
        exitReason = 'predicted_timeout';
        break;
      }
    }
  } catch (error) {
    if (error !== TIMEOUT && error !== NODE_LIMIT) throw error;
    nodeLimitReached = error === NODE_LIMIT;
    exitReason = nodeLimitReached ? 'node_limit' : 'timeout';
  }
  search.assertRootRestored();
  if (best.depth === empties) exitReason = 'exact';

  if (exactEligible && !nodeLimitReached && best.depth < empties && Date.now() < overallDeadline) {
    search.setDeadline(overallDeadline);
    try {
      const exact = search.searchRootExact(color);
      best = { move: exact.move, score: exact.score, depth: empties };
      exitReason = 'exact';
      onDepth?.({ depth: empties, move: sqToRC(exact.move), score: exact.score });
    } catch (error) {
      if (error !== TIMEOUT && error !== NODE_LIMIT) throw error;
      exitReason = error === NODE_LIMIT ? 'node_limit' : 'exact_timeout';
    }
    search.assertRootRestored();
  }

  return search.result(best.move, best.depth, best.score, exitReason);
}
