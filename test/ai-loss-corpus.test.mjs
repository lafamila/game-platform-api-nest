import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { boardBeforePly } = require('../scripts/extract-ai-loss-corpus.js');

test('gomoku loss corpus rebuilds the board before the requested ply', () => {
  const history = [
    { n: 0, type: 'move', color: 'black', x: 7, y: 7 },
    { n: 1, type: 'move', color: 'white', x: 8, y: 7 },
  ];
  const board = boardBeforePly('gomoku', history, 1);
  assert.equal(board[7][7], 'black');
  assert.equal(board[7][8], null);
});

test('othello loss corpus rebuilds placements, flips, and ignores pass entries', () => {
  const history = [
    { n: 0, type: 'move', color: 'black', x: 3, y: 2 },
    { n: 1, type: 'pass', color: 'white' },
    { n: 2, type: 'move', color: 'white', x: 2, y: 2 },
  ];
  const afterBlack = boardBeforePly('othello', history, 2);
  assert.equal(afterBlack[2][3], 'black');
  assert.equal(afterBlack[3][3], 'black', 'the opening white disc is flipped');
  const afterWhite = boardBeforePly('othello', history, 3);
  assert.equal(afterWhite[2][2], 'white');
  assert.equal(afterWhite[3][3], 'white', 'the intervening black disc is flipped back');
});
