import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeDb, FakeRealtime } from './helpers/fake-db.mjs';
import { GamesService } from '../dist/games/games.service.js';
import { applyGomokuMove, initialGomokuBoard } from '../dist/games/gomoku-engine.js';
import { applyOthelloMove, initialOthelloBoard, othelloLegalMoves } from '../dist/games/othello-engine.js';

const user = {
  accountId: 'player-1', subject: 'player-1', serviceKey: 'game-platform', permission: 'player', claims: {},
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeoutMs = 8000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(stepMs);
  }
  return false;
}

function gomokuSession() {
  return {
    id: 'g', mode: 'friend_match', board: initialGomokuBoard(), currentTurn: 'black',
    status: 'playing', players: { black: 'b', white: 'w' }, moves: [], moveHistory: [], createdAt: '', updatedAt: '',
  };
}

// ---------------------------------------------------------------------------
// engine-level: every source (manual/timeout/ai) funnels through the exported
// apply functions, so recording there captures all of them.
// ---------------------------------------------------------------------------

test('gomoku records a manual move into moveHistory with x=col/y=row', () => {
  const session = gomokuSession();
  applyGomokuMove(session, 'b', 7, 8, 'manual'); // row 7, col 8
  assert.equal(session.moveHistory.length, 1);
  const entry = session.moveHistory[0];
  assert.equal(entry.n, 0);
  assert.equal(entry.type, 'move');
  assert.equal(entry.seat, 0);
  assert.equal(entry.color, 'black');
  assert.equal(entry.x, 8);
  assert.equal(entry.y, 7);
  assert.equal(entry.at, session.moves[0].createdAt); // shares the move timestamp
});

test('gomoku records a timer auto-move (source=timeout) just the same', () => {
  const session = gomokuSession();
  applyGomokuMove(session, 'b', 7, 7, 'manual');
  applyGomokuMove(session, 'w', 7, 8, 'timeout');
  assert.equal(session.moveHistory.length, 2);
  assert.equal(session.moveHistory[1].seat, 1);
  assert.equal(session.moveHistory[1].color, 'white');
  assert.equal(session.moveHistory[1].type, 'move');
});

test('othello records a move and the opponent forced pass', () => {
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
  board[0][0] = 'black'; board[0][1] = 'white'; board[7][0] = 'black'; board[7][1] = 'white';
  const session = {
    id: 'o', mode: 'friend_match', board, currentTurn: 'black',
    status: 'playing', players: { black: 'b', white: 'w' }, moves: [], moveHistory: [], createdAt: '', updatedAt: '',
  };
  assert.ok(othelloLegalMoves(board, 'black').some((m) => m.row === 0 && m.col === 2));
  applyOthelloMove(session, 'b', 0, 2, 'manual');
  assert.deepEqual(
    session.moveHistory.map((e) => e.type),
    ['move', 'pass'],
  );
  assert.equal(session.moveHistory[1].color, 'white');
  assert.equal(session.moveHistory[1].x, undefined);
});

test('othello standard opening move is recorded without a pass', () => {
  const session = {
    id: 'o2', mode: 'friend_match', board: initialOthelloBoard(), currentTurn: 'black',
    status: 'playing', players: { black: 'b', white: 'w' }, moves: [], moveHistory: [], createdAt: '', updatedAt: '',
  };
  applyOthelloMove(session, 'b', 2, 3, 'manual');
  assert.equal(session.moveHistory.length, 1);
  assert.equal(session.moveHistory[0].type, 'move');
  assert.equal(session.moveHistory[0].color, 'black');
});

// ---------------------------------------------------------------------------
// service-level: the local-AI move path records into moveHistory end-to-end.
// (white pick → AI takes black and opens the game.)
// ---------------------------------------------------------------------------

test('gomoku local-AI move is recorded through the service', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const created = await service.createGomokuSession(user, undefined, undefined, 'medium', 'white');
  const ready = await until(async () => (await service.getGomokuSession(created.id, user)).moveHistory?.length >= 1);
  assert.ok(ready, 'AI move should have been recorded');
  const session = await service.getGomokuSession(created.id, user);
  assert.equal(session.moveHistory[0].color, 'black');
  assert.equal(session.moveHistory[0].type, 'move');
  assert.equal(typeof session.moveHistory[0].x, 'number');
  assert.equal(typeof session.moveHistory[0].at, 'string');
});

test('othello local-AI move is recorded through the service', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const created = await service.createOthelloSession(user, undefined, undefined, 'medium', 'white');
  const ready = await until(async () => (await service.getOthelloSession(created.id, user)).moveHistory?.length >= 1);
  assert.ok(ready, 'AI move should have been recorded');
  const session = await service.getOthelloSession(created.id, user);
  assert.equal(session.moveHistory[0].color, 'black');
  assert.equal(session.moveHistory[0].type, 'move');
});
