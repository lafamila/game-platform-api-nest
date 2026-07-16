import { PlayerColor } from './games.types';
import { DualZobrist32 } from './engine/zobrist';
import { countFours, countOpenThrees, isExactFive } from './gomoku-rules';

export const GOMOKU_AI_SIZE = 15;
const CELL_COUNT = GOMOKU_AI_SIZE * GOMOKU_AI_SIZE;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

type CellCode = 0 | 1 | 2;
export type GomokuAiBoard = (PlayerColor | null)[][];

export interface GomokuAiMetrics {
  searchNodes: number;
  vcfNodes: number;
  vctNodes: number;
  evaluationCalls: number;
  forbiddenChecks: number;
  candidateGenerations: number;
}

export interface GomokuThreatProfile {
  exactFive: boolean;
  fours: number;
  openThrees: number;
  score: number;
}

interface LineAnalysis {
  baseScore: number;
  winningPoints: number[];
  openThreeExtensions: number[];
}

interface CachedLine {
  black: LineAnalysis;
  white: LineAnalysis;
}

const zobrist = new DualZobrist32(CELL_COUNT, 3);
const TURN_KEY = zobrist.key(0, 2);

function codeOf(color: PlayerColor): 1 | 2 {
  return color === 'black' ? BLACK : WHITE;
}

function colorOf(code: CellCode): PlayerColor | null {
  return code === BLACK ? 'black' : code === WHITE ? 'white' : null;
}

function indexOf(row: number, col: number): number {
  return row * GOMOKU_AI_SIZE + col;
}

function rowOf(index: number): number {
  return Math.floor(index / GOMOKU_AI_SIZE);
}

function colOf(index: number): number {
  return index % GOMOKU_AI_SIZE;
}

function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < GOMOKU_AI_SIZE && col >= 0 && col < GOMOKU_AI_SIZE;
}

function buildLines(): { lines: number[][]; cellLines: number[][] } {
  const lines: number[][] = [];
  const add = (cells: number[]) => {
    if (cells.length >= 5) lines.push(cells);
  };

  for (let row = 0; row < GOMOKU_AI_SIZE; row += 1) {
    add(Array.from({ length: GOMOKU_AI_SIZE }, (_, col) => indexOf(row, col)));
  }
  for (let col = 0; col < GOMOKU_AI_SIZE; col += 1) {
    add(Array.from({ length: GOMOKU_AI_SIZE }, (_, row) => indexOf(row, col)));
  }
  for (let startCol = 0; startCol < GOMOKU_AI_SIZE; startCol += 1) {
    const cells: number[] = [];
    for (let row = 0, col = startCol; inBounds(row, col); row += 1, col += 1) cells.push(indexOf(row, col));
    add(cells);
  }
  for (let startRow = 1; startRow < GOMOKU_AI_SIZE; startRow += 1) {
    const cells: number[] = [];
    for (let row = startRow, col = 0; inBounds(row, col); row += 1, col += 1) cells.push(indexOf(row, col));
    add(cells);
  }
  for (let startCol = 0; startCol < GOMOKU_AI_SIZE; startCol += 1) {
    const cells: number[] = [];
    for (let row = 0, col = startCol; inBounds(row, col); row += 1, col -= 1) cells.push(indexOf(row, col));
    add(cells);
  }
  for (let startRow = 1; startRow < GOMOKU_AI_SIZE; startRow += 1) {
    const cells: number[] = [];
    for (let row = startRow, col = GOMOKU_AI_SIZE - 1; inBounds(row, col); row += 1, col -= 1) cells.push(indexOf(row, col));
    add(cells);
  }

  const cellLines = Array.from({ length: CELL_COUNT }, () => [] as number[]);
  lines.forEach((line, lineId) => line.forEach((cell) => cellLines[cell].push(lineId)));
  return { lines, cellLines };
}

const LINE_TABLE = buildLines();

function analyzeLine(board: Int8Array, cells: number[], color: 1 | 2): LineAnalysis {
  const line = new Int8Array(cells.length);
  for (let index = 0; index < cells.length; index += 1) line[index] = board[cells[index]];
  let baseScore = 0;

  for (let position = 0; position < line.length;) {
    if (line[position] !== color) {
      position += 1;
      continue;
    }
    let end = position + 1;
    while (end < line.length && line[end] === color) end += 1;
    const length = end - position;
    const openBefore = position > 0 && line[position - 1] === EMPTY;
    const openAfter = end < line.length && line[end] === EMPTY;
    const opens = Number(openBefore) + Number(openAfter);
    if (length === 5) baseScore += 1_000_000;
    else if (length === 4) baseScore += opens === 2 ? 18_000 : opens === 1 ? 5_000 : 0;
    else if (length === 3) baseScore += opens === 2 ? 1_200 : opens === 1 ? 240 : 0;
    else if (length === 2) baseScore += opens === 2 ? 90 : opens === 1 ? 18 : 0;
    else if (length === 1 && opens === 2) baseScore += 3;
    // A maximal run of 6+ is deliberately worth no same-line win score.
    position = end;
  }

  let winningMask = 0;
  const extensionTargets = new Uint16Array(line.length);
  const opponent = color === BLACK ? WHITE : BLACK;
  for (let start = 0; start + 4 < line.length; start += 1) {
    let stones = 0;
    let emptyCount = 0;
    let firstEmpty = -1;
    let secondEmpty = -1;
    let blocked = false;
    for (let offset = 0; offset < 5; offset += 1) {
      const value = line[start + offset];
      if (value === opponent) {
        blocked = true;
        break;
      }
      if (value === color) stones += 1;
      else {
        if (emptyCount === 0) firstEmpty = start + offset;
        else if (emptyCount === 1) secondEmpty = start + offset;
        emptyCount += 1;
      }
    }
    if (blocked) continue;

    // Filling this five-window must produce a maximal run of exactly five.
    // An own stone immediately outside would make it an overline, not a win.
    const exactBoundary =
      (start === 0 || line[start - 1] !== color) &&
      (start + 5 === line.length || line[start + 5] !== color);
    if (!exactBoundary) continue;

    if (stones === 4 && emptyCount === 1) {
      winningMask |= 1 << firstEmpty;
    } else if (stones === 3 && emptyCount === 2) {
      extensionTargets[firstEmpty] |= 1 << secondEmpty;
      extensionTargets[secondEmpty] |= 1 << firstEmpty;
    } else if (stones === 2 && emptyCount === 3) {
      baseScore += 8;
    }
  }

  const winningPoints: number[] = [];
  const openThreeExtensions: number[] = [];
  for (let position = 0; position < line.length; position += 1) {
    if ((winningMask & (1 << position)) !== 0) winningPoints.push(cells[position]);
    const targets = extensionTargets[position];
    const multipleTargets = targets !== 0 && (targets & (targets - 1)) !== 0;
    if (multipleTargets) {
      openThreeExtensions.push(cells[position]);
      baseScore += 1_800;
    } else if (targets !== 0) {
      baseScore += 260;
    }
  }

  return { baseScore, winningPoints, openThreeExtensions };
}

function emptyAnalysis(): LineAnalysis {
  return { baseScore: 0, winningPoints: [], openThreeExtensions: [] };
}

export class GomokuAiPosition {
  readonly cells = new Int8Array(CELL_COUNT);
  readonly ruleBoard: GomokuAiBoard;
  readonly metrics: GomokuAiMetrics;
  private readonly neighborCounts = new Int16Array(CELL_COUNT);
  private readonly lineCache: CachedLine[] = [];
  private readonly baseScores = new Float64Array(3);
  private readonly winningPointCounts = [new Int16Array(CELL_COUNT), new Int16Array(CELL_COUNT), new Int16Array(CELL_COUNT)];
  private readonly openThreeCounts = [new Int16Array(CELL_COUNT), new Int16Array(CELL_COUNT), new Int16Array(CELL_COUNT)];
  private readonly winningPointUnique = new Int16Array(3);
  private readonly openThreeUnique = new Int16Array(3);
  private hashPrimary = 0;
  private hashVerifier = 0;
  stoneCount = 0;

  constructor(board: GomokuAiBoard, metrics?: GomokuAiMetrics) {
    this.metrics = metrics ?? {
      searchNodes: 0,
      vcfNodes: 0,
      vctNodes: 0,
      evaluationCalls: 0,
      forbiddenChecks: 0,
      candidateGenerations: 0,
    };
    this.ruleBoard = board.map((row) => row.slice());
    for (let row = 0; row < GOMOKU_AI_SIZE; row += 1) {
      for (let col = 0; col < GOMOKU_AI_SIZE; col += 1) {
        const color = board[row]?.[col] ?? null;
        if (!color) continue;
        const index = indexOf(row, col);
        const code = codeOf(color);
        this.cells[index] = code;
        this.stoneCount += 1;
        const [primary, verifier] = zobrist.key(index, code - 1);
        this.hashPrimary = (this.hashPrimary ^ primary) >>> 0;
        this.hashVerifier = (this.hashVerifier ^ verifier) >>> 0;
        this.adjustNeighbors(index, 1);
      }
    }
    for (let lineId = 0; lineId < LINE_TABLE.lines.length; lineId += 1) {
      const cached = this.computeLine(lineId);
      this.lineCache.push(cached);
      this.addLineContributions(cached, 1);
    }
  }

  private adjustNeighbors(index: number, delta: 1 | -1): void {
    const row = rowOf(index);
    const col = colOf(index);
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (inBounds(nextRow, nextCol)) this.neighborCounts[indexOf(nextRow, nextCol)] += delta;
      }
    }
  }

  private computeLine(lineId: number): CachedLine {
    const cells = LINE_TABLE.lines[lineId];
    return {
      black: analyzeLine(this.cells, cells, BLACK),
      white: analyzeLine(this.cells, cells, WHITE),
    };
  }

  private updatePointCounts(target: Int16Array, points: number[], color: 1 | 2, delta: 1 | -1, unique: Int16Array): void {
    for (const point of points) {
      const before = target[point];
      target[point] += delta;
      if (before === 0 && target[point] > 0) unique[color] += 1;
      else if (before > 0 && target[point] === 0) unique[color] -= 1;
    }
  }

  private addLineContributions(cached: CachedLine, delta: 1 | -1): void {
    for (const color of [BLACK, WHITE] as const) {
      const analysis = color === BLACK ? cached.black : cached.white;
      this.baseScores[color] += analysis.baseScore * delta;
      this.updatePointCounts(this.winningPointCounts[color], analysis.winningPoints, color, delta, this.winningPointUnique);
      this.updatePointCounts(this.openThreeCounts[color], analysis.openThreeExtensions, color, delta, this.openThreeUnique);
    }
  }

  private refreshLines(index: number, mutate: () => void): void {
    const lineIds = LINE_TABLE.cellLines[index];
    for (const lineId of lineIds) this.addLineContributions(this.lineCache[lineId], -1);
    mutate();
    for (const lineId of lineIds) {
      const cached = this.computeLine(lineId);
      this.lineCache[lineId] = cached;
      this.addLineContributions(cached, 1);
    }
  }

  makeMove(row: number, col: number, color: PlayerColor): void {
    const index = indexOf(row, col);
    if (this.cells[index] !== EMPTY) throw new Error(`gomoku AI makeMove occupied: ${row},${col}`);
    const code = codeOf(color);
    this.refreshLines(index, () => {
      this.cells[index] = code;
      this.ruleBoard[row][col] = color;
      this.stoneCount += 1;
      this.adjustNeighbors(index, 1);
      const [primary, verifier] = zobrist.key(index, code - 1);
      this.hashPrimary = (this.hashPrimary ^ primary) >>> 0;
      this.hashVerifier = (this.hashVerifier ^ verifier) >>> 0;
    });
  }

  unmakeMove(row: number, col: number): void {
    const index = indexOf(row, col);
    const code = this.cells[index] as CellCode;
    if (code === EMPTY) throw new Error(`gomoku AI unmakeMove empty: ${row},${col}`);
    this.refreshLines(index, () => {
      const [primary, verifier] = zobrist.key(index, code - 1);
      this.hashPrimary = (this.hashPrimary ^ primary) >>> 0;
      this.hashVerifier = (this.hashVerifier ^ verifier) >>> 0;
      this.adjustNeighbors(index, -1);
      this.stoneCount -= 1;
      this.cells[index] = EMPTY;
      this.ruleBoard[row][col] = null;
    });
  }

  isEmpty(row: number, col: number): boolean {
    return inBounds(row, col) && this.cells[indexOf(row, col)] === EMPTY;
  }

  isLegal(row: number, col: number, color: PlayerColor): boolean {
    if (!this.isEmpty(row, col)) return false;
    if (color !== 'black') return true;
    this.metrics.forbiddenChecks += 1;
    if (!this.mayBeForbiddenBlackMove(row, col)) return true;
    return !this.isForbiddenBlackMove(row, col);
  }

  private mayBeForbiddenBlackMove(row: number, col: number): boolean {
    let directionsWithTwo = 0;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
      let nearbyBlack = 0;
      for (let offset = -4; offset <= 4; offset += 1) {
        if (offset === 0) continue;
        const nextRow = row + dr * offset;
        const nextCol = col + dc * offset;
        if (inBounds(nextRow, nextCol) && this.cells[indexOf(nextRow, nextCol)] === BLACK) nearbyBlack += 1;
      }
      if (nearbyBlack >= 3) return true;
      if (nearbyBlack >= 2) directionsWithTwo += 1;
    }
    return directionsWithTwo >= 2;
  }

  private virtualBlackAt(row: number, col: number, rootRow: number, rootCol: number, extraIndex = -1): boolean {
    if (!inBounds(row, col)) return false;
    const index = indexOf(row, col);
    return (row === rootRow && col === rootCol) || index === extraIndex || this.cells[index] === BLACK;
  }

  private virtualEmptyAt(row: number, col: number, rootRow: number, rootCol: number, extraIndex = -1): boolean {
    if (!inBounds(row, col) || (row === rootRow && col === rootCol)) return false;
    const index = indexOf(row, col);
    return index !== extraIndex && this.cells[index] === EMPTY;
  }

  private virtualRun(
    row: number,
    col: number,
    dr: number,
    dc: number,
    extraIndex = -1,
  ): { forward: number; backward: number; length: number } {
    let forward = 0;
    let backward = 0;
    while (this.virtualBlackAt(row + dr * (forward + 1), col + dc * (forward + 1), row, col, extraIndex)) forward += 1;
    while (this.virtualBlackAt(row - dr * (backward + 1), col - dc * (backward + 1), row, col, extraIndex)) backward += 1;
    return { forward, backward, length: 1 + forward + backward };
  }

  private foursInDirection(row: number, col: number, dr: number, dc: number): number {
    const winning = new Set<number>();
    for (let offset = -4; offset <= 4; offset += 1) {
      if (offset === 0) continue;
      const targetRow = row + dr * offset;
      const targetCol = col + dc * offset;
      if (!this.virtualEmptyAt(targetRow, targetCol, row, col)) continue;
      const extraIndex = indexOf(targetRow, targetCol);
      if (this.virtualRun(row, col, dr, dc, extraIndex).length === 5) winning.add(extraIndex);
    }
    if (winning.size === 0) return 0;
    const run = this.virtualRun(row, col, dr, dc);
    const straight =
      run.length === 4 &&
      this.virtualEmptyAt(row + dr * (run.forward + 1), col + dc * (run.forward + 1), row, col) &&
      this.virtualEmptyAt(row - dr * (run.backward + 1), col - dc * (run.backward + 1), row, col);
    return winning.size >= 2 && straight ? 1 : winning.size;
  }

  private hasOpenThreeInDirection(row: number, col: number, dr: number, dc: number): boolean {
    for (let offset = -4; offset <= 4; offset += 1) {
      if (offset === 0) continue;
      const targetRow = row + dr * offset;
      const targetCol = col + dc * offset;
      if (!this.virtualEmptyAt(targetRow, targetCol, row, col)) continue;
      const extraIndex = indexOf(targetRow, targetCol);
      const run = this.virtualRun(row, col, dr, dc, extraIndex);
      if (run.length !== 4 || offset < -run.backward || offset > run.forward) continue;
      if (
        this.virtualEmptyAt(row + dr * (run.forward + 1), col + dc * (run.forward + 1), row, col, extraIndex) &&
        this.virtualEmptyAt(row - dr * (run.backward + 1), col - dc * (run.backward + 1), row, col, extraIndex)
      ) return true;
    }
    return false;
  }

  private isForbiddenBlackMove(row: number, col: number): boolean {
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;
    const runs = directions.map(([dr, dc]) => this.virtualRun(row, col, dr, dc));
    if (runs.some((run) => run.length === 5)) return false;
    if (runs.some((run) => run.length >= 6)) return true;
    let fours = 0;
    for (const [dr, dc] of directions) fours += this.foursInDirection(row, col, dr, dc);
    if (fours >= 2) return true;
    let threes = 0;
    for (const [dr, dc] of directions) {
      if (this.hasOpenThreeInDirection(row, col, dr, dc)) threes += 1;
    }
    return threes >= 2;
  }

  isWinningMove(row: number, col: number, color: PlayerColor): boolean {
    if (!this.isEmpty(row, col)) return false;
    this.ruleBoard[row][col] = color;
    const winning = isExactFive(this.ruleBoard, row, col, color);
    this.ruleBoard[row][col] = null;
    return winning;
  }

  isExactFiveAt(row: number, col: number, color: PlayerColor): boolean {
    return inBounds(row, col) && this.cells[indexOf(row, col)] === codeOf(color)
      ? isExactFive(this.ruleBoard, row, col, color)
      : false;
  }

  moveOrderingScore(row: number, col: number, color: PlayerColor): number {
    if (!this.isEmpty(row, col)) return Number.NEGATIVE_INFINITY;
    const own = codeOf(color);
    const opponent = own === BLACK ? WHITE : BLACK;
    let score = 0;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
      let forward = 0;
      let backward = 0;
      while (inBounds(row + dr * (forward + 1), col + dc * (forward + 1)) &&
        this.cells[indexOf(row + dr * (forward + 1), col + dc * (forward + 1))] === own) forward += 1;
      while (inBounds(row - dr * (backward + 1), col - dc * (backward + 1)) &&
        this.cells[indexOf(row - dr * (backward + 1), col - dc * (backward + 1))] === own) backward += 1;
      const run = 1 + forward + backward;
      const openForward = inBounds(row + dr * (forward + 1), col + dc * (forward + 1)) &&
        this.cells[indexOf(row + dr * (forward + 1), col + dc * (forward + 1))] === EMPTY;
      const openBackward = inBounds(row - dr * (backward + 1), col - dc * (backward + 1)) &&
        this.cells[indexOf(row - dr * (backward + 1), col - dc * (backward + 1))] === EMPTY;
      const opens = Number(openForward) + Number(openBackward);
      if (run === 5) score += 1_000_000;
      else if (run === 4) score += opens === 2 ? 50_000 : opens === 1 ? 9_000 : 0;
      else if (run === 3) score += opens === 2 ? 4_500 : opens === 1 ? 500 : 0;
      else if (run === 2) score += opens === 2 ? 260 : opens === 1 ? 30 : 0;

      // Sliding five-cell count preserves broken-shape ordering without
      // rereading all five cells for each of the five overlapping windows.
      let stones = 0;
      let blockers = 0;
      for (let offset = -4; offset <= 0; offset += 1) {
        const nextRow = row + dr * offset;
        const nextCol = col + dc * offset;
        if (offset === 0) stones += 1;
        else if (!inBounds(nextRow, nextCol)) blockers += 1;
        else {
          const value = this.cells[indexOf(nextRow, nextCol)];
          if (value === own) stones += 1;
          else if (value === opponent) blockers += 1;
        }
      }
      for (let start = -4; start <= 0; start += 1) {
        if (blockers === 0) score += stones === 4 ? 2_800 : stones === 3 ? 180 : stones === 2 ? 12 : 0;
        if (start === 0) break;
        const removeRow = row + dr * start;
        const removeCol = col + dc * start;
        if (!inBounds(removeRow, removeCol)) blockers -= 1;
        else {
          const value = this.cells[indexOf(removeRow, removeCol)];
          if (value === own) stones -= 1;
          else if (value === opponent) blockers -= 1;
        }
        const addOffset = start + 5;
        const addRow = row + dr * addOffset;
        const addCol = col + dc * addOffset;
        if (!inBounds(addRow, addCol)) blockers += 1;
        else {
          const value = this.cells[indexOf(addRow, addCol)];
          if (value === own) stones += 1;
          else if (value === opponent) blockers += 1;
        }
      }
    }
    return score;
  }

  candidateCells(): Array<{ row: number; col: number }> {
    this.metrics.candidateGenerations += 1;
    if (this.stoneCount === 0) return [{ row: 7, col: 7 }];
    const result: Array<{ row: number; col: number }> = [];
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (this.cells[index] === EMPTY && this.neighborCounts[index] > 0) {
        result.push({ row: rowOf(index), col: colOf(index) });
      }
    }
    return result;
  }

  immediateWinningMoves(color: PlayerColor): Array<{ row: number; col: number }> {
    const counts = this.winningPointCounts[codeOf(color)];
    const result: Array<{ row: number; col: number }> = [];
    for (let index = 0; index < CELL_COUNT; index += 1) {
      if (counts[index] > 0 && this.cells[index] === EMPTY) {
        result.push({ row: rowOf(index), col: colOf(index) });
      }
    }
    return result;
  }

  threatProfile(row: number, col: number, color: PlayerColor): GomokuThreatProfile | null {
    if (!this.isLegal(row, col, color)) return null;
    this.makeMove(row, col, color);
    const exactFive = isExactFive(this.ruleBoard, row, col, color);
    const fours = exactFive ? 0 : countFours(this.ruleBoard, row, col, color);
    const openThrees = exactFive ? 0 : countOpenThrees(this.ruleBoard, row, col, color);
    const score = this.evaluate(color);
    this.unmakeMove(row, col);
    return { exactFive, fours, openThrees, score };
  }

  private scoreFor(code: 1 | 2): number {
    const winning = this.winningPointUnique[code];
    const threes = this.openThreeUnique[code];
    let score = this.baseScores[code];
    if (winning >= 2) score += 240_000 + winning * 20_000;
    else if (winning === 1) score += 22_000;
    if (threes >= 2) score += 18_000 + threes * 2_500;
    else if (threes === 1) score += 2_000;
    return score;
  }

  evaluate(color: PlayerColor): number {
    this.metrics.evaluationCalls += 1;
    const code = codeOf(color);
    const opponent = code === BLACK ? WHITE : BLACK;
    return this.scoreFor(code) - this.scoreFor(opponent);
  }

  hash(color: PlayerColor): readonly [number, number] {
    if (color === 'black') return [this.hashPrimary, this.hashVerifier];
    return [
      (this.hashPrimary ^ TURN_KEY[0]) >>> 0,
      (this.hashVerifier ^ TURN_KEY[1]) >>> 0,
    ];
  }

  boardHash(): string {
    return `${this.hashPrimary.toString(16).padStart(8, '0')}:${this.hashVerifier.toString(16).padStart(8, '0')}`;
  }

  snapshot(): GomokuAiBoard {
    return Array.from({ length: GOMOKU_AI_SIZE }, (_, row) =>
      Array.from({ length: GOMOKU_AI_SIZE }, (_, col) => colorOf(this.cells[indexOf(row, col)] as CellCode)),
    );
  }
}

export function evaluateGomokuBoardFull(board: GomokuAiBoard, color: PlayerColor): number {
  const flattened = new Int8Array(CELL_COUNT);
  for (let row = 0; row < GOMOKU_AI_SIZE; row += 1) {
    for (let col = 0; col < GOMOKU_AI_SIZE; col += 1) {
      const value = board[row]?.[col] ?? null;
      flattened[indexOf(row, col)] = value ? codeOf(value) : EMPTY;
    }
  }
  const baseScores = new Float64Array(3);
  const winning = [new Set<number>(), new Set<number>(), new Set<number>()];
  const threes = [new Set<number>(), new Set<number>(), new Set<number>()];
  for (const line of LINE_TABLE.lines) {
    for (const code of [BLACK, WHITE] as const) {
      const analysis = analyzeLine(flattened, line, code);
      baseScores[code] += analysis.baseScore;
      analysis.winningPoints.forEach((point) => winning[code].add(point));
      analysis.openThreeExtensions.forEach((point) => threes[code].add(point));
    }
  }
  const scoreFor = (code: 1 | 2) => {
    let score = baseScores[code];
    if (winning[code].size >= 2) score += 240_000 + winning[code].size * 20_000;
    else if (winning[code].size === 1) score += 22_000;
    if (threes[code].size >= 2) score += 18_000 + threes[code].size * 2_500;
    else if (threes[code].size === 1) score += 2_000;
    return score;
  };
  const code = codeOf(color);
  const opponent = code === BLACK ? WHITE : BLACK;
  return scoreFor(code) - scoreFor(opponent);
}
