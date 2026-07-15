import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeDb, FakeRealtime } from './helpers/fake-db.mjs';

import {
  countFours,
  countOpenThrees,
  getForbiddenReason,
  isExactFive,
  makesOverline,
} from '../dist/games/gomoku-rules.js';
import {
  GOMOKU_ENGINE,
  GOMOKU_FORBIDDEN_MESSAGES,
  applyGomokuMove,
  chooseGomokuAiMove,
  initialGomokuBoard,
  oppositeGomokuColor,
} from '../dist/games/gomoku-engine.js';
import { GamesService } from '../dist/games/games.service.js';

const user = {
  accountId: 'player-1',
  subject: 'player-1',
  serviceKey: 'game-platform',
  permission: 'player',
  claims: {},
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A board with the listed black/white stones placed. The candidate move is NOT placed —
// getForbiddenReason places the black stone internally and restores it.
function boardWith(black = [], white = []) {
  const board = initialGomokuBoard();
  for (const [r, c] of black) board[r][c] = 'black';
  for (const [r, c] of white) board[r][c] = 'white';
  return board;
}

function place(board, r, c, color) {
  const next = board.map((row) => [...row]);
  next[r][c] = color;
  return next;
}

function sessionWith(board, currentTurn, players = { black: 'p-black', white: 'p-white' }) {
  return {
    id: 'gomoku-test',
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
// exact-five / overline primitives (both colors: win == exactly five)
// ---------------------------------------------------------------------------

test('isExactFive is true only for a run of exactly five', () => {
  const four = place(boardWith([[7, 3], [7, 4], [7, 5]]), 7, 6, 'black');
  assert.equal(isExactFive(four, 7, 6, 'black'), false);

  const five = place(boardWith([[7, 3], [7, 4], [7, 5], [7, 6]]), 7, 7, 'black');
  assert.equal(isExactFive(five, 7, 7, 'black'), true);

  // six in a row is an overline, not a five
  const six = place(boardWith([[7, 2], [7, 3], [7, 4], [7, 5], [7, 6]]), 7, 7, 'black');
  assert.equal(isExactFive(six, 7, 7, 'black'), false);
  assert.equal(makesOverline(six, 7, 7, 'black'), true);
});

test('exact-five detection is colour independent', () => {
  const whiteFive = place(boardWith([], [[7, 3], [7, 4], [7, 5], [7, 6]]), 7, 7, 'white');
  assert.equal(isExactFive(whiteFive, 7, 7, 'white'), true);
});

// ---------------------------------------------------------------------------
// double-three (삼삼)
// ---------------------------------------------------------------------------

test('double-three: two crossing open threes are forbidden for black', () => {
  // horizontal .OOO.  vertical .OOO.  sharing (7,7)
  const board = boardWith([[7, 5], [7, 6], [5, 7], [6, 7]]);
  assert.equal(getForbiddenReason(board, 7, 7), 'double-three');
});

test('double-three: a broken three (.O.OO.) still counts', () => {
  // horizontal X _ X X (cols 5,_,7,8) is an open (broken) three via (7,6);
  // vertical is a plain open three.
  const board = boardWith([[7, 5], [7, 8], [5, 7], [6, 7]]);
  assert.equal(getForbiddenReason(board, 7, 7), 'double-three');
});

test('a single open three (with one closed three) is allowed', () => {
  // horizontal open three, vertical three blocked on one end by white → only one open three
  const board = boardWith([[7, 5], [7, 6], [5, 7], [6, 7]], [[4, 7]]);
  assert.equal(getForbiddenReason(board, 7, 7), null);
  const placed = place(board, 7, 7, 'black');
  assert.equal(countOpenThrees(placed, 7, 7, 'black'), 1);
});

test('a lone open three is not forbidden', () => {
  const board = boardWith([[7, 5], [7, 6]]);
  assert.equal(getForbiddenReason(board, 7, 7), null);
});

// ---------------------------------------------------------------------------
// double-four (사사)
// ---------------------------------------------------------------------------

test('double-four: two fours on crossing lines are forbidden for black', () => {
  const board = boardWith([[7, 4], [7, 5], [7, 6], [4, 7], [5, 7], [6, 7]]);
  assert.equal(getForbiddenReason(board, 7, 7), 'double-four');
});

test('double-four: two fours on the SAME line are forbidden', () => {
  // XXX _ ? _ XXX with the candidate at the shared centre gap: playing (7,5) makes
  // a five at (7,4) [cols 1-5] and a five at (7,6) [cols 5-9] → two distinct fours.
  const board = boardWith([[7, 1], [7, 2], [7, 3], [7, 7], [7, 8], [7, 9]]);
  assert.equal(getForbiddenReason(board, 7, 5), 'double-four');
  const placed = place(board, 7, 5, 'black');
  assert.equal(countFours(placed, 7, 5, 'black'), 2);
});

test('a lone (closed) four is not forbidden', () => {
  const board = boardWith([[7, 4], [7, 5], [7, 6]], [[7, 8]]);
  assert.equal(getForbiddenReason(board, 7, 7), null);
  const placed = place(board, 7, 7, 'black');
  assert.equal(countFours(placed, 7, 7, 'black'), 1);
});

// ---------------------------------------------------------------------------
// overline (장목)
// ---------------------------------------------------------------------------

test('overline: making six in a row is forbidden for black', () => {
  const board = boardWith([[7, 3], [7, 4], [7, 5], [7, 7], [7, 8]]);
  assert.equal(getForbiddenReason(board, 7, 6), 'overline');
});

// ---------------------------------------------------------------------------
// five precedence
// ---------------------------------------------------------------------------

test('five precedence: a move that completes an exact five is never forbidden', () => {
  // Without the horizontal five this would be a double-three (vertical + diagonal).
  const board = boardWith([
    [7, 3], [7, 4], [7, 5], [7, 6], // horizontal → exact five when (7,7) is played
    [5, 7], [6, 7], // vertical open three
    [5, 5], [6, 6], // diagonal open three
  ]);
  assert.equal(getForbiddenReason(board, 7, 7), null);
  const placed = place(board, 7, 7, 'black');
  assert.equal(isExactFive(placed, 7, 7, 'black'), true);
});

// ---------------------------------------------------------------------------
// engine wiring: applyGomokuMove enforces the rules + the message contract
// ---------------------------------------------------------------------------

test('applyGomokuMove rejects a black double-three with the contract message', () => {
  const session = sessionWith(boardWith([[7, 5], [7, 6], [5, 7], [6, 7]]), 'black');
  assert.throws(
    () => applyGomokuMove(session, 'p-black', 7, 7, 'manual'),
    (err) => err.message === GOMOKU_FORBIDDEN_MESSAGES['double-three'],
  );
  assert.equal(GOMOKU_FORBIDDEN_MESSAGES['double-three'], 'forbidden move for black: double-three (삼삼)');
  // the stone must not have been placed on rejection
  assert.equal(session.board[7][7], null);
  assert.equal(session.currentTurn, 'black');
});

test('applyGomokuMove rejects a black double-four with the contract message', () => {
  const session = sessionWith(boardWith([[7, 1], [7, 2], [7, 3], [7, 7], [7, 8], [7, 9]]), 'black');
  assert.throws(
    () => applyGomokuMove(session, 'p-black', 7, 5, 'manual'),
    (err) => err.message === GOMOKU_FORBIDDEN_MESSAGES['double-four'],
  );
  assert.equal(GOMOKU_FORBIDDEN_MESSAGES['double-four'], 'forbidden move for black: double-four (사사)');
});

test('applyGomokuMove rejects a black overline with the contract message', () => {
  const session = sessionWith(boardWith([[7, 3], [7, 4], [7, 5], [7, 7], [7, 8]]), 'black');
  assert.throws(
    () => applyGomokuMove(session, 'p-black', 7, 6, 'manual'),
    (err) => err.message === GOMOKU_FORBIDDEN_MESSAGES['overline'],
  );
  assert.equal(GOMOKU_FORBIDDEN_MESSAGES['overline'], 'forbidden move for black: overline (장목)');
});

test('black wins on an exact five', () => {
  const session = sessionWith(boardWith([[7, 3], [7, 4], [7, 5], [7, 6]]), 'black');
  applyGomokuMove(session, 'p-black', 7, 7, 'manual');
  assert.equal(session.status, 'finished');
  assert.equal(session.winner, 'black');
});

test('a black move completing five is allowed even when it also forms a double-three', () => {
  const session = sessionWith(
    boardWith([[7, 3], [7, 4], [7, 5], [7, 6], [5, 7], [6, 7], [5, 5], [6, 6]]),
    'black',
  );
  assert.doesNotThrow(() => applyGomokuMove(session, 'p-black', 7, 7, 'manual'));
  assert.equal(session.status, 'finished');
  assert.equal(session.winner, 'black');
});

test('white is never subject to forbidden moves and may play a 3-3 shape', () => {
  const session = sessionWith(boardWith([], [[7, 5], [7, 6], [5, 7], [6, 7]]), 'white');
  assert.doesNotThrow(() => applyGomokuMove(session, 'p-white', 7, 7, 'manual'));
  assert.equal(session.board[7][7], 'white');
  assert.equal(session.status, 'playing');
  assert.equal(session.currentTurn, 'black');
});

test('white may create an overline but it is not a win; play continues', () => {
  // white cols 2,3,4 and 6,7 → playing col 5 makes six in a row
  const session = sessionWith(boardWith([], [[7, 2], [7, 3], [7, 4], [7, 6], [7, 7]]), 'white');
  applyGomokuMove(session, 'p-white', 7, 5, 'manual');
  assert.equal(session.board[7][5], 'white');
  assert.equal(session.status, 'playing');
  assert.equal(session.winner, undefined);
  assert.equal(session.currentTurn, 'black');
});

test('white still wins on an exact five', () => {
  const session = sessionWith(boardWith([], [[7, 3], [7, 4], [7, 5], [7, 6]]), 'white');
  applyGomokuMove(session, 'p-white', 7, 7, 'manual');
  assert.equal(session.status, 'finished');
  assert.equal(session.winner, 'white');
});

// ---------------------------------------------------------------------------
// existing engine contract (regression lock)
// ---------------------------------------------------------------------------

test('gomoku engine contract creates state and applies legal moves', () => {
  const session = GOMOKU_ENGINE.createState(
    [
      { seat: 0, kind: 'account', accountId: 'player-1' },
      { seat: 1, kind: 'account', accountId: 'player-2' },
    ],
    { id: 'gomoku-engine-1', mode: 'friend_match', aiDifficulty: 'medium' },
  );
  assert.equal(session.board.length, 15);
  assert.equal(session.currentTurn, 'black');
  const result = GOMOKU_ENGINE.applyAction(session, 0, { type: 'move', payload: { row: 7, col: 7 } });
  assert.equal(result.state.board[7][7], 'black');
  assert.equal(result.state.currentTurn, 'white');
});

// ---------------------------------------------------------------------------
// AI never returns a forbidden move when it is playing black
// ---------------------------------------------------------------------------

test('the gomoku AI never returns a forbidden move while playing black', () => {
  // (7,7) is the natural greedy pick but it is a double-three for black.
  const board = boardWith([[7, 5], [7, 6], [5, 7], [6, 7]]);
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const session = sessionWith(board.map((row) => [...row]), 'black', {
      black: '__game_platform_local_ai__',
      white: 'p-white',
    });
    for (let i = 0; i < 15; i += 1) {
      const move = chooseGomokuAiMove(session, difficulty);
      assert.ok(move, `${difficulty}: a move is returned`);
      assert.equal(
        getForbiddenReason(session.board, move.row, move.col),
        null,
        `${difficulty}: AI-black move (${move.row},${move.col}) must be legal`,
      );
    }
  }
});

test('opposite colour helper flips black and white', () => {
  assert.equal(oppositeGomokuColor('black'), 'white');
  assert.equal(oppositeGomokuColor('white'), 'black');
});

// ---------------------------------------------------------------------------
// colour selection (local_ai): white pick → AI takes black and moves first
// ---------------------------------------------------------------------------

test('gomoku white pick makes the AI take black and open the game', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const session = await service.createGomokuSession(user, undefined, undefined, 'medium', 'white');
  assert.equal(session.mode, 'local_ai');
  assert.equal(session.players.white, user.accountId);
  assert.notEqual(session.players.black, user.accountId);
  assert.equal(session.currentTurn, 'black');

  await wait(450);
  const waiting = await service.getGomokuSession(session.id, user);
  assert.equal(waiting.moves.length, 0);
  assert.equal(waiting.currentTurn, 'black');

  await wait(3900);
  const answered = await service.getGomokuSession(session.id, user);
  assert.equal(answered.moves.length, 1);
  assert.equal(answered.moves[0].source, 'ai');
  assert.equal(answered.moves[0].color, 'black');
  assert.equal(answered.currentTurn, 'white');
});

test('gomoku default keeps the human on black and the AI waits', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const session = await service.createGomokuSession(user, undefined, undefined, 'medium');
  assert.equal(session.players.black, user.accountId);
  assert.notEqual(session.players.white, user.accountId);
  assert.equal(session.currentTurn, 'black');

  await wait(300);
  const idle = await service.getGomokuSession(session.id, user);
  assert.equal(idle.moves.length, 0);
});
