import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SPLENDOR_ENGINE,
  applySplendorForfeit,
  createSplendorStateForPlayers,
} from '../dist/games/splendor-engine.js';

function fourPlayerState(seed = 'forfeit-seed') {
  const seats = [0, 1, 2, 3].map((index) => ({ side: `seat${index}`, accountId: `player-${index}` }));
  return createSplendorStateForPlayers(seats, 'friend_match', undefined, seed);
}

function takeThree(state, seatIndex) {
  return SPLENDOR_ENGINE.applyAction(state, seatIndex, {
    type: 'take_tokens',
    payload: { tokens: { white: 1, blue: 1, green: 1 } },
  }).state;
}

test('N-player splendor keeps playing after a seat forfeits (M3)', () => {
  const state = fourPlayerState();
  assert.deepEqual(state.turnOrder, ['seat0', 'seat1', 'seat2', 'seat3']);
  assert.equal(state.currentTurn, 'seat0');

  // seat1 (not the current turn) forfeits — the game continues with 3 active seats.
  applySplendorForfeit(state, 'seat1', 'player-1');
  assert.equal(state.status, 'playing');
  assert.equal(state.seatStatus.seat1, 'forfeited');
  assert.equal(state.seatStatus.seat0, 'active');
  assert.equal(state.currentTurn, 'seat0');
});

test('turn rotation skips forfeited seats (M4)', () => {
  let state = fourPlayerState();
  applySplendorForfeit(state, 'seat1', 'player-1');

  // seat0 takes a turn: next active seat is seat2 (seat1 skipped).
  state = takeThree(state, 0);
  assert.equal(state.currentTurn, 'seat2');

  // seat2 -> seat3 -> wraps back to seat0 (seat1 still skipped).
  state = takeThree(state, 2);
  assert.equal(state.currentTurn, 'seat3');
  state = takeThree(state, 3);
  assert.equal(state.currentTurn, 'seat0');
});

test('game ends with the last active seat winning (M3)', () => {
  const state = fourPlayerState();
  applySplendorForfeit(state, 'seat1', 'player-1');
  applySplendorForfeit(state, 'seat2', 'player-2');
  assert.equal(state.status, 'playing'); // seat0 + seat3 still active
  applySplendorForfeit(state, 'seat3', 'player-3');
  assert.equal(state.status, 'finished');
  assert.equal(state.winnerSide, 'seat0');
  assert.equal(state.winnerAccountId, 'player-0');
  assert.equal(state.finishReason, 'forfeit');
});

test('forfeiting the current seat advances the turn to the next active seat', () => {
  const state = fourPlayerState();
  // seat0 (current) forfeits with seat1..3 active -> game continues, turn moves to seat1.
  applySplendorForfeit(state, 'seat0', 'player-0');
  assert.equal(state.status, 'playing');
  assert.equal(state.currentTurn, 'seat1');
});

test('2-player forfeit still finishes immediately (backward compatible)', () => {
  const seats = [
    { side: 'challenger', accountId: 'player-a' },
    { side: 'opponent', accountId: 'player-b' },
  ];
  const state = createSplendorStateForPlayers(seats, 'friend_match', undefined, 'two-player-seed');
  applySplendorForfeit(state, 'challenger', 'player-a');
  assert.equal(state.status, 'finished');
  assert.equal(state.winnerSide, 'opponent');
  assert.equal(state.winnerAccountId, 'player-b');
  assert.equal(state.finishReason, 'forfeit');
});
