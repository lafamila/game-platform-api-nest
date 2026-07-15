import assert from 'node:assert/strict';
import test from 'node:test';

import { searchOthelloMove } from '../dist/games/othello-ai.js';
import {
  applyOthelloMove,
  chooseOthelloAiMove,
  initialOthelloBoard,
  othelloLegalMoves,
  othelloScore,
} from '../dist/games/othello-engine.js';

const HARD_SELFPLAY_BUDGET_MS = 25;

function emptyBoard() {
  return Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
}

function session(board, currentTurn = 'black') {
  return {
    id: 'o',
    mode: 'friend_match',
    board,
    currentTurn,
    status: 'playing',
    players: { black: 'b', white: 'w' },
    moves: [],
    createdAt: '',
    updatedAt: '',
  };
}

// ---------------------------------------------------------------------------
// tactics
// ---------------------------------------------------------------------------

test('hard othello opens with a legal move and searches several plies', () => {
  const res = searchOthelloMove(initialOthelloBoard(), 'black', 300);
  assert.ok(res.move);
  const legal = [[2, 3], [3, 2], [4, 5], [5, 4]];
  assert.ok(legal.some(([r, c]) => res.move.row === r && res.move.col === c));
  assert.ok(res.depth >= 3, `expected a multi-ply search, got depth ${res.depth}`);
});

test('hard othello prefers a dominant corner capture over an available X-square', () => {
  const board = emptyBoard();
  // A whole white edge that black can capture by taking the corner (0,0): flips (0,1..5) + owns the corner.
  board[0][1] = 'white';
  board[0][2] = 'white';
  board[0][3] = 'white';
  board[0][4] = 'white';
  board[0][5] = 'white';
  board[0][6] = 'black';
  // Also make the X-square (1,1) a legal but weak alternative (flips one, hands over corner (0,0)).
  board[2][2] = 'white';
  board[3][3] = 'black';
  const res = searchOthelloMove(board, 'black', 500);
  assert.ok(res.move);
  assert.ok(!(res.move.row === 1 && res.move.col === 1), 'must not grab the X-square when a corner is available');
  assert.deepEqual({ row: res.move.row, col: res.move.col }, { row: 0, col: 0 }, 'should take the dominant corner');
});

test('hard othello solves a decided low-empty endgame as a win', () => {
  // Black overwhelmingly ahead with a handful of empties; the exact solver should
  // return a move and a terminal-magnitude score (win), and playing it out keeps black ahead.
  const board = emptyBoard();
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) board[r][c] = 'black';
  }
  // carve a white cluster and a few empties so black still has a legal (flipping) move
  board[7][7] = null;
  board[7][6] = null;
  board[7][5] = null;
  board[6][7] = null;
  board[6][6] = 'white';
  board[6][5] = 'white';
  board[5][7] = 'white';
  const before = othelloScore(board);
  assert.ok(before.black > before.white);
  const res = searchOthelloMove(board, 'black', 2000);
  assert.ok(res.move, 'a move is returned for the endgame');
  // play the whole game out (hard for both sides) and confirm black wins.
  const state = session(board, 'black');
  let guard = 0;
  while (state.status === 'playing' && guard < 20) {
    const mv = searchOthelloMove(state.board, state.currentTurn, 500).move;
    if (!mv) break;
    applyOthelloMove(state, state.currentTurn === 'black' ? 'b' : 'w', mv.row, mv.col, 'manual');
    guard += 1;
  }
  const finalScore = othelloScore(state.board);
  assert.ok(finalScore.black > finalScore.white, `black should keep the win: ${JSON.stringify(finalScore)}`);
});

// ---------------------------------------------------------------------------
// hard vs medium self-play
// ---------------------------------------------------------------------------

function playOthelloGame(hardColor, budgetMs) {
  const state = session(initialOthelloBoard(), 'black');
  let guard = 0;
  while (state.status === 'playing' && guard < 80) {
    const turn = state.currentTurn;
    if (othelloLegalMoves(state.board, turn).length === 0) break; // applyOthelloMove handles passes; safety only
    const move =
      turn === hardColor
        ? searchOthelloMove(state.board, turn, budgetMs).move
        : chooseOthelloAiMove({ board: state.board, currentTurn: turn, aiDifficulty: 'medium' });
    if (!move) break;
    applyOthelloMove(state, turn === 'black' ? 'b' : 'w', move.row, move.col, 'manual');
    guard += 1;
  }
  const score = othelloScore(state.board);
  if (score.black === score.white) return undefined;
  return score.black > score.white ? 'black' : 'white';
}

test('hard othello beats medium in at least 80% of 20 games', () => {
  let hardWins = 0;
  for (let g = 0; g < 20; g += 1) {
    const hardColor = g % 2 === 0 ? 'black' : 'white';
    const winner = playOthelloGame(hardColor, HARD_SELFPLAY_BUDGET_MS);
    if (winner === hardColor) hardWins += 1;
  }
  assert.ok(hardWins >= 16, `hard won ${hardWins}/20 (need >= 16)`);
});
