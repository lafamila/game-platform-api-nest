import assert from 'node:assert/strict';
import test from 'node:test';

import { createSudoku } from '../dist/games/sudoku-generator.js';

test('createSudoku creates unique-solution puzzles for every difficulty', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const { puzzle, solution } = createSudoku(difficulty);

    assert.equal(puzzle.length, 9);
    assert.equal(solution.length, 9);
    assert.ok(puzzle.flat().filter((value) => value === 0).length > 30);
    assert.ok(solution.flat().every((value) => value >= 1 && value <= 9));
    assert.equal(countSolutions(cloneGrid(puzzle), 2), 1);
    assert.deepEqual(fillPuzzle(puzzle, solution), solution);
  }
});

function fillPuzzle(puzzle, solution) {
  return puzzle.map((row, rowIndex) => row.map((value, colIndex) => value === 0 ? solution[rowIndex][colIndex] : value));
}

function cloneGrid(grid) {
  return grid.map((row) => [...row]);
}

function countSolutions(grid, limit) {
  const empty = findEmpty(grid);
  if (!empty) {
    return 1;
  }
  const [row, col] = empty;
  let count = 0;
  for (let value = 1; value <= 9; value += 1) {
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

function findEmpty(grid) {
  for (let row = 0; row < 9; row += 1) {
    for (let col = 0; col < 9; col += 1) {
      if (grid[row][col] === 0) {
        return [row, col];
      }
    }
  }
  return undefined;
}

function canPlace(grid, row, col, value) {
  for (let index = 0; index < 9; index += 1) {
    if (grid[row][index] === value || grid[index][col] === value) {
      return false;
    }
  }
  const boxRow = Math.floor(row / 3) * 3;
  const boxCol = Math.floor(col / 3) * 3;
  for (let r = boxRow; r < boxRow + 3; r += 1) {
    for (let c = boxCol; c < boxCol + 3; c += 1) {
      if (grid[r][c] === value) {
        return false;
      }
    }
  }
  return true;
}
