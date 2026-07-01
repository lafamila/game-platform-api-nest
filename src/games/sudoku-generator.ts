import { Difficulty } from './games.types';

const SIZE = 9;
const BOX = 3;
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const BLANKS_BY_DIFFICULTY: Record<Difficulty, number> = {
  easy: 38,
  medium: 46,
  hard: 54,
};

export function createSudoku(difficulty: Difficulty) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const solution = emptyGrid();
    fillGrid(solution);
    const puzzle = solution.map((row) => [...row]);
    const blanks = BLANKS_BY_DIFFICULTY[difficulty];
    const cells = shuffle(Array.from({ length: SIZE * SIZE }, (_, index) => index));
    let removed = 0;

    for (const index of cells) {
      if (removed >= blanks) {
        break;
      }
      const row = Math.floor(index / SIZE);
      const col = index % SIZE;
      const previous = puzzle[row][col];
      puzzle[row][col] = 0;
      if (countSolutions(cloneGrid(puzzle), 2) === 1) {
        removed += 1;
      } else {
        puzzle[row][col] = previous;
      }
    }

    if (countSolutions(cloneGrid(puzzle), 2) === 1) {
      return { puzzle, solution };
    }
  }

  throw new Error('Failed to generate a unique-solution Sudoku puzzle');
}

export function isSolvedSudoku(board: number[][], solution: number[][]): boolean {
  if (board.length !== SIZE || board.some((row) => row.length !== SIZE)) {
    return false;
  }
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      if (board[row][col] !== solution[row][col]) {
        return false;
      }
    }
  }
  return true;
}

function fillGrid(grid: number[][]): boolean {
  const empty = findBestEmptyCell(grid);
  if (!empty) {
    return true;
  }
  const [row, col] = empty;
  for (const value of shuffle(DIGITS)) {
    if (canPlace(grid, row, col, value)) {
      grid[row][col] = value;
      if (fillGrid(grid)) {
        return true;
      }
      grid[row][col] = 0;
    }
  }
  return false;
}

function countSolutions(grid: number[][], limit: number): number {
  const empty = findBestEmptyCell(grid);
  if (!empty) {
    return 1;
  }
  const [row, col] = empty;
  let count = 0;
  for (const value of DIGITS) {
    if (canPlace(grid, row, col, value)) {
      grid[row][col] = value;
      count += countSolutions(grid, limit);
      grid[row][col] = 0;
      if (count >= limit) {
        return count;
      }
    }
  }
  return count;
}

function findBestEmptyCell(grid: number[][]): [number, number] | undefined {
  let best: [number, number] | undefined;
  let bestCount = 10;
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      if (grid[row][col] !== 0) {
        continue;
      }
      const candidates = DIGITS.filter((value) => canPlace(grid, row, col, value)).length;
      if (candidates < bestCount) {
        best = [row, col];
        bestCount = candidates;
      }
      if (bestCount === 1) {
        return best;
      }
    }
  }
  return best;
}

function canPlace(grid: number[][], row: number, col: number, value: number): boolean {
  for (let index = 0; index < SIZE; index += 1) {
    if (grid[row][index] === value || grid[index][col] === value) {
      return false;
    }
  }
  const boxRow = Math.floor(row / BOX) * BOX;
  const boxCol = Math.floor(col / BOX) * BOX;
  for (let r = boxRow; r < boxRow + BOX; r += 1) {
    for (let c = boxCol; c < boxCol + BOX; c += 1) {
      if (grid[r][c] === value) {
        return false;
      }
    }
  }
  return true;
}

function emptyGrid(): number[][] {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 0));
}

function cloneGrid(grid: number[][]): number[][] {
  return grid.map((row) => [...row]);
}

function shuffle<T>(values: T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}
