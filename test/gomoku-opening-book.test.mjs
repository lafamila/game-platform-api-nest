import assert from 'node:assert/strict';
import test from 'node:test';

import { initialGomokuBoard } from '../dist/games/gomoku-engine.js';
import { GOMOKU_OPENING_BOOK, lookupGomokuOpeningMove } from '../dist/games/gomoku-opening-book.js';
import { getForbiddenReason } from '../dist/games/gomoku-rules.js';

const LAST = 14;

const BOOK_LINES = [
  [[7, 7], [7, 6], [8, 8], [6, 6], [8, 6], [8, 7], [6, 8], [9, 5], [9, 8], [7, 8], [9, 6], [8, 9]],
];

function transformCoordinate(row, col, transform) {
  switch (transform) {
    case 0: return [row, col];
    case 1: return [col, LAST - row];
    case 2: return [LAST - row, LAST - col];
    case 3: return [LAST - col, row];
    case 4: return [row, LAST - col];
    case 5: return [LAST - col, LAST - row];
    case 6: return [LAST - row, col];
    case 7: return [col, row];
    default: throw new Error(`unknown transform ${transform}`);
  }
}

function boardBefore(line, ply) {
  const board = initialGomokuBoard();
  for (let index = 0; index < ply; index += 1) {
    const [row, col] = line[index];
    board[row][col] = index % 2 === 0 ? 'black' : 'white';
  }
  return board;
}

function transformedBoard(board, transform) {
  const result = initialGomokuBoard();
  for (let row = 0; row < 15; row += 1) {
    for (let col = 0; col < 15; col += 1) {
      const [nextRow, nextCol] = transformCoordinate(row, col, transform);
      result[nextRow][nextCol] = board[row][col];
    }
  }
  return result;
}

test('gomoku opening lookup canonicalizes all eight dihedral symmetries', () => {
  const line = BOOK_LINES[0];
  const ply = 8;
  const board = boardBefore(line, ply);
  const expected = line[ply];

  for (let transform = 0; transform < 8; transform += 1) {
    const transformed = transformedBoard(board, transform);
    const [row, col] = transformCoordinate(expected[0], expected[1], transform);
    assert.deepEqual(lookupGomokuOpeningMove(transformed, 'black'), { row, col }, `transform ${transform}`);
  }
});

test('gomoku opening book returns legal empty moves through representative 12-ply lines', () => {
  for (const [lineIndex, line] of BOOK_LINES.entries()) {
    for (let ply = 0; ply < line.length; ply += 1) {
      const board = boardBefore(line, ply);
      const turn = ply % 2 === 0 ? 'black' : 'white';
      const move = lookupGomokuOpeningMove(board, turn);

      assert.ok(move, `line ${lineIndex + 1}, ply ${ply + 1} should be covered`);
      assert.ok(move.row >= 0 && move.row < 15 && move.col >= 0 && move.col < 15);
      assert.equal(board[move.row][move.col], null);
      if (turn === 'black') assert.equal(getForbiddenReason(board, move.row, move.col), null);

      assert.deepEqual(move, { row: line[ply][0], col: line[ply][1] });
    }
  }
});

test('gomoku opening lookup includes side to move and rejects non-15x15 boards', () => {
  const empty = initialGomokuBoard();
  assert.deepEqual(lookupGomokuOpeningMove(empty, 'black'), { row: 7, col: 7 });
  assert.equal(lookupGomokuOpeningMove(empty, 'white'), null);
  assert.equal(lookupGomokuOpeningMove(Array.from({ length: 14 }, () => Array(14).fill(null)), 'black'), null);
});

test('gomoku opening book exposes a compact generator-facing format', () => {
  assert.equal(GOMOKU_OPENING_BOOK.format, 'gomoku-opening-book-v1');
  assert.equal(GOMOKU_OPENING_BOOK.boardSize, 15);
  assert.equal(GOMOKU_OPENING_BOOK.entries.length, 12);
  assert.equal(new Set(GOMOKU_OPENING_BOOK.entries.map(([key]) => key)).size, 12);
  for (const [key, move] of GOMOKU_OPENING_BOOK.entries) {
    assert.match(key, /^[bw]:(?:[0-9a-z]{2})*$/);
    assert.ok(Number.isInteger(move) && move >= 0 && move < 225);
  }
});
