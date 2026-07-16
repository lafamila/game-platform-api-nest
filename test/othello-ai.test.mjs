import assert from 'node:assert/strict';
import test from 'node:test';

import { othelloPhaseBudgetMs, searchOthelloMove } from '../dist/games/othello-ai.js';
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

function boardWithEmpties(count) {
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 'black'));
  for (let index = 0; index < count; index += 1) board[Math.floor(index / 8)][index % 8] = null;
  return board;
}

const ORACLE_DIRECTIONS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

function oracleMoves(board, color) {
  const opponent = color === 'black' ? 'white' : 'black';
  const moves = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      if (board[row][col] !== null) continue;
      const flips = [];
      for (const [dr, dc] of ORACLE_DIRECTIONS) {
        const line = [];
        let r = row + dr;
        let c = col + dc;
        while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === opponent) {
          line.push([r, c]);
          r += dr;
          c += dc;
        }
        if (line.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === color) {
          flips.push(...line);
        }
      }
      if (flips.length > 0) moves.push({ row, col, flips });
    }
  }
  return moves;
}

function oracleApply(board, color, move) {
  const next = board.map((row) => [...row]);
  next[move.row][move.col] = color;
  for (const [row, col] of move.flips) next[row][col] = color;
  return next;
}

function oracleSolve(board, color, memo = new Map()) {
  const key = `${color}:${board.flat().map((cell) => cell?.[0] ?? '.').join('')}`;
  const cached = memo.get(key);
  if (cached) return cached;
  const opponent = color === 'black' ? 'white' : 'black';
  const moves = oracleMoves(board, color);
  if (moves.length === 0) {
    if (oracleMoves(board, opponent).length === 0) {
      const discs = board.flat();
      const score = discs.filter((cell) => cell === color).length - discs.filter((cell) => cell === opponent).length;
      const result = { score, moves: [] };
      memo.set(key, result);
      return result;
    }
    const result = { score: -oracleSolve(board, opponent, memo).score, moves: [] };
    memo.set(key, result);
    return result;
  }
  let bestScore = Number.NEGATIVE_INFINITY;
  const bestMoves = [];
  for (const move of moves) {
    const score = -oracleSolve(oracleApply(board, color, move), opponent, memo).score;
    if (score > bestScore) {
      bestScore = score;
      bestMoves.length = 0;
      bestMoves.push({ row: move.row, col: move.col });
    } else if (score === bestScore) {
      bestMoves.push({ row: move.row, col: move.col });
    }
  }
  const result = { score: bestScore, moves: bestMoves };
  memo.set(key, result);
  return result;
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

test('othello phase budget caps the opening through 50 empties and never increases a small budget', () => {
  assert.equal(othelloPhaseBudgetMs(boardWithEmpties(60), 25_000), 3_000);
  assert.equal(othelloPhaseBudgetMs(boardWithEmpties(50), 25_000), 3_000);
  assert.equal(othelloPhaseBudgetMs(boardWithEmpties(49), 25_000), 25_000);
  assert.equal(othelloPhaseBudgetMs(boardWithEmpties(60), 300), 300);
});

test('hard othello restores state and is deterministic when a node cap interrupts nested search', () => {
  const board = initialOthelloBoard();
  const original = structuredClone(board);
  const runs = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reports = [];
    const result = searchOthelloMove(
      board,
      'black',
      10_000,
      (report) => reports.push(report),
      { maxSearchNodes: 5_000, exactMode: 'off' },
    );
    assert.equal(result.diagnostics.exitReason, 'node_limit');
    assert.ok(result.move);
    assert.ok(othelloLegalMoves(board, 'black').some((move) => move.row === result.move.row && move.col === result.move.col));
    assert.deepEqual(board, original, 'search must not mutate the caller board');
    runs.push({ move: result.move, depth: result.depth, score: result.score, nodes: result.nodes, reports });
  }
  assert.deepEqual(runs[1], runs[0]);
});

test('every completed-depth report is legal on the unchanged root board', () => {
  const board = initialOthelloBoard();
  const legal = new Set(othelloLegalMoves(board, 'black').map((move) => `${move.row},${move.col}`));
  const reports = [];
  searchOthelloMove(board, 'black', 10_000, (report) => reports.push(report), {
    maxSearchNodes: 20_000,
    exactMode: 'off',
  });
  assert.ok(reports.length > 0);
  for (const report of reports) assert.ok(legal.has(`${report.move.row},${report.move.col}`));
});

test('an expired absolute deadline returns the legal depth-zero fallback without searching', () => {
  const board = initialOthelloBoard();
  const result = searchOthelloMove(board, 'black', 10_000, undefined, { deadlineAt: Date.now() - 1 });
  assert.ok(result.move);
  assert.equal(result.depth, 0);
  assert.equal(result.nodes, 0);
  assert.equal(result.diagnostics.budgetMs, 0);
  assert.equal(result.diagnostics.exitReason, 'timeout');
  assert.ok(othelloLegalMoves(board, 'black').some((move) => move.row === result.move.row && move.col === result.move.col));
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

test('hard othello exact result matches an independent oracle', () => {
  const board = [
    [null, 'black', 'white', 'white', 'white', 'white', 'white', 'white'],
    [null, 'white', 'white', 'white', 'black', 'black', 'black', 'black'],
    ['white', 'white', 'white', 'white', 'white', 'white', 'black', null],
    [null, 'black', 'black', 'white', 'white', 'white', 'black', 'black'],
    ['black', 'black', 'black', 'white', 'white', 'black', 'black', 'black'],
    [null, 'black', 'white', 'black', 'white', 'black', 'white', 'black'],
    [null, 'white', 'black', 'black', 'black', 'white', null, 'black'],
    ['white', null, 'white', 'black', 'black', 'black', 'black', 'black'],
  ];
  const oracle = oracleSolve(board, 'black');
  const result = searchOthelloMove(board, 'black', 500);
  assert.ok(result.move);
  assert.ok(oracle.moves.some((move) => move.row === result.move.row && move.col === result.move.col));
  const terminalDiscDifference = result.score > 500_000
    ? result.score - 1_000_000
    : result.score < -500_000
      ? result.score + 1_000_000
      : 0;
  assert.equal(terminalDiscDifference, oracle.score);
  assert.ok(['exact', 'proven'].includes(result.diagnostics.exitReason));
});

test('hard othello exact search handles an internal forced pass', () => {
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 'black'));
  board[0][1] = 'white';
  board[0][2] = null;
  board[7][1] = 'white';
  board[7][2] = null;
  const oracle = oracleSolve(board, 'black');
  const result = searchOthelloMove(board, 'black', 500);
  assert.ok(result.move);
  assert.ok(oracle.moves.some((move) => move.row === result.move.row && move.col === result.move.col));
  assert.equal(result.score - 1_000_000, oracle.score);
  assert.equal(result.diagnostics.exitReason, 'exact');
});

test('hard othello returns null when the current color has no legal move', () => {
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 'black'));
  const result = searchOthelloMove(board, 'white', 1_000);
  assert.equal(result.move, null);
  assert.equal(result.diagnostics.exitReason, 'no_legal_move');
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
