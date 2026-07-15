import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REPLAY_DELAY_CLAMP_MS,
  computeReplayMoves,
  isLocalAiSentinel,
  isReplayGameKey,
  normalizeMoveHistory,
  reconstructSnapshots,
  resolveReplayWinner,
} from '../dist/replay/replay-builder.js';
import { applyOthelloMove, initialOthelloBoard, othelloLegalMoves } from '../dist/games/othello-engine.js';

const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// delayMs (D4): first move 0, real gap preserved, >30s clamped, negatives → 0
// ---------------------------------------------------------------------------

test('computeReplayMoves gives the first move a 0 delay', () => {
  const moves = computeReplayMoves([{ n: 0, type: 'move', seat: 0, color: 'black', x: 7, y: 7, at: iso(1000) }]);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].delayMs, 0);
});

test('computeReplayMoves preserves a normal gap and clamps a >30s gap', () => {
  const t0 = 1_000_000;
  const history = [
    { n: 0, type: 'move', seat: 0, color: 'black', x: 0, y: 0, at: iso(t0) },
    { n: 1, type: 'move', seat: 1, color: 'white', x: 1, y: 1, at: iso(t0 + 4200) },
    { n: 2, type: 'move', seat: 0, color: 'black', x: 2, y: 2, at: iso(t0 + 4200 + 90_000) },
  ];
  const moves = computeReplayMoves(history);
  assert.equal(moves[0].delayMs, 0);
  assert.equal(moves[1].delayMs, 4200);
  assert.equal(moves[2].delayMs, REPLAY_DELAY_CLAMP_MS);
});

test('computeReplayMoves clamps a negative (clock-skew) gap to 0', () => {
  const t0 = 5_000_000;
  const moves = computeReplayMoves([
    { n: 0, type: 'move', seat: 0, color: 'black', x: 0, y: 0, at: iso(t0) },
    { n: 1, type: 'move', seat: 1, color: 'white', x: 1, y: 1, at: iso(t0 - 500) },
  ]);
  assert.equal(moves[1].delayMs, 0);
});

test('a pass between two moves carries the move data forward untouched', () => {
  const t0 = 2_000_000;
  const moves = computeReplayMoves([
    { n: 0, type: 'move', seat: 0, color: 'black', x: 3, y: 2, at: iso(t0) },
    { n: 1, type: 'pass', seat: 1, color: 'white', at: iso(t0) },
    { n: 2, type: 'move', seat: 0, color: 'black', x: 2, y: 2, at: iso(t0 + 8000) },
  ]);
  assert.equal(moves[1].type, 'pass');
  assert.equal(moves[1].delayMs, 0);
  assert.equal(moves[2].delayMs, 8000);
});

// ---------------------------------------------------------------------------
// snapshot reconstruction (D4): must match the engine exactly, incl. flips + pass
// ---------------------------------------------------------------------------

test('gomoku snapshots place stones at the recorded coordinates (x=col, y=row)', () => {
  const history = [
    { n: 0, type: 'move', seat: 0, color: 'black', x: 7, y: 7, at: iso(0) },
    { n: 1, type: 'move', seat: 1, color: 'white', x: 8, y: 7, at: iso(1) },
  ];
  const snaps = reconstructSnapshots('gomoku', history);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0][7][7], 'black');
  assert.equal(snaps[0][7][8], null);
  assert.equal(snaps[1][7][7], 'black');
  assert.equal(snaps[1][7][8], 'white');
});

test('othello reconstruction reproduces the engine board after every ply', () => {
  const session = {
    id: 't', mode: 'friend_match', board: initialOthelloBoard(), currentTurn: 'black',
    status: 'playing', players: { black: 'b', white: 'w' }, moves: [], moveHistory: [], createdAt: '', updatedAt: '',
  };
  const expected = [];
  for (let i = 0; i < 12 && session.status === 'playing'; i += 1) {
    const legal = othelloLegalMoves(session.board, session.currentTurn);
    if (legal.length === 0) break;
    const before = session.moveHistory.length;
    applyOthelloMove(session, 'x', legal[0].row, legal[0].col, 'manual');
    for (let k = before; k < session.moveHistory.length; k += 1) {
      expected.push(session.board.map((row) => [...row]));
    }
  }
  const snaps = reconstructSnapshots('othello', session.moveHistory);
  assert.equal(snaps.length, session.moveHistory.length);
  assert.ok(session.moveHistory.length >= 8, 'expected several plies to have been played');
  assert.deepEqual(snaps, expected);
});

test('a pass snapshot is identical to the preceding board (hand-verified forced pass)', () => {
  // Forced-pass position: black plays (row0,col2) wiping the only white in cluster A;
  // afterwards white has no legal move but black still can (7,2) → white passes, black continues.
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
  board[0][0] = 'black';
  board[0][1] = 'white';
  board[7][0] = 'black';
  board[7][1] = 'white';
  const session = {
    id: 't', mode: 'friend_match', board, currentTurn: 'black',
    status: 'playing', players: { black: 'b', white: 'w' }, moves: [], moveHistory: [], createdAt: '', updatedAt: '',
  };
  // precondition: (0,2) is a legal black move
  assert.ok(othelloLegalMoves(board, 'black').some((m) => m.row === 0 && m.col === 2));
  applyOthelloMove(session, 'b', 0, 2, 'manual');

  assert.equal(session.currentTurn, 'black'); // stayed with black → white was skipped
  assert.equal(session.moveHistory.length, 2);
  assert.deepEqual(
    { type: session.moveHistory[0].type, x: session.moveHistory[0].x, y: session.moveHistory[0].y, color: session.moveHistory[0].color },
    { type: 'move', x: 2, y: 0, color: 'black' },
  );
  assert.deepEqual(
    { type: session.moveHistory[1].type, color: session.moveHistory[1].color, seat: session.moveHistory[1].seat },
    { type: 'pass', color: 'white', seat: 1 },
  );
  // Snapshots are reconstructed from the true initialOthelloBoard() (production invariant:
  // every session's moveHistory starts from the opening), so the synthetic pre-placed stones
  // here are not part of them — we only assert that the pass leaves the board unchanged and
  // that the recorded move coordinate lands. (Flip-from-initial correctness is covered above.)
  const snaps = reconstructSnapshots('othello', session.moveHistory);
  assert.deepEqual(snaps[1], snaps[0]); // pass leaves the board unchanged
  assert.equal(snaps[0][0][2], 'black'); // the recorded move (x=2,y=0) landed
});

// ---------------------------------------------------------------------------
// winner resolution
// ---------------------------------------------------------------------------

test('resolveReplayWinner maps a winning colour to its account, AI, or draw', () => {
  assert.equal(
    resolveReplayWinner({ winner: 'black', players: { black: 'acc-1', white: 'acc-2' } }),
    'acc-1',
  );
  assert.equal(
    resolveReplayWinner({ winner: 'white', players: { black: 'acc-1', white: '__game_platform_local_ai__' } }),
    'ai',
  );
  assert.equal(resolveReplayWinner({ finishReason: 'draw', players: {} }), 'draw');
  assert.equal(resolveReplayWinner({ finishReason: 'server_restart', players: {} }), null);
});

test('replay helpers guard game keys, sentinels, and malformed history', () => {
  assert.ok(isReplayGameKey('gomoku'));
  assert.ok(isReplayGameKey('othello'));
  assert.ok(!isReplayGameKey('sudoku'));
  assert.ok(isLocalAiSentinel('__game_platform_local_ai__'));
  assert.ok(isLocalAiSentinel('__game_platform_local_ai__#room-1-0-easy'));
  assert.ok(!isLocalAiSentinel('acc-1'));
  assert.deepEqual(normalizeMoveHistory(undefined), []);
  assert.deepEqual(normalizeMoveHistory('nope'), []);
  assert.equal(normalizeMoveHistory([{ type: 'move', at: '2026-01-01T00:00:00Z' }, { bad: true }]).length, 1);
});
