import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEOTDA_ENGINE,
  SEOTDA_DEFAULT_ANTE,
  SEOTDA_DEFAULT_STARTING_BALANCE,
  createSeotdaState,
  createSeotdaDeck,
  evaluateSeotdaHand,
  resolveSeotdaShowdown,
  seotdaLegalMoves,
  seotdaViewFor,
  applySeotdaForfeit,
  parseSeotdaCardId,
} from '../dist/games/seotda-engine.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cards(...ids) {
  return ids.map((id) => parseSeotdaCardId(id));
}

function rankOf(...ids) {
  return evaluateSeotdaHand(cards(...ids));
}

function showdown(handA, handB, sun = 0) {
  const entries = [
    { seat: 0, rank: evaluateSeotdaHand(cards(...handA)) },
    { seat: 1, rank: evaluateSeotdaHand(cards(...handB)) },
  ];
  return resolveSeotdaShowdown(entries, sun, 2);
}

function localAiSeats(count) {
  return Array.from({ length: count }, (_, index) => ({ accountId: `p${index}` }));
}

function bet(state, move) {
  return SEOTDA_ENGINE.applyAction(state, state.currentSeat, { type: 'bet', payload: { move } }).state;
}

// ---------------------------------------------------------------------------
// deck integrity + seed reproducibility
// ---------------------------------------------------------------------------

test('deck has 20 unique cards, two per month, correct kinds', () => {
  const deck = createSeotdaDeck();
  assert.equal(deck.length, 20);
  assert.equal(new Set(deck.map((c) => c.id)).size, 20);
  for (let month = 1; month <= 10; month += 1) {
    const monthly = deck.filter((c) => c.month === month);
    assert.equal(monthly.length, 2, `month ${month} should have 2 cards`);
  }
  // index 1 kind: gwang for 1/3/8, else yeol. index 2: yeol for month 8, else tti.
  assert.equal(deck.find((c) => c.id === 'hwatu_1_1').kind, 'gwang');
  assert.equal(deck.find((c) => c.id === 'hwatu_3_1').kind, 'gwang');
  assert.equal(deck.find((c) => c.id === 'hwatu_8_1').kind, 'gwang');
  assert.equal(deck.find((c) => c.id === 'hwatu_2_1').kind, 'yeol');
  assert.equal(deck.find((c) => c.id === 'hwatu_7_1').kind, 'yeol');
  assert.equal(deck.find((c) => c.id === 'hwatu_8_2').kind, 'yeol');
  assert.equal(deck.find((c) => c.id === 'hwatu_1_2').kind, 'tti');
  assert.equal(deck.find((c) => c.id === 'hwatu_4_2').kind, 'tti');
});

test('same seed reproduces the identical deal', () => {
  const a = createSeotdaState(localAiSeats(3), 'local_ai', { seed: 'repro-seed' });
  const b = createSeotdaState(localAiSeats(3), 'local_ai', { seed: 'repro-seed' });
  assert.deepEqual(
    a.hands.map((h) => h.map((c) => c.id)),
    b.hands.map((h) => h.map((c) => c.id)),
  );
  assert.deepEqual(a.deck.map((c) => c.id), b.deck.map((c) => c.id));
  const c = createSeotdaState(localAiSeats(3), 'local_ai', { seed: 'other-seed' });
  assert.notDeepEqual(a.deck.map((c) => c.id), c.deck.map((c) => c.id));
});

// ---------------------------------------------------------------------------
// rankings
// ---------------------------------------------------------------------------

test('gwangttaeng ordering: 38 > 18 > 13, and each beats ttaeng', () => {
  assert.equal(rankOf('hwatu_3_1', 'hwatu_8_1').label, '38광땡');
  assert.equal(rankOf('hwatu_1_1', 'hwatu_8_1').label, '18광땡');
  assert.equal(rankOf('hwatu_1_1', 'hwatu_3_1').label, '13광땡');
  assert.equal(showdown(['hwatu_3_1', 'hwatu_8_1'], ['hwatu_1_1', 'hwatu_8_1']).winnerSeat, 0);
  assert.equal(showdown(['hwatu_1_1', 'hwatu_8_1'], ['hwatu_1_1', 'hwatu_3_1']).winnerSeat, 0);
  // 13광땡 beats 장땡(10땡)
  assert.equal(showdown(['hwatu_1_1', 'hwatu_3_1'], ['hwatu_10_1', 'hwatu_10_2']).winnerSeat, 0);
});

test('ttaeng ordering and labels: 장땡 > 1땡, ttaeng beats special kkut', () => {
  assert.equal(rankOf('hwatu_10_1', 'hwatu_10_2').label, '장땡');
  assert.equal(rankOf('hwatu_1_1', 'hwatu_1_2').label, '1땡');
  assert.equal(showdown(['hwatu_10_1', 'hwatu_10_2'], ['hwatu_1_1', 'hwatu_1_2']).winnerSeat, 0);
  // 1땡 beats 알리
  assert.equal(showdown(['hwatu_1_1', 'hwatu_1_2'], ['hwatu_1_1', 'hwatu_2_1']).winnerSeat, 0);
});

test('special kkut ordering: 알리 > 독사 > 구삥 > 장삥 > 장사 > 세륙', () => {
  assert.equal(rankOf('hwatu_1_1', 'hwatu_2_1').label, '알리');
  assert.equal(rankOf('hwatu_1_1', 'hwatu_4_1').label, '독사');
  assert.equal(rankOf('hwatu_1_1', 'hwatu_9_1').label, '구삥');
  assert.equal(rankOf('hwatu_1_1', 'hwatu_10_1').label, '장삥');
  assert.equal(rankOf('hwatu_4_2', 'hwatu_10_1').label, '장사');
  assert.equal(rankOf('hwatu_4_2', 'hwatu_6_1').label, '세륙');
  assert.equal(showdown(['hwatu_1_1', 'hwatu_2_1'], ['hwatu_1_1', 'hwatu_4_1']).winnerSeat, 0);
  assert.equal(showdown(['hwatu_1_1', 'hwatu_4_1'], ['hwatu_1_1', 'hwatu_9_1']).winnerSeat, 0);
  assert.equal(showdown(['hwatu_1_1', 'hwatu_10_1'], ['hwatu_4_2', 'hwatu_10_1']).winnerSeat, 0);
  assert.equal(showdown(['hwatu_4_2', 'hwatu_10_1'], ['hwatu_4_2', 'hwatu_6_1']).winnerSeat, 0);
  // 세륙 still beats a plain 끗수
  assert.equal(showdown(['hwatu_4_2', 'hwatu_6_1'], ['hwatu_4_2', 'hwatu_5_1']).winnerSeat, 0);
});

test('kkut ordering and mangtong: 갑오(9끗) > 1끗 > 망통', () => {
  // 4+5 = 9 (갑오), not a special pair
  assert.equal(rankOf('hwatu_4_2', 'hwatu_5_1').label, '갑오');
  assert.equal(rankOf('hwatu_4_2', 'hwatu_5_1').kkut, 9);
  // 5+6 = 1끗
  assert.equal(rankOf('hwatu_5_2', 'hwatu_6_1').label, '1끗');
  // 2+8 = 망통 (non-special, non-gwangttaeng)
  assert.equal(rankOf('hwatu_2_1', 'hwatu_8_1').label, '망통');
  assert.equal(showdown(['hwatu_4_2', 'hwatu_5_1'], ['hwatu_5_2', 'hwatu_6_1']).winnerSeat, 0);
  assert.equal(showdown(['hwatu_5_2', 'hwatu_6_1'], ['hwatu_2_1', 'hwatu_8_1']).winnerSeat, 0);
});

test('kkut tie breaks by 선(先) priority', () => {
  // both hands are 3끗: {1,2}? no that's 알리. use {5_1(yeol),8_2(yeol)} = 5+8=3, and {4_2,9_2}=4+9 gusa. avoid.
  // hand A: 6_1 + 7_2 = 13 -> 3끗 ; hand B: 5_1 + 8_1 = 13 -> 3끗
  assert.equal(rankOf('hwatu_6_1', 'hwatu_7_2').kkut, 3);
  assert.equal(rankOf('hwatu_5_1', 'hwatu_8_1').kkut, 3);
  // sun=0 -> seat0 wins the tie; sun=1 -> seat1 wins
  assert.equal(showdown(['hwatu_6_1', 'hwatu_7_2'], ['hwatu_5_1', 'hwatu_8_1'], 0).winnerSeat, 0);
  assert.equal(showdown(['hwatu_6_1', 'hwatu_7_2'], ['hwatu_5_1', 'hwatu_8_1'], 1).winnerSeat, 1);
});

// ---------------------------------------------------------------------------
// special hands: 암행어사 / 땡잡이 / 구사
// ---------------------------------------------------------------------------

test('암행어사 beats gwangttaeng but loses to everything else', () => {
  assert.equal(rankOf('hwatu_4_1', 'hwatu_7_1').label, '암행어사');
  // vs 광땡 -> ansa wins
  assert.equal(showdown(['hwatu_4_1', 'hwatu_7_1'], ['hwatu_3_1', 'hwatu_8_1']).winnerSeat, 0);
  // vs 땡 -> ansa loses
  assert.equal(showdown(['hwatu_4_1', 'hwatu_7_1'], ['hwatu_10_1', 'hwatu_10_2']).winnerSeat, 1);
  // vs 망통 -> ansa loses
  assert.equal(showdown(['hwatu_4_1', 'hwatu_7_1'], ['hwatu_2_1', 'hwatu_8_1']).winnerSeat, 1);
});

test('땡잡이 beats any 땡, loses to 광땡, otherwise ranked as 망통', () => {
  assert.equal(rankOf('hwatu_3_1', 'hwatu_7_1').label, '땡잡이');
  // vs 장땡 -> ttaengjabi wins
  assert.equal(showdown(['hwatu_3_1', 'hwatu_7_1'], ['hwatu_10_1', 'hwatu_10_2']).winnerSeat, 0);
  // vs 1땡 -> ttaengjabi wins
  assert.equal(showdown(['hwatu_3_1', 'hwatu_7_1'], ['hwatu_1_1', 'hwatu_1_2']).winnerSeat, 0);
  // vs 광땡 -> ttaengjabi loses
  assert.equal(showdown(['hwatu_3_1', 'hwatu_7_1'], ['hwatu_1_1', 'hwatu_8_1']).winnerSeat, 1);
  // vs a plain 1끗 -> ttaengjabi (mangtong-level) loses
  assert.equal(showdown(['hwatu_3_1', 'hwatu_7_1'], ['hwatu_5_2', 'hwatu_6_1']).winnerSeat, 1);
});

test('암행어사 3-way with 광땡 + 땡 resolves to 땡 (광땡 arrested)', () => {
  const entries = [
    { seat: 0, rank: evaluateSeotdaHand(cards('hwatu_3_1', 'hwatu_8_1')) }, // 38광땡
    { seat: 1, rank: evaluateSeotdaHand(cards('hwatu_4_1', 'hwatu_7_1')) }, // 암행어사
    { seat: 2, rank: evaluateSeotdaHand(cards('hwatu_10_1', 'hwatu_10_2')) }, // 장땡
  ];
  assert.equal(resolveSeotdaShowdown(entries, 0, 3).winnerSeat, 2);
});

test('구사 triggers a redeal signal', () => {
  assert.equal(rankOf('hwatu_4_1', 'hwatu_9_1').label, '구사');
  const entries = [
    { seat: 0, rank: evaluateSeotdaHand(cards('hwatu_4_1', 'hwatu_9_1')) },
    { seat: 1, rank: evaluateSeotdaHand(cards('hwatu_10_1', 'hwatu_10_2')) },
  ];
  assert.equal(resolveSeotdaShowdown(entries, 0, 2).isGusa, true);
});

// ---------------------------------------------------------------------------
// betting + settlement
// ---------------------------------------------------------------------------

test('fold win: last player standing takes the pot', () => {
  let state = createSeotdaState(localAiSeats(2), 'local_ai', { seed: 'fold-seed' });
  const start = SEOTDA_DEFAULT_STARTING_BALANCE;
  assert.equal(state.pot, SEOTDA_DEFAULT_ANTE * 2);
  // sun=0 acts first: seat0 checks, seat1 dies -> seat0 wins.
  state = bet(state, 'check');
  state = bet(state, 'die');
  assert.equal(state.phase, 'settled');
  assert.equal(state.lastHandResult.winnerSeat, 0);
  assert.equal(state.lastHandResult.reason, 'fold_win');
  assert.equal(state.balances[0], start + SEOTDA_DEFAULT_ANTE);
  assert.equal(state.balances[1], start - SEOTDA_DEFAULT_ANTE);
});

test('raise cap = min active balance; a rich seat cannot out-raise an all-in', () => {
  const state = createSeotdaState(localAiSeats(2), 'local_ai', { seed: 'cap-seed' });
  // Override balances so seat0 is short-stacked (post-ante state).
  state.balances = [50, 10_000];
  // seat0 (sun) goes all-in for 50; cap should pin currentBet at 50.
  const after = bet(state, 'allin');
  assert.equal(after.currentBet, 50);
  assert.equal(after.allin[0], true);
  // seat1 now faces the all-in: only call or die, no raise available.
  const moves = seotdaLegalMoves(after, 1);
  assert.ok(moves.includes('call'));
  assert.ok(moves.includes('die'));
  assert.ok(!moves.includes('bbing'));
  assert.ok(!moves.includes('ddadang'));
  assert.ok(!moves.includes('half'));
});

test('continuous hands carry balances forward across next_hand', () => {
  let state = createSeotdaState(localAiSeats(3), 'local_ai', { seed: 'cont-seed' });
  const start = SEOTDA_DEFAULT_STARTING_BALANCE;
  // Everyone folds to the sun via checks/dies until one remains.
  state = bet(state, 'check'); // seat0
  state = bet(state, 'die'); // seat1
  state = bet(state, 'die'); // seat2 -> seat0 wins
  assert.equal(state.phase, 'settled');
  assert.equal(state.handNumber, 1);
  const balancesAfterHand1 = [...state.balances];
  assert.equal(balancesAfterHand1[0], start + SEOTDA_DEFAULT_ANTE * 2);

  // Next hand: balances persist, sun = previous winner (seat0), fresh ante posted.
  state = SEOTDA_ENGINE.applyAction(state, 0, { type: 'next_hand' }).state;
  assert.equal(state.handNumber, 2);
  assert.equal(state.sun, 0);
  assert.equal(state.phase, 'betting_1');
  // each seat posted a new ante on top of the carried balances
  for (let seat = 0; seat < 3; seat += 1) {
    assert.equal(state.balances[seat], balancesAfterHand1[seat] - SEOTDA_DEFAULT_ANTE);
  }
});

test('구사 재경기: pot carries over and a fresh hand is dealt', () => {
  const state = createSeotdaState(localAiSeats(2), 'local_ai', { seed: 'gusa-seed' });
  // Force a controlled deal: round1 one card each, then a rigged second card.
  state.hands = [cards('hwatu_4_1'), cards('hwatu_5_1')];
  // deck.pop() feeds seat0 first, then seat1 -> put seat1's card before seat0's at the tail.
  state.deck = [...cards('hwatu_10_2', 'hwatu_6_1', 'hwatu_9_1')]; // seat0 gets 9_1 (=> 4,9 구사), seat1 gets 6_1
  const potBefore = state.pot;
  let next = bet(state, 'check'); // seat0
  next = bet(next, 'check'); // seat1 -> round1 done, deal 2nd cards
  assert.equal(next.round, 2);
  next = bet(next, 'check'); // seat0
  next = bet(next, 'check'); // seat1 -> showdown -> 구사 redeal
  assert.equal(next.gusaRedealCount, 1);
  assert.equal(next.lastHandResult.reason, 'gusa_redeal');
  assert.equal(next.phase, 'betting_1');
  assert.equal(next.round, 1);
  // pot carried the pre-redeal pot plus the fresh antes.
  assert.equal(next.pot, potBefore + SEOTDA_DEFAULT_ANTE * 2);
});

test('bankruptcy at settlement ends the session; richest player wins', () => {
  const state = createSeotdaState(localAiSeats(2), 'local_ai', { seed: 'bust-seed' });
  state.balances = [10_000, 100];
  // Rig the deal so seat0 makes 4땡, seat1 gets a weak 1끗.
  state.hands = [cards('hwatu_4_1'), cards('hwatu_5_2')];
  state.deck = [...cards('hwatu_10_2', 'hwatu_6_1', 'hwatu_4_2')]; // seat0 -> 4_2 (4땡), seat1 -> 6_1
  let next = bet(state, 'bbing'); // seat0 bets 100
  next = bet(next, 'call'); // seat1 calls all 100 -> all-in
  assert.equal(next.allin[1], true);
  next = bet(next, 'check'); // seat0 checks round2 -> showdown
  assert.equal(next.status, 'finished');
  assert.equal(next.finishReason, 'bankrupt');
  assert.equal(next.gameWinner.reason, 'bankrupt');
  assert.equal(next.gameWinner.seat, 0);
  assert.equal(next.balances[1], 0);
});

test('opponent leaving settles the session immediately (richest wins, leaver excluded)', () => {
  const state = createSeotdaState(localAiSeats(3), 'local_ai', { seed: 'leave-seed' });
  state.balances = [500, 9_000, 700];
  applySeotdaForfeit(state, 1); // richest (seat1) leaves
  assert.equal(state.status, 'finished');
  assert.equal(state.finishReason, 'opponent_left');
  assert.equal(state.gameWinner.reason, 'opponent_left');
  // leaver excluded -> richest of {seat0:500, seat2:700} = seat2
  assert.equal(state.gameWinner.seat, 2);
  assert.equal(state.seatStatus.seat1, 'left');
});

// ---------------------------------------------------------------------------
// viewFor hiding
// ---------------------------------------------------------------------------

test('viewFor hides deck and other hands, reveals only the viewer hand', () => {
  const state = createSeotdaState(localAiSeats(3), 'local_ai', { seed: 'view-seed' });
  const view0 = seotdaViewFor(state, 0);
  assert.ok(!('deck' in view0));
  assert.ok(!('hands' in view0));
  assert.deepEqual(view0.myHand, state.hands[0].map((c) => c.id));
  assert.equal(view0.mySeat, 0);
  assert.deepEqual(view0.handCounts, [1, 1, 1]);
  assert.deepEqual(view0.revealedHands, {});

  const view1 = seotdaViewFor(state, 1);
  assert.deepEqual(view1.myHand, state.hands[1].map((c) => c.id));
  assert.notDeepEqual(view1.myHand, view0.myHand);

  const spectator = seotdaViewFor(state, 'spectator');
  assert.deepEqual(spectator.myHand, []);
});

test('viewFor reveals survivor hands at showdown settlement', () => {
  let state = createSeotdaState(localAiSeats(2), 'local_ai', { seed: 'reveal-seed' });
  state.hands = [cards('hwatu_10_1'), cards('hwatu_2_1')];
  state.deck = [...cards('hwatu_9_2', 'hwatu_3_2', 'hwatu_10_2')]; // seat0 -> 10_2 (장땡), seat1 -> 3_2
  state = bet(state, 'check');
  state = bet(state, 'check'); // round2
  state = bet(state, 'check');
  state = bet(state, 'check'); // showdown -> settle
  assert.equal(state.phase, 'settled');
  const view = seotdaViewFor(state, 1);
  // both survivors' hands revealed
  assert.ok(view.revealedHands.seat0);
  assert.ok(view.revealedHands.seat1);
  assert.equal(state.lastHandResult.reason, 'showdown');
});

// ---------------------------------------------------------------------------
// player-count guards + room mixed start
// ---------------------------------------------------------------------------

test('player count guard: 2..5 only', () => {
  assert.throws(() => createSeotdaState(localAiSeats(1), 'local_ai', {}));
  assert.throws(() => createSeotdaState(localAiSeats(6), 'local_ai', {}));
  assert.equal(createSeotdaState(localAiSeats(2), 'local_ai', {}).seatCount, 2);
  assert.equal(createSeotdaState(localAiSeats(5), 'local_ai', {}).seatCount, 5);
});

test('5-player mixed (accounts + AI) start deals one card each', () => {
  const seats = [
    { accountId: 'human-a' },
    { accountId: 'human-b' },
    { accountId: '__game_platform_local_ai__#2' },
    { accountId: '__game_platform_local_ai__#3' },
    { accountId: '__game_platform_local_ai__#4' },
  ];
  const state = createSeotdaState(seats, 'friend_match', { seed: 'room5' });
  assert.equal(state.seatCount, 5);
  assert.equal(state.phase, 'betting_1');
  assert.ok(state.hands.every((h) => h.length === 1));
  assert.ok(state.balances.every((b) => b === SEOTDA_DEFAULT_STARTING_BALANCE - SEOTDA_DEFAULT_ANTE));
});

// ---------------------------------------------------------------------------
// AI legality simulation
// ---------------------------------------------------------------------------

for (const difficulty of ['easy', 'medium', 'hard']) {
  test(`AI always produces legal actions across many hands (${difficulty})`, () => {
    for (let trial = 0; trial < 6; trial += 1) {
      let state = createSeotdaState(localAiSeats(4), 'local_ai', {
        seed: `ai-${difficulty}-${trial}`,
        aiDifficulty: difficulty,
      });
      let steps = 0;
      while (state.status === 'playing' && steps < 4000) {
        steps += 1;
        const seat = state.currentSeat;
        const action = SEOTDA_ENGINE.aiAction(state, seat, difficulty);
        if (action.type === 'bet') {
          const legal = seotdaLegalMoves(state, seat);
          assert.ok(legal.includes(action.payload.move), `illegal AI move ${action.payload.move} in ${legal}`);
        } else {
          assert.ok(action.type === 'next_hand', `unexpected AI action ${action.type}`);
          assert.equal(state.phase, 'settled');
        }
        state = SEOTDA_ENGINE.applyAction(state, seat, action).state;
      }
      // a 4-player game with fixed starting chips must terminate via bankruptcy well within the cap
      assert.equal(state.status, 'finished', `game did not finish for ${difficulty}-${trial}`);
      assert.ok(['bankrupt', 'opponent_left'].includes(state.finishReason));
    }
  });
}
