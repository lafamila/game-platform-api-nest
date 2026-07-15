import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeDb, FakeRealtime } from './helpers/fake-db.mjs';

import {
  OTHELLO_ENGINE,
  applyOthelloMove,
  finishOthello,
  initialOthelloBoard,
  oppositeOthello,
  othelloFlips,
  othelloLegalMoves,
  othelloScore,
} from '../dist/games/othello-engine.js';
import { GamesService } from '../dist/games/games.service.js';

const user = {
  accountId: 'player-1',
  subject: 'player-1',
  serviceKey: 'game-platform',
  permission: 'player',
  claims: {},
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sessionWith(board, currentTurn = 'black', players = { black: 'p-black', white: 'p-white' }) {
  return {
    id: 'othello-test',
    mode: 'friend_match',
    board,
    currentTurn,
    status: 'playing',
    players,
    moves: [],
    createdAt: '',
    updatedAt: '',
  };
}

// ---------------------------------------------------------------------------
// rule regressions (lock current behaviour)
// ---------------------------------------------------------------------------

test('the initial board has the four centre stones', () => {
  const board = initialOthelloBoard();
  assert.equal(board[3][3], 'white');
  assert.equal(board[3][4], 'black');
  assert.equal(board[4][3], 'black');
  assert.equal(board[4][4], 'white');
  assert.deepEqual(othelloScore(board), { black: 2, white: 2 });
});

test('black has the four standard opening moves', () => {
  const moves = othelloLegalMoves(initialOthelloBoard(), 'black');
  assert.equal(moves.length, 4);
  const coords = moves.map((m) => `${m.row},${m.col}`).sort();
  assert.deepEqual(coords, ['2,3', '3,2', '4,5', '5,4']);
});

test('flips are computed along a bracketed line', () => {
  const flips = othelloFlips(initialOthelloBoard(), 2, 3, 'black');
  assert.equal(flips.length, 1);
  assert.deepEqual(flips[0], [3, 3]);
  // an empty cell that brackets nothing is not a legal move
  assert.equal(othelloFlips(initialOthelloBoard(), 0, 0, 'black').length, 0);
});

test('applying a move flips the bracketed stones and passes the turn', () => {
  const session = sessionWith(initialOthelloBoard());
  applyOthelloMove(session, 'p-black', 2, 3, 'manual');
  assert.equal(session.board[2][3], 'black');
  assert.equal(session.board[3][3], 'black');
  assert.equal(session.currentTurn, 'white');
  assert.equal(session.moves.length, 1);
  assert.equal(session.moves[0].flipped, 1);
});

test('an illegal (non-flipping) move is rejected', () => {
  const session = sessionWith(initialOthelloBoard());
  assert.throws(() => applyOthelloMove(session, 'p-black', 0, 0, 'manual'), /not a legal othello move/);
});

test('finishOthello scores the board and picks the majority colour', () => {
  const board = initialOthelloBoard();
  board[0][0] = 'black'; // black 3, white 2
  const session = sessionWith(board);
  finishOthello(session);
  assert.equal(session.status, 'finished');
  assert.equal(session.finishReason, 'board_complete');
  assert.equal(session.winner, 'black');
});

test('a tied board finishes as a draw', () => {
  const session = sessionWith(initialOthelloBoard());
  finishOthello(session);
  assert.equal(session.status, 'finished');
  assert.equal(session.finishReason, 'draw');
  assert.equal(session.winner, undefined);
});

test('the engine applyAction path applies a legal opening move', () => {
  const session = OTHELLO_ENGINE.createState(
    [
      { seat: 0, kind: 'account', accountId: 'player-1' },
      { seat: 1, kind: 'account', accountId: 'player-2' },
    ],
    { id: 'othello-engine-1', mode: 'friend_match', aiDifficulty: 'medium' },
  );
  assert.equal(session.board[3][3], 'white');
  const result = OTHELLO_ENGINE.applyAction(session, 0, { type: 'move', payload: { row: 2, col: 3 } });
  assert.equal(result.state.board[2][3], 'black');
  assert.equal(result.state.board[3][3], 'black');
  assert.equal(result.state.currentTurn, 'white');
});

test('opposite colour helper flips black and white', () => {
  assert.equal(oppositeOthello('black'), 'white');
  assert.equal(oppositeOthello('white'), 'black');
});

// ---------------------------------------------------------------------------
// colour selection (local_ai): white pick → AI takes black and moves first
// ---------------------------------------------------------------------------

test('othello white pick makes the AI take black and open the game', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const session = await service.createOthelloSession(user, undefined, undefined, 'medium', 'white');
  assert.equal(session.mode, 'local_ai');
  assert.equal(session.players.white, user.accountId);
  assert.notEqual(session.players.black, user.accountId);
  assert.equal(session.currentTurn, 'black');

  await wait(450);
  const waiting = await service.getOthelloSession(session.id, user);
  assert.equal(waiting.moves.length, 0);
  assert.equal(waiting.currentTurn, 'black');

  await wait(3900);
  const answered = await service.getOthelloSession(session.id, user);
  assert.equal(answered.moves.length, 1);
  assert.equal(answered.moves[0].source, 'ai');
  assert.equal(answered.moves[0].color, 'black');
  assert.equal(answered.currentTurn, 'white');
});

test('othello default keeps the human on black and the AI waits', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const session = await service.createOthelloSession(user, undefined, undefined, 'medium');
  assert.equal(session.players.black, user.accountId);
  assert.notEqual(session.players.white, user.accountId);
  assert.equal(session.currentTurn, 'black');

  await wait(300);
  const idle = await service.getOthelloSession(session.id, user);
  assert.equal(idle.moves.length, 0);
});
