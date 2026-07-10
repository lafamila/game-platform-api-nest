import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIGHTING_ENGINE,
  FIGHTING_MAX_HP,
  FIGHTING_MIN_ROUND_MS,
  FIGHTING_ROUND_TIME_SECONDS,
} from '../dist/games/fighting-engine.js';
import { GAME_REGISTRY } from '../dist/games/engine/game-registry.js';

const HUMAN = [{ seat: 0, accountId: 'acct-1', kind: 'account' }];

function freshState() {
  return FIGHTING_ENGINE.createState(HUMAN, { id: 's1', aiDifficulty: 'hard' });
}

function roundPayload(overrides = {}) {
  return {
    round: 1,
    winner: 'player',
    reason: 'ko',
    playerHp: 40,
    aiHp: 0,
    durationMs: 12_000,
    ...overrides,
  };
}

function apply(state, payload) {
  return FIGHTING_ENGINE.applyAction(state, 0, { type: 'round_result', payload });
}

test('registry exposes fighting as a local_ai-only playable game', () => {
  const descriptor = GAME_REGISTRY.require('fighting');
  assert.equal(descriptor.status, 'playable');
  assert.deepEqual(descriptor.modes, ['local_ai']);
  assert.equal(descriptor.minPlayers, 1);
  assert.equal(descriptor.maxPlayers, 1);
  assert.equal(descriptor.supportsMatchSave, false);
});

test('createState seats the single human and starts a best-of-3', () => {
  const state = freshState();
  assert.equal(state.status, 'playing');
  assert.equal(state.players.seat0, 'acct-1');
  assert.equal(state.bestOf, 3);
  assert.equal(state.roundTimeSeconds, FIGHTING_ROUND_TIME_SECONDS);
  assert.equal(state.maxHp, FIGHTING_MAX_HP);
  assert.deepEqual(state.wins, { player: 0, ai: 0 });
  assert.equal(state.characters.player, 'martial_hero');
  assert.equal(state.characters.ai, 'martial_hero_2');
});

test('round numbers must be sequential', () => {
  const state = freshState();
  assert.throws(() => apply(state, roundPayload({ round: 2 })), /round must be 1/);
  apply(state, roundPayload());
  assert.throws(() => apply(state, roundPayload({ round: 1 })), /round must be 2/);
});

test('ko requires loser hp exactly 0 and winner hp above 0', () => {
  assert.throws(
    () => apply(freshState(), roundPayload({ aiHp: 5 })),
    /ko requires loser hp 0/,
  );
  assert.throws(
    () => apply(freshState(), roundPayload({ playerHp: 0, aiHp: 0 })),
    /ko requires loser hp 0 and winner hp > 0/,
  );
  assert.throws(
    () => apply(freshState(), roundPayload({ playerHp: 999 })),
    /hp must be within/,
  );
});

test('timeout requires the hp lead and a full-length round', () => {
  assert.throws(
    () =>
      apply(
        freshState(),
        roundPayload({ reason: 'timeout', playerHp: 10, aiHp: 30, durationMs: 61_000 }),
      ),
    /timeout winner must have the hp lead/,
  );
  assert.throws(
    () =>
      apply(
        freshState(),
        roundPayload({ reason: 'timeout', playerHp: 30, aiHp: 10, durationMs: 5_000 }),
      ),
    /timeout round cannot be shorter/,
  );
  const result = apply(
    freshState(),
    roundPayload({ reason: 'timeout', playerHp: 30, aiHp: 10, durationMs: 61_000 }),
  );
  assert.equal(result.state.rounds.length, 1);
});

test('round duration is bounded', () => {
  assert.throws(
    () => apply(freshState(), roundPayload({ durationMs: FIGHTING_MIN_ROUND_MS - 1 })),
    /durationMs must be within/,
  );
  assert.throws(
    () => apply(freshState(), roundPayload({ durationMs: 999_999 })),
    /durationMs must be within/,
  );
});

test('first to two round wins takes the match', () => {
  const state = freshState();
  apply(state, roundPayload());
  assert.equal(state.status, 'playing');
  const result = apply(state, roundPayload({ round: 2, playerHp: 15 }));
  assert.equal(result.state.status, 'finished');
  assert.equal(result.state.gameWinner?.winner, 'player');
  assert.equal(result.state.gameWinner?.accountId, 'acct-1');
  assert.deepEqual(result.state.gameWinner?.wins, { player: 2, ai: 0 });
  assert.equal(result.state.winnerAccountId, 'acct-1');
  assert.ok(result.events?.some((event) => event.type === 'fighting.match.finished'));
  const finish = FIGHTING_ENGINE.finishInfo(result.state);
  assert.equal(finish?.status, 'finished');
  assert.equal(finish?.winnerSeat, 0);
});

test('ai can win the match and results are rejected afterwards', () => {
  const state = freshState();
  apply(state, roundPayload({ winner: 'ai', playerHp: 0, aiHp: 22 }));
  apply(state, roundPayload({ round: 2, winner: 'ai', playerHp: 0, aiHp: 40 }));
  assert.equal(state.status, 'finished');
  assert.equal(state.gameWinner?.winner, 'ai');
  assert.equal(state.winnerAccountId, undefined);
  assert.equal(FIGHTING_ENGINE.finishInfo(state)?.winnerSeat, undefined);
  assert.throws(() => apply(state, roundPayload({ round: 3 })), /already finished/);
});

test('a full three-round match resolves by the rubber round', () => {
  const state = freshState();
  apply(state, roundPayload());
  apply(state, roundPayload({ round: 2, winner: 'ai', playerHp: 0, aiHp: 12 }));
  assert.equal(state.status, 'playing');
  apply(state, roundPayload({ round: 3, playerHp: 3 }));
  assert.equal(state.status, 'finished');
  assert.deepEqual(state.gameWinner?.wins, { player: 2, ai: 1 });
});

test('forfeit hands the match to the ai', () => {
  const state = freshState();
  FIGHTING_ENGINE.applyAction(state, 0, { type: 'forfeit' });
  assert.equal(state.status, 'finished');
  assert.equal(state.gameWinner?.winner, 'ai');
  assert.equal(state.finishReason, 'forfeit');
});

test('viewFor hides the idempotency store', () => {
  const state = freshState();
  state.recentClientMoves = { 'acct-1': ['m1'] };
  const view = FIGHTING_ENGINE.viewFor(state, 0);
  assert.equal(view.recentClientMoves, undefined);
  assert.equal(view.players.seat0, 'acct-1');
});
