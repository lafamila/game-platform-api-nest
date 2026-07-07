import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHASER_ENGINE,
  CHASER_CATEGORIES,
  CHASER_MAX_ROLLS,
  createChaserState,
  scoreChaserCategory,
  chaserScorePreview,
  chaserTotals,
  chaserViewFor,
  applyChaserForfeit,
  applyChaserTimeout,
} from '../dist/games/chaser-engine.js';
import { GAME_REGISTRY } from '../dist/games/engine/game-registry.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function localAiSeats(count) {
  return Array.from({ length: count }, (_, index) => ({ accountId: `p${index}` }));
}

function apply(state, seat, type, payload) {
  return CHASER_ENGINE.applyAction(state, seat, { type, payload }).state;
}

// ---------------------------------------------------------------------------
// 12칸 점수 계산 전수 (성립 / 불성립 / 0점)
// ---------------------------------------------------------------------------

test('number categories sum only their own face', () => {
  assert.equal(scoreChaserCategory([1, 1, 1, 4, 5], 'aces'), 3);
  assert.equal(scoreChaserCategory([2, 3, 4, 5, 6], 'aces'), 0);
  assert.equal(scoreChaserCategory([2, 2, 3, 3, 3], 'twoBeans'), 4);
  assert.equal(scoreChaserCategory([3, 3, 3, 3, 1], 'threeBeans'), 12);
  assert.equal(scoreChaserCategory([4, 4, 2, 1, 1], 'fourBeans'), 8);
  assert.equal(scoreChaserCategory([5, 5, 5, 1, 2], 'fiveBeans'), 15);
  assert.equal(scoreChaserCategory([6, 6, 6, 6, 6], 'sixBeans'), 30);
  assert.equal(scoreChaserCategory([1, 2, 3, 4, 5], 'sixBeans'), 0);
});

test('choice requires two distinct pairs and sums all five dice', () => {
  assert.equal(scoreChaserCategory([2, 2, 5, 5, 1], 'choice'), 15);
  // full house also contains two distinct pairs -> qualifies (원작 다수설)
  assert.equal(scoreChaserCategory([3, 3, 3, 2, 2], 'choice'), 13);
  // only one pair -> not two pair
  assert.equal(scoreChaserCategory([2, 2, 3, 4, 5], 'choice'), 0);
  // four of a kind is a single face -> not two pair
  assert.equal(scoreChaserCategory([4, 4, 4, 4, 1], 'choice'), 0);
  // five of a kind is a single face -> not two pair
  assert.equal(scoreChaserCategory([5, 5, 5, 5, 5], 'choice'), 0);
});

test('fourDice needs 4+ of a kind and 5-of-a-kind still qualifies here', () => {
  assert.equal(scoreChaserCategory([4, 4, 4, 4, 1], 'fourDice'), 17);
  assert.equal(scoreChaserCategory([5, 5, 5, 5, 5], 'fourDice'), 25); // 5동일도 fourDice 합
  assert.equal(scoreChaserCategory([4, 4, 4, 1, 2], 'fourDice'), 0);
});

test('fullHouse needs distinct 3+2; five-of-a-kind does NOT qualify', () => {
  assert.equal(scoreChaserCategory([3, 3, 3, 2, 2], 'fullHouse'), 13);
  assert.equal(scoreChaserCategory([5, 5, 5, 5, 5], 'fullHouse'), 0); // 5동일 불성립
  assert.equal(scoreChaserCategory([3, 3, 3, 2, 1], 'fullHouse'), 0); // no pair
});

test('fixed-score straights and chaseOff', () => {
  assert.equal(scoreChaserCategory([2, 3, 4, 5, 6], 'evenStraight'), 30);
  assert.equal(scoreChaserCategory([1, 2, 3, 4, 5], 'evenStraight'), 0);
  assert.equal(scoreChaserCategory([1, 2, 3, 4, 5], 'straight'), 40);
  assert.equal(scoreChaserCategory([2, 3, 4, 5, 6], 'straight'), 0);
  assert.equal(scoreChaserCategory([4, 4, 4, 4, 4], 'chaseOff'), 50);
  assert.equal(scoreChaserCategory([4, 4, 4, 4, 1], 'chaseOff'), 0);
});

test('five-of-a-kind: fourDice sum vs chaseOff 50 are both selectable', () => {
  const dice = [6, 6, 6, 6, 6];
  assert.equal(scoreChaserCategory(dice, 'fourDice'), 30);
  assert.equal(scoreChaserCategory(dice, 'chaseOff'), 50);
  assert.equal(scoreChaserCategory(dice, 'sixBeans'), 30);
  assert.equal(scoreChaserCategory(dice, 'fullHouse'), 0);
});

test('scoreChaserCategory rejects a non-5 dice array', () => {
  assert.throws(() => scoreChaserCategory([1, 2, 3], 'aces'));
});

test('there are exactly 12 categories', () => {
  assert.equal(CHASER_CATEGORIES.length, 12);
});

// ---------------------------------------------------------------------------
// seed reproducibility
// ---------------------------------------------------------------------------

test('same seed reproduces the identical roll sequence', () => {
  let a = createChaserState(localAiSeats(2), 'local_ai', { seed: 'repro' });
  let b = createChaserState(localAiSeats(2), 'local_ai', { seed: 'repro' });
  a = apply(a, 0, 'roll', {});
  b = apply(b, 0, 'roll', {});
  assert.deepEqual(a.dice, b.dice);
  // a reroll of the same positions is also reproducible
  a = apply(a, 0, 'roll', { keep: [true, false, false, false, false] });
  b = apply(b, 0, 'roll', { keep: [true, false, false, false, false] });
  assert.deepEqual(a.dice, b.dice);
  const c = createChaserState(localAiSeats(2), 'local_ai', { seed: 'other' });
  const c1 = apply(c, 0, 'roll', {});
  assert.notDeepEqual(a.dice, c1.dice);
});

// ---------------------------------------------------------------------------
// roll / keep / reroll limits
// ---------------------------------------------------------------------------

test('first roll ignores keep and rolls all five', () => {
  let state = createChaserState(localAiSeats(2), 'local_ai', { seed: 'first' });
  assert.equal(state.dice, null);
  assert.equal(state.rollsUsed, 0);
  state = apply(state, 0, 'roll', { keep: [true, true, true, true, true] });
  assert.equal(state.rollsUsed, 1);
  assert.equal(state.dice.length, 5);
  assert.deepEqual(state.kept, [false, false, false, false, false]);
});

test('reroll keeps the kept dice and only rerolls the rest', () => {
  let state = createChaserState(localAiSeats(2), 'local_ai', { seed: 'keep' });
  state = apply(state, 0, 'roll', {});
  const before = [...state.dice];
  state = apply(state, 0, 'roll', { keep: [true, true, false, false, false] });
  assert.equal(state.dice[0], before[0]);
  assert.equal(state.dice[1], before[1]);
  assert.deepEqual(state.kept, [true, true, false, false, false]);
  assert.equal(state.rollsUsed, 2);
});

test('at most 3 rolls per turn; a 4th roll is rejected', () => {
  let state = createChaserState(localAiSeats(2), 'local_ai', { seed: 'limit' });
  state = apply(state, 0, 'roll', {});
  state = apply(state, 0, 'roll', {});
  state = apply(state, 0, 'roll', {});
  assert.equal(state.rollsUsed, CHASER_MAX_ROLLS);
  assert.equal(state.canRoll ?? undefined, undefined); // canRoll is a view field, not on state
  assert.throws(() => apply(state, 0, 'roll', {}));
});

test('cannot score before rolling; cannot roll out of turn', () => {
  const state = createChaserState(localAiSeats(2), 'local_ai', { seed: 'guard' });
  assert.throws(() => apply(state, 0, 'score', { category: 'aces' }));
  assert.throws(() => apply(state, 1, 'roll', {})); // seat1 acting on seat0's turn
});

test('scoring a category twice is rejected and turn advances between seats', () => {
  let state = createChaserState(localAiSeats(2), 'local_ai', { seed: 'twice' });
  state = apply(state, 0, 'roll', {});
  state = apply(state, 0, 'score', { category: 'chaseOff' });
  assert.equal(state.currentSeat, 1);
  assert.equal(state.turnNumber, 2);
  assert.equal(state.rollsUsed, 0);
  assert.equal(state.dice, null);
  // seat1 now plays; scoring an already-used category on its own card is fine only if open
  state = apply(state, 1, 'roll', {});
  state = apply(state, 1, 'score', { category: 'chaseOff' });
  // back to seat0, who cannot re-score chaseOff
  state = apply(state, 0, 'roll', {});
  assert.throws(() => apply(state, 0, 'score', { category: 'chaseOff' }));
});

// ---------------------------------------------------------------------------
// scorePreview + viewFor hiding
// ---------------------------------------------------------------------------

test('scorePreview covers only unused categories for current dice', () => {
  const card = Object.fromEntries(CHASER_CATEGORIES.map((c) => [c, null]));
  card.aces = 2; // already used
  const preview = chaserScorePreview([1, 1, 1, 2, 3], card);
  assert.ok(!('aces' in preview));
  assert.equal(preview.threeBeans, 3);
  assert.equal(preview.straight, 0);
  assert.deepEqual(chaserScorePreview(null, card), {});
});

test('viewFor exposes public state but never the rngSeed', () => {
  let state = createChaserState(localAiSeats(3), 'local_ai', { seed: 'view' });
  state = apply(state, 0, 'roll', {});
  const view = chaserViewFor(state, 0);
  assert.ok(!('rngSeed' in view));
  assert.equal(view.gameKey, 'chaser');
  assert.equal(view.mySeat, 0);
  assert.equal(view.canRoll, true);
  assert.equal(view.canScore, true);
  assert.equal(view.dice.length, 5);
  assert.ok(view.scorecards.seat0);
  assert.ok('totals' in view);
  const spectator = chaserViewFor(state, 'spectator');
  assert.equal(spectator.mySeat, undefined);
  assert.ok(!('rngSeed' in spectator));
});

// ---------------------------------------------------------------------------
// player-count guards + mixed room start
// ---------------------------------------------------------------------------

test('player count guard: 2..5 only', () => {
  assert.throws(() => createChaserState(localAiSeats(1), 'local_ai', {}));
  assert.throws(() => createChaserState(localAiSeats(6), 'local_ai', {}));
  assert.equal(createChaserState(localAiSeats(2), 'local_ai', {}).seatCount, 2);
  assert.equal(createChaserState(localAiSeats(5), 'local_ai', {}).seatCount, 5);
});

test('5-player mixed (accounts + AI) start gives everyone empty scorecards', () => {
  const seats = [
    { accountId: 'human-a' },
    { accountId: 'human-b' },
    { accountId: '__game_platform_local_ai__#2' },
    { accountId: '__game_platform_local_ai__#3' },
    { accountId: '__game_platform_local_ai__#4' },
  ];
  const state = createChaserState(seats, 'friend_match', { seed: 'room5' });
  assert.equal(state.seatCount, 5);
  assert.equal(state.currentSeat, 0);
  for (let seat = 0; seat < 5; seat += 1) {
    const card = state.scorecards[`seat${seat}`];
    assert.ok(CHASER_CATEGORIES.every((c) => card[c] === null));
  }
});

test('chaser is registered in the game registry with 2-5 player bounds', () => {
  const descriptor = GAME_REGISTRY.get('chaser');
  assert.ok(descriptor, 'chaser descriptor must be registered');
  assert.equal(descriptor.minPlayers, 2);
  assert.equal(descriptor.maxPlayers, 5);
  assert.equal(descriptor.hiddenInfo, false);
  assert.equal(descriptor.supportsAi, true);
  assert.equal(descriptor.supportsMatchSave, true);
  assert.equal(descriptor.turnTimerSeconds, 60);
  assert.equal(descriptor.status, 'playable');
  assert.deepEqual([...descriptor.modes].sort(), ['friend_match', 'local_ai']);
  assert.ok(GAME_REGISTRY.engine('chaser'), 'chaser engine must be registered');
});

// ---------------------------------------------------------------------------
// forfeit: remaining categories zeroed; last one standing wins
// ---------------------------------------------------------------------------

test('forfeit zeroes the leaver remaining cells and continues with others', () => {
  let state = createChaserState(localAiSeats(3), 'local_ai', { seed: 'forfeit' });
  state = apply(state, 0, 'roll', {});
  state = apply(state, 0, 'score', { category: 'aces' }); // seat0 done one, now seat1's turn
  assert.equal(state.currentSeat, 1);
  applyChaserForfeit(state, 1); // seat1 leaves on its turn
  assert.equal(state.seatStatus.seat1, 'left');
  const card = state.scorecards.seat1;
  assert.ok(CHASER_CATEGORIES.every((c) => card[c] === 0));
  assert.equal(state.status, 'playing'); // seat0 + seat2 remain
  assert.equal(state.currentSeat, 2); // advanced past the leaver
});

test('when only one active player remains, they win immediately (opponent_left)', () => {
  const state = createChaserState(localAiSeats(2), 'local_ai', { seed: 'lastman' });
  applyChaserForfeit(state, 1);
  assert.equal(state.status, 'finished');
  assert.equal(state.finishReason, 'opponent_left');
  assert.equal(state.gameWinner.reason, 'opponent_left');
  assert.equal(state.gameWinner.seat, 0);
  assert.equal(state.gameWinner.tie, false);
});

// ---------------------------------------------------------------------------
// timeout auto-scoring
// ---------------------------------------------------------------------------

test('timeout with no roll forces one roll then records a category', () => {
  const state = createChaserState(localAiSeats(2), 'local_ai', { seed: 'to-noroll' });
  applyChaserTimeout(state, 0);
  assert.ok(state.lastTurnResult, 'a category must have been recorded');
  assert.equal(state.lastTurnResult.seat, 0);
  const filled = CHASER_CATEGORIES.filter((c) => state.scorecards.seat0[c] !== null);
  assert.equal(filled.length, 1);
  assert.equal(state.currentSeat, 1); // turn advanced
});

test('timeout with dice records the highest-scoring open category', () => {
  const state = createChaserState(localAiSeats(2), 'local_ai', { seed: 'to-dice' });
  state.rollsUsed = 1;
  state.dice = [2, 3, 4, 5, 6]; // evenStraight = 30 is the best available
  applyChaserTimeout(state, 0);
  assert.equal(state.scorecards.seat0.evenStraight, 30);
});

// ---------------------------------------------------------------------------
// tie-break + winner
// ---------------------------------------------------------------------------

test('equal totals break by chaseOff and flag tie=true', () => {
  const state = createChaserState(localAiSeats(2), 'local_ai', { seed: 'tie' });
  // seat0 fully filled: total 50, all from chaseOff.
  for (const category of CHASER_CATEGORIES) {
    state.scorecards.seat0[category] = category === 'chaseOff' ? 50 : 0;
  }
  // seat1 filled except aces: filled sum 47, chaseOff 0. aces will add 3 -> total 50 (tie).
  for (const category of CHASER_CATEGORIES) {
    state.scorecards.seat1[category] = 0;
  }
  state.scorecards.seat1.straight = 40;
  state.scorecards.seat1.fullHouse = 7;
  state.scorecards.seat1.aces = null;
  // seat1 is on turn with three ones -> aces = 3.
  state.currentSeat = 1;
  state.currentTurn = 'seat1';
  state.rollsUsed = 1;
  state.dice = [1, 1, 1, 2, 3];
  const next = CHASER_ENGINE.applyAction(state, 1, { type: 'score', payload: { category: 'aces' } }).state;
  assert.equal(next.status, 'finished');
  assert.equal(next.finishReason, 'complete');
  const totals = chaserTotals(next);
  assert.equal(totals.seat0, totals.seat1); // genuine tie in total
  assert.equal(next.gameWinner.seat, 0); // seat0 wins the chaseOff tie-break
  assert.equal(next.gameWinner.reason, 'complete');
  assert.equal(next.gameWinner.tie, true);
});

// ---------------------------------------------------------------------------
// full game via AI: legality + completion + correct winner
// ---------------------------------------------------------------------------

for (const difficulty of ['easy', 'medium', 'hard']) {
  test(`AI plays only legal actions and completes a full game (${difficulty})`, () => {
    for (let players = 2; players <= 5; players += 1) {
      let state = createChaserState(localAiSeats(players), 'local_ai', {
        seed: `ai-${difficulty}-${players}`,
        aiDifficulty: difficulty,
      });
      let steps = 0;
      const maxSteps = players * 12 * (CHASER_MAX_ROLLS + 1) + 10;
      while (state.status === 'playing' && steps < maxSteps) {
        steps += 1;
        const seat = state.currentSeat;
        const action = CHASER_ENGINE.aiAction(state, seat, difficulty);
        if (action.type === 'roll') {
          assert.equal(state.rollsUsed < CHASER_MAX_ROLLS, true, 'AI rolled with no rolls left');
        } else {
          assert.equal(action.type, 'score');
          assert.ok(state.rollsUsed >= 1, 'AI scored before rolling');
          assert.equal(state.scorecards[`seat${seat}`][action.payload.category], null, 'AI scored a used category');
        }
        state = CHASER_ENGINE.applyAction(state, seat, action).state;
      }
      assert.equal(state.status, 'finished', `game did not finish for ${difficulty}-${players}`);
      // every seat filled all 12 categories
      for (let seat = 0; seat < players; seat += 1) {
        const card = state.scorecards[`seat${seat}`];
        assert.ok(CHASER_CATEGORIES.every((c) => card[c] !== null), `seat${seat} incomplete`);
      }
      // reported winner truly holds the maximum total
      const totals = chaserTotals(state);
      const maxTotal = Math.max(...Object.values(totals));
      assert.equal(totals[`seat${state.gameWinner.seat}`], maxTotal);
      assert.equal(state.finishReason, 'complete');
    }
  });
}
