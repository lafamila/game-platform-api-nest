import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGostopDeck,
  parseGostopCardId,
  gostopCardId,
  scoreGostopCaptures,
} from '../dist/games/gostop-engine.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function card(id) {
  return parseGostopCardId(id);
}

function cards(...ids) {
  return ids.map(card);
}

// ---------------------------------------------------------------------------
// 48장 카드 매핑 전수
// ---------------------------------------------------------------------------

test('deck has exactly 48 cards, 4 per month, unique ids', () => {
  const deck = createGostopDeck();
  assert.equal(deck.length, 48);
  const ids = new Set(deck.map((c) => c.id));
  assert.equal(ids.size, 48);
  for (let month = 1; month <= 12; month += 1) {
    assert.equal(deck.filter((c) => c.month === month).length, 4);
  }
});

test('deck kind composition matches the standard 48-card breakdown', () => {
  const deck = createGostopDeck();
  const count = (kind) => deck.filter((c) => c.kind === kind).length;
  assert.equal(count('gwang'), 5);
  assert.equal(count('yeol'), 9);
  assert.equal(count('tti'), 10);
  assert.equal(count('pi'), 22);
  assert.equal(count('ssangpi'), 2);
});

test('explicit month mappings (1..10) follow seotda + new pi rule', () => {
  // 광 달: 1,3,8 index1 = gwang.
  for (const month of [1, 3, 8]) {
    assert.equal(card(gostopCardId(month, 1)).kind, 'gwang');
  }
  // 그 외 index1 = 열끗.
  for (const month of [2, 4, 5, 6, 7, 9, 10]) {
    assert.equal(card(gostopCardId(month, 1)).kind, 'yeol');
  }
  // index2: 8월만 열끗, 나머지 띠.
  assert.equal(card('hwatu_8_2').kind, 'yeol');
  for (const month of [1, 2, 3, 4, 5, 6, 7, 9, 10]) {
    assert.equal(card(gostopCardId(month, 2)).kind, 'tti');
  }
  // index3,4 = 피 (8월 포함).
  for (let month = 1; month <= 10; month += 1) {
    assert.equal(card(gostopCardId(month, 3)).kind, 'pi');
    assert.equal(card(gostopCardId(month, 4)).kind, 'pi');
  }
});

test('11월(오동) mapping', () => {
  assert.equal(card('hwatu_11_1').kind, 'gwang');
  assert.equal(card('hwatu_11_2').kind, 'ssangpi');
  assert.equal(card('hwatu_11_3').kind, 'pi');
  assert.equal(card('hwatu_11_4').kind, 'pi');
});

test('12월(비) mapping — 비광/열끗/비띠/쌍피', () => {
  const gwang = card('hwatu_12_1');
  assert.equal(gwang.kind, 'gwang');
  assert.equal(gwang.biGwang, true);
  assert.equal(card('hwatu_12_2').kind, 'yeol');
  const bitti = card('hwatu_12_3');
  assert.equal(bitti.kind, 'tti');
  assert.equal(bitti.ttiGroup, undefined); // 비띠는 단 그룹 없음
  assert.equal(card('hwatu_12_4').kind, 'ssangpi');
});

test('tti groups: 홍단 1,2,3 / 초단 4,5,7 / 청단 6,9,10', () => {
  const group = (month) => card(gostopCardId(month, 2)).ttiGroup;
  for (const month of [1, 2, 3]) assert.equal(group(month), 'hongdan');
  for (const month of [4, 5, 7]) assert.equal(group(month), 'chodan');
  for (const month of [6, 9, 10]) assert.equal(group(month), 'cheongdan');
});

test('godori birds are 2·4·8월 열끗 exactly', () => {
  const deck = createGostopDeck();
  const godori = deck.filter((c) => c.godori);
  assert.equal(godori.length, 3);
  assert.deepEqual(
    godori.map((c) => c.id).sort(),
    ['hwatu_2_1', 'hwatu_4_1', 'hwatu_8_2'].sort(),
  );
});

test('parseGostopCardId rejects invalid ids', () => {
  assert.throws(() => parseGostopCardId('hwatu_13_1'));
  assert.throws(() => parseGostopCardId('hwatu_1_5'));
  assert.throws(() => parseGostopCardId('nope'));
});

// ---------------------------------------------------------------------------
// 점수 계산 전수
// ---------------------------------------------------------------------------

test('gwang scoring: 3광 3점, 비광 포함 3광 2점, 4광 4점, 5광 15점', () => {
  // 3광 (1,3,8) → 3점
  assert.equal(scoreGostopCaptures(cards('hwatu_1_1', 'hwatu_3_1', 'hwatu_8_1')).gwang, 3);
  // 비광 포함 3광 (1,3,12) → 2점
  assert.equal(scoreGostopCaptures(cards('hwatu_1_1', 'hwatu_3_1', 'hwatu_12_1')).gwang, 2);
  // 4광 → 4점 (비광 포함이어도 4광은 4점)
  assert.equal(scoreGostopCaptures(cards('hwatu_1_1', 'hwatu_3_1', 'hwatu_8_1', 'hwatu_12_1')).gwang, 4);
  // 5광 → 15점
  assert.equal(
    scoreGostopCaptures(cards('hwatu_1_1', 'hwatu_3_1', 'hwatu_8_1', 'hwatu_11_1', 'hwatu_12_1')).gwang,
    15,
  );
  // 2광 → 0점
  assert.equal(scoreGostopCaptures(cards('hwatu_1_1', 'hwatu_3_1')).gwang, 0);
});

test('yeol scoring: 5장 1점 이후 +1/장', () => {
  const yeolIds = ['hwatu_5_1', 'hwatu_6_1', 'hwatu_7_1', 'hwatu_9_1', 'hwatu_10_1']; // 5장, 고도리 아님
  assert.equal(scoreGostopCaptures(cards(...yeolIds)).yeol, 1);
  assert.equal(scoreGostopCaptures(cards(...yeolIds, 'hwatu_12_2')).yeol, 2);
  assert.equal(scoreGostopCaptures(cards('hwatu_5_1', 'hwatu_6_1', 'hwatu_7_1', 'hwatu_9_1')).yeol, 0);
});

test('godori adds 5 points on top of yeol count', () => {
  const godori = scoreGostopCaptures(cards('hwatu_2_1', 'hwatu_4_1', 'hwatu_8_2'));
  assert.equal(godori.godori, true);
  assert.equal(godori.yeol, 5); // 3장은 count 0점 + 고도리 5
  // 고도리 3장 + 열끗 2장 = 5장 count(1점) + 고도리(5점) = 6
  const both = scoreGostopCaptures(cards('hwatu_2_1', 'hwatu_4_1', 'hwatu_8_2', 'hwatu_5_1', 'hwatu_6_1'));
  assert.equal(both.yeol, 6);
});

test('dan scoring: each complete group 3점, plus tti count bonus', () => {
  // 홍단 3장 → 3점 (count 3장은 0)
  const hong = scoreGostopCaptures(cards('hwatu_1_2', 'hwatu_2_2', 'hwatu_3_2'));
  assert.deepEqual(hong.danGroups, ['hongdan']);
  assert.equal(hong.tti, 3);
  // 홍단 + 청단 완성 (6장) → 3+3 group + count(6-4=2) = 8
  const two = scoreGostopCaptures(
    cards('hwatu_1_2', 'hwatu_2_2', 'hwatu_3_2', 'hwatu_6_2', 'hwatu_9_2', 'hwatu_10_2'),
  );
  assert.deepEqual(two.danGroups.sort(), ['cheongdan', 'hongdan']);
  assert.equal(two.tti, 3 + 3 + 2);
  // 비띠는 그룹 미형성, count 에는 포함
  const withBitti = scoreGostopCaptures(cards('hwatu_1_2', 'hwatu_2_2', 'hwatu_3_2', 'hwatu_12_3'));
  assert.deepEqual(withBitti.danGroups, ['hongdan']);
  assert.equal(withBitti.tti, 3); // 4장 count 0 + group 3
});

test('pi scoring: ssangpi counts as 2, 10장 1점 이후 +1/장', () => {
  const nineSingles = Array.from({ length: 9 }, (_, i) => {
    const month = i + 1;
    return gostopCardId(month, 3);
  });
  // 9 single pi = 9 환산 → 0점
  assert.equal(scoreGostopCaptures(cards(...nineSingles)).pi, 0);
  // + 쌍피 1장 = 11 환산 → 2점
  const withSsang = scoreGostopCaptures(cards(...nineSingles, 'hwatu_11_2'));
  assert.equal(withSsang.piCount, 11);
  assert.equal(withSsang.pi, 2);
  // 정확히 10 환산 → 1점
  const tenSingles = Array.from({ length: 10 }, (_, i) => gostopCardId(i + 1, 3));
  assert.equal(scoreGostopCaptures(cards(...tenSingles)).pi, 1);
});

test('total aggregates all categories', () => {
  const b = scoreGostopCaptures(
    cards(
      'hwatu_1_1', 'hwatu_3_1', 'hwatu_8_1', // 3광 3점
      'hwatu_2_1', 'hwatu_4_1', 'hwatu_8_2', // 고도리 5점
      'hwatu_1_2', 'hwatu_2_2', 'hwatu_3_2', // 홍단 3점
    ),
  );
  assert.equal(b.total, 3 + 5 + 3);
});

// ---------------------------------------------------------------------------
// C2: state / deal / 총통 / 재딜 / settlement / go-stop / viewFor / registry
// ---------------------------------------------------------------------------

import {
  createGostopState,
  startGostopRound,
  settleGostopRound,
  settleGostopNagari,
  applyGostopGo,
  applyGostopStop,
  applyGostopNextRound,
  applyGostopForfeit,
  applyGoBonus,
  gostopThreshold,
  recomputeGostopScores,
  gostopViewFor,
  GOSTOP_ENGINE,
  GOSTOP_DEFAULT_STARTING_BALANCE,
} from '../dist/games/gostop-engine.js';
import { GAME_REGISTRY as REGISTRY } from '../dist/games/engine/game-registry.js';

function seats(count) {
  return Array.from({ length: count }, (_, i) => ({ accountId: `p${i}` }));
}

test('deal shape: 맞고 손10/바닥8, 3인 손7/바닥6, deck = rest', () => {
  const two = createGostopState(seats(2), 'local_ai', { seed: 'deal-2' });
  assert.equal(two.hands[0].length, 10);
  assert.equal(two.hands[1].length, 10);
  const floorCount2 = two.floor.reduce((n, s) => n + s.cards.length, 0);
  assert.equal(floorCount2, 8);
  assert.equal(two.deck.length, 48 - 20 - 8);

  const three = createGostopState(seats(3), 'local_ai', { seed: 'deal-3' });
  assert.equal(three.hands[0].length, 7);
  const floorCount3 = three.floor.reduce((n, s) => n + s.cards.length, 0);
  assert.equal(floorCount3, 6);
  assert.equal(three.deck.length, 48 - 21 - 6);
});

test('deal is reproducible for a given seed', () => {
  const a = createGostopState(seats(2), 'local_ai', { seed: 'repro' });
  const b = createGostopState(seats(2), 'local_ai', { seed: 'repro' });
  assert.deepEqual(a.hands.map((h) => h.map((c) => c.id)), b.hands.map((h) => h.map((c) => c.id)));
  assert.deepEqual(
    a.floor.map((s) => s.cards.map((c) => c.id)),
    b.floor.map((s) => s.cards.map((c) => c.id)),
  );
});

test('no dealt floor has 4-of-a-month (재딜 rule)', () => {
  for (let i = 0; i < 200; i += 1) {
    const s = createGostopState(seats(2), 'local_ai', { seed: `floor4-${i}` });
    const byMonth = new Map();
    for (const stack of s.floor) {
      for (const card of stack.cards) {
        byMonth.set(card.month, (byMonth.get(card.month) ?? 0) + 1);
      }
    }
    for (const [, count] of byMonth) {
      assert.ok(count < 4, `floor had 4-of-a-month at seed floor4-${i}`);
    }
  }
});

test('총통: a hand with 4-of-a-month wins the round immediately (10 points, no multiplier)', () => {
  // 손패에 동월 4장이 들어오는 시드를 탐색.
  let found = null;
  for (let i = 0; i < 4000 && !found; i += 1) {
    const s = createGostopState(seats(2), 'local_ai', { seed: `ct-${i}` });
    if (s.lastRoundResult?.chongtong) {
      found = s;
    }
  }
  assert.ok(found, 'expected to find a 총통 deal within the search budget');
  assert.equal(found.lastRoundResult.basePoints, 10);
  assert.equal(found.lastRoundResult.winnerSeat >= 0, true);
  const winner = found.lastRoundResult.winnerSeat;
  const loser = winner === 0 ? 1 : 0;
  // 승자 +1000, 패자 -1000 (pointValue 100 × 10점).
  assert.equal(found.balances[winner], GOSTOP_DEFAULT_STARTING_BALANCE + 1000);
  assert.equal(found.balances[loser], GOSTOP_DEFAULT_STARTING_BALANCE - 1000);
  assert.equal(found.phase, 'settled');
});

test('applyGoBonus: 1고 +1, 2고 +2, 3고 x2, 4고 x4', () => {
  assert.equal(applyGoBonus(5, 0), 5);
  assert.equal(applyGoBonus(5, 1), 6);
  assert.equal(applyGoBonus(5, 2), 7);
  assert.equal(applyGoBonus(5, 3), 10);
  assert.equal(applyGoBonus(5, 4), 20);
});

test('threshold is 7 for 2인, 3 for 3인', () => {
  assert.equal(gostopThreshold(2), 7);
  assert.equal(gostopThreshold(3), 3);
});

test('settlement: winner collects score x pointValue from loser', () => {
  const s = createGostopState(seats(2), 'local_ai', { seed: 'settle' });
  // 승자 좌석 0 에 피 16장(=7점) 세팅.
  const piIds = [];
  for (let m = 1; m <= 8; m += 1) {
    piIds.push(`hwatu_${m}_3`, `hwatu_${m}_4`);
  }
  s.captures[0] = cards(...piIds); // 16 피 → piCount 16 → 7점
  s.captures[1] = [];
  recomputeGostopScores(s);
  assert.equal(s.scores[0], 7);
  const before = s.balances[1];
  settleGostopRound(s, 0);
  // 7점 × 100 = 700. 단, 패자 피 0장이라 피박 아님, 광 0이라 광박 아님.
  assert.equal(s.lastRoundResult.amountPerLoser.seat1, 700);
  assert.equal(s.balances[1], before - 700);
});

test('gwangbak doubles a loser with zero gwang when winner has gwang points', () => {
  const s = createGostopState(seats(2), 'local_ai', { seed: 'gwangbak' });
  // 승자: 3광(3점) + 피 10장(1점) = 4점, 광점수>=1, 피점수>=1.
  const piIds = [];
  for (let m = 1; m <= 5; m += 1) piIds.push(`hwatu_${m}_3`, `hwatu_${m}_4`); // 10 피
  s.captures[0] = cards('hwatu_1_1', 'hwatu_3_1', 'hwatu_8_1', ...piIds);
  s.captures[1] = []; // 광 0, 피 0
  recomputeGostopScores(s);
  const base = s.scores[0];
  settleGostopRound(s, 0);
  // 광박(x2) 적용: 패자 광 0. 피박은 패자 피 0장이라 미적용.
  assert.equal(s.lastRoundResult.multiplierDetail.gwangbak.seat1, 2);
  assert.equal(s.lastRoundResult.multiplierDetail.pibak.seat1, undefined);
  assert.equal(s.lastRoundResult.amountPerLoser.seat1, base * 2 * 100);
});

test('go then stop: go increments count and stop settles with bonus', () => {
  const s = createGostopState(seats(2), 'local_ai', { seed: 'gostop' });
  const piIds = [];
  for (let m = 1; m <= 8; m += 1) piIds.push(`hwatu_${m}_3`, `hwatu_${m}_4`); // 16 피 = 7점
  s.captures[0] = cards(...piIds);
  s.captures[1] = [];
  recomputeGostopScores(s);
  s.phase = 'go_stop';
  s.goStopSeat = 0;
  applyGostopGo(s, 0);
  assert.equal(s.goCount[0], 1);
  assert.equal(s.phase, 'playing');
  // 다시 go_stop 으로 두고 stop.
  s.phase = 'go_stop';
  s.goStopSeat = 0;
  applyGostopStop(s, 0);
  // 7점 + 1고(+1) = 8점 × 100 = 800.
  assert.equal(s.lastRoundResult.amountPerLoser.seat1, 800);
});

test('gobak: a loser who declared go pays the whole amount (3인)', () => {
  const s = createGostopState(seats(3), 'local_ai', { seed: 'gobak' });
  const piIds = [];
  for (let m = 1; m <= 5; m += 1) piIds.push(`hwatu_${m}_3`, `hwatu_${m}_4`); // 10 피 = 1점? threshold 3인=3.
  // 승자(0): 홍단(3점).
  s.captures[0] = cards('hwatu_1_2', 'hwatu_2_2', 'hwatu_3_2');
  s.captures[1] = []; // go 선언자(패자)
  s.captures[2] = [];
  recomputeGostopScores(s);
  s.goCount[1] = 1; // seat1 이 이전에 go 선언
  settleGostopRound(s, 0);
  // gobak = seat1, seat2 면제.
  assert.equal(s.lastRoundResult.multiplierDetail.gobak, 1);
  assert.equal(s.lastRoundResult.amountPerLoser.seat2, 0);
  assert.ok(s.lastRoundResult.amountPerLoser.seat1 > 0);
});

test('nagari: no payment, dealer preserved, phase settled', () => {
  const s = createGostopState(seats(2), 'local_ai', { seed: 'nagari' });
  const balancesBefore = [...s.balances];
  settleGostopNagari(s);
  assert.equal(s.lastRoundResult.nagari, true);
  assert.deepEqual(s.balances, balancesBefore);
  assert.equal(s.phase, 'settled');
});

test('bankruptcy ends the session; richest wins', () => {
  const s = createGostopState(seats(2), 'local_ai', { seed: 'bankrupt' });
  s.balances = [GOSTOP_DEFAULT_STARTING_BALANCE, 100];
  const piIds = [];
  for (let m = 1; m <= 8; m += 1) piIds.push(`hwatu_${m}_3`, `hwatu_${m}_4`); // 7점
  s.captures[0] = cards(...piIds);
  s.captures[1] = [];
  recomputeGostopScores(s);
  settleGostopRound(s, 0); // 700 > 100 → 패자 파산
  assert.equal(s.status, 'finished');
  assert.equal(s.finishReason, 'bankrupt');
  assert.equal(s.gameWinner.seat, 0);
});

test('next_round from settled starts a fresh round with winner as dealer', () => {
  const s = createGostopState(seats(2), 'local_ai', { seed: 'next' });
  s.captures[0] = cards('hwatu_1_2', 'hwatu_2_2', 'hwatu_3_2'); // 3점 홍단
  s.captures[1] = [];
  recomputeGostopScores(s);
  // 잔액이 충분하도록 큰 시작 잔액에서 settle.
  settleGostopRound(s, 0);
  if (s.status === 'finished') return; // 파산이면 skip
  assert.equal(s.phase, 'settled');
  assert.equal(s.dealer, 0);
  const round = s.roundNumber;
  applyGostopNextRound(s);
  assert.equal(s.roundNumber, round + 1);
  assert.equal(s.phase === 'playing' || s.phase === 'settled', true); // 총통이면 settled 가능
});

test('forfeit ends the session (opponent_left), leaver excluded from winner', () => {
  const s = createGostopState(seats(2), 'local_ai', { seed: 'forfeit' });
  applyGostopForfeit(s, 1);
  assert.equal(s.status, 'finished');
  assert.equal(s.finishReason, 'opponent_left');
  assert.equal(s.gameWinner.seat, 0);
});

test('viewFor hides other seats hands and the deck', () => {
  const s = createGostopState(seats(3), 'local_ai', { seed: 'hidden-seed-xyz' });
  s.id = 'sess-view';
  const view = gostopViewFor(s, 0);
  assert.equal(view.mySeat, 0);
  assert.equal(view.myHand.length, 7);
  assert.equal(view.handCounts.seat1, 7);
  assert.equal(view.myHand.every((id) => typeof id === 'string'), true);
  // 더미 카드 자체는 노출되지 않고 개수만.
  assert.equal(typeof view.deckCount, 'number');
  assert.equal(view.rngSeed, undefined);
  assert.equal(JSON.stringify(view).includes(s.rngSeed), false);
  // 상대 손패 카드 id 가 뷰에 없어야 함.
  const otherHandIds = s.hands[1].map((c) => c.id);
  const serialized = JSON.stringify(view);
  // seat1 의 손패 중 내 손패/바닥과 겹치지 않는 카드는 노출되면 안 됨.
  const mine = new Set([...s.hands[0].map((c) => c.id), ...s.floor.flatMap((st) => st.cards.map((c) => c.id))]);
  for (const id of otherHandIds) {
    if (!mine.has(id)) {
      assert.equal(serialized.includes(id), false, `leaked opponent card ${id}`);
    }
  }
});

test('gostop is registered and descriptor is correct', () => {
  const descriptor = REGISTRY.get('gostop');
  assert.ok(descriptor);
  assert.equal(descriptor.minPlayers, 2);
  assert.equal(descriptor.maxPlayers, 3);
  assert.equal(descriptor.hiddenInfo, true);
  assert.equal(descriptor.supportsAi, true);
  assert.equal(descriptor.supportsMatchSave, true);
  assert.equal(descriptor.turnTimerSeconds, 40);
  assert.equal(descriptor.status, 'playable');
  assert.deepEqual([...descriptor.modes].sort(), ['friend_match', 'local_ai']);
  assert.ok(REGISTRY.engine('gostop'), 'gostop engine must be registered');
  assert.equal(GOSTOP_ENGINE.descriptor.key, 'gostop');
});

// ---------------------------------------------------------------------------
// C3: turn state machine + specials (뻑/첫뻑/쪽/따닥/싹쓸이/흔들기/폭탄)
// ---------------------------------------------------------------------------

import {
  applyGostopPlayCard,
  applyGostopFlipChoice,
} from '../dist/games/gostop-engine.js';

// 통제된 상태를 만든다: 손패/바닥/더미를 명시. 더미의 마지막 원소가 먼저 뒤집힌다.
function makeState(count, { hands, floor, deck, currentSeat = 0 }) {
  const s = createGostopState(seats(count), 'local_ai', { seed: 'controlled' });
  s.status = 'playing';
  s.phase = 'playing';
  s.roundNumber = 1;
  s.dealer = 0;
  s.currentSeat = currentSeat;
  s.currentTurn = `seat${currentSeat}`;
  s.balances = Array.from({ length: count }, () => 1_000_000);
  s.hands = hands.map((h) => cards(...h));
  s.floor = floor.map((stackIds) => ({ cards: cards(...stackIds) }));
  s.deck = cards(...deck);
  s.captures = Array.from({ length: count }, () => []);
  s.scores = Array.from({ length: count }, () => 0);
  s.goCount = Array.from({ length: count }, () => 0);
  s.goScore = Array.from({ length: count }, () => -1);
  s.shakeCount = Array.from({ length: count }, () => 0);
  s.bombCount = Array.from({ length: count }, () => 0);
  s.firstTurnPlayed = false;
  s.lastRoundResult = undefined;
  s.lastPlay = undefined;
  s.pendingChoice = undefined;
  s.pending = undefined;
  s.goStopSeat = undefined;
  return s;
}

function capturedIds(s, seat) {
  return s.captures[seat].map((c) => c.id).sort();
}

test('basic match: play matches a single floor card and captures the pair', () => {
  const s = makeState(2, {
    hands: [['hwatu_1_1', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_1_2']],
    deck: ['hwatu_9_4', 'hwatu_5_3'], // flip = 5_3 (no month5 on floor → placed)
  });
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_1_1' });
  assert.deepEqual(capturedIds(s, 0), ['hwatu_1_1', 'hwatu_1_2']);
  assert.ok(s.floor.some((st) => st.cards[0].month === 5));
  assert.equal(s.lastPlay.events.length, 0);
  assert.equal(s.currentSeat, 1); // 턴이 넘어감
});

test('첫뻑: first-turn ppeok steals 1 pi and leaves a ppeok pile', () => {
  const s = makeState(2, {
    hands: [['hwatu_3_1', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_3_2']],
    deck: ['hwatu_9_4', 'hwatu_3_3'], // flip = 3_3 (month3) → 뻑
  });
  s.captures[1] = cards('hwatu_5_3'); // 상대 피 1장
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_3_1' });
  assert.ok(s.lastPlay.events.includes('first_ppeok'));
  // 획득 없음 + 첫뻑 스틸 1피 → captures[0] = [stolen pi]
  assert.deepEqual(capturedIds(s, 0), ['hwatu_5_3']);
  assert.equal(s.captures[1].length, 0);
  const ppeok = s.floor.find((st) => st.cards.length === 3 && st.ppeok);
  assert.ok(ppeok, 'expected a ppeok pile of 3');
  assert.equal(ppeok.cards.length, 3);
});

test('ppeok (not first turn): no steal, pile remains', () => {
  const s = makeState(2, {
    hands: [['hwatu_3_1', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_3_2']],
    deck: ['hwatu_9_4', 'hwatu_3_3'],
  });
  s.firstTurnPlayed = true;
  s.captures[1] = cards('hwatu_5_3');
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_3_1' });
  assert.ok(s.lastPlay.events.includes('ppeok'));
  assert.equal(s.captures[0].length, 0);
  assert.equal(s.captures[1].length, 1); // 스틸 없음
});

test('ppeok_eaten: eating a ppeok pile steals 1 pi', () => {
  const s = makeState(2, {
    hands: [['hwatu_3_4', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_3_1', 'hwatu_3_2', 'hwatu_3_3']], // 뻑더미
    deck: ['hwatu_9_4', 'hwatu_5_3'], // flip 비매칭
  });
  s.firstTurnPlayed = true;
  s.floor[0].ppeok = true;
  s.captures[1] = cards('hwatu_6_3');
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_3_4' });
  assert.ok(s.lastPlay.events.includes('ppeok_eaten'));
  // 4 month3 + 스틸 1피
  assert.equal(s.captures[0].filter((c) => c.month === 3).length, 4);
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_6_3'), true);
  assert.equal(s.captures[1].length, 0);
});

test('쪽: played placed, flip matches it, captures both and steals 1 pi', () => {
  const s = makeState(2, {
    hands: [['hwatu_5_1', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_8_1']], // month5 없음 → placed
    deck: ['hwatu_9_4', 'hwatu_5_2'], // flip = 5_2 (month5) → 쪽
  });
  s.firstTurnPlayed = true;
  s.captures[1] = cards('hwatu_6_3');
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_5_1' });
  assert.ok(s.lastPlay.events.includes('jjok'));
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_5_1'), true);
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_5_2'), true);
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_6_3'), true); // stolen
});

test('따닥: floor has 2, play+flip capture all 4 and steal 1 pi', () => {
  const s = makeState(2, {
    hands: [['hwatu_5_1', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_5_3', 'hwatu_5_4']], // month5 size2
    deck: ['hwatu_9_4', 'hwatu_5_2'], // flip = 5_2 (month5) → 따닥
  });
  s.firstTurnPlayed = true;
  s.captures[1] = cards('hwatu_6_3');
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_5_1', matchChoice: 'hwatu_5_3' });
  assert.ok(s.lastPlay.events.includes('ttadak'));
  assert.equal(s.captures[0].filter((c) => c.month === 5).length, 4);
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_6_3'), true); // stolen
});

test('match_pick: playing into a floor-2 without matchChoice pauses, then resumes', () => {
  const s = makeState(2, {
    hands: [['hwatu_5_1', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_5_3', 'hwatu_5_4']],
    deck: ['hwatu_9_4', 'hwatu_7_3'], // flip 비매칭(month7)
  });
  s.firstTurnPlayed = true;
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_5_1' });
  assert.equal(s.phase, 'flip_choice');
  assert.equal(s.pendingChoice.type, 'match_pick');
  assert.deepEqual(s.pendingChoice.options.sort(), ['hwatu_5_3', 'hwatu_5_4']);
  applyGostopFlipChoice(s, 0, { cardId: 'hwatu_5_3' });
  // 낸 패 + 선택(5_3) 획득, 5_4 는 바닥에 남음, flip 7_3 placed.
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_5_1'), true);
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_5_3'), true);
  assert.ok(s.floor.some((st) => st.cards.some((c) => c.id === 'hwatu_5_4')));
  assert.equal(s.phase, 'playing');
});

test('flip_pick: flipped card matching a floor-2 pauses, then resumes', () => {
  const s = makeState(2, {
    hands: [['hwatu_1_1', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_9_2', 'hwatu_9_3']], // month9 size2 (month1 없음 → play placed)
    deck: ['hwatu_7_4', 'hwatu_9_1'], // flip = 9_1 (month9) → flip_pick
  });
  s.firstTurnPlayed = true;
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_1_1' });
  assert.equal(s.phase, 'flip_choice');
  assert.equal(s.pendingChoice.type, 'flip_pick');
  applyGostopFlipChoice(s, 0, { cardId: 'hwatu_9_2' });
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_9_1'), true);
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_9_2'), true);
  assert.ok(s.floor.some((st) => st.cards.some((c) => c.id === 'hwatu_9_3'))); // leftover
  assert.ok(s.floor.some((st) => st.cards.some((c) => c.id === 'hwatu_1_1'))); // placed
});

test('싹쓸이: clearing the floor steals 1 pi (not on the last turn)', () => {
  const s = makeState(2, {
    hands: [['hwatu_7_1', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_7_2'], ['hwatu_8_1']],
    deck: ['hwatu_10_4', 'hwatu_8_2'], // flip = 8_2 matches 8_1; deck still has 10_4 → not last turn
  });
  s.firstTurnPlayed = true;
  s.captures[1] = cards('hwatu_6_3');
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_7_1' });
  assert.ok(s.lastPlay.events.includes('sseulssak'));
  assert.equal(s.floor.length, 0);
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_6_3'), true); // stolen
});

test('흔들기: shake marks a 2x multiplier and emits shake event', () => {
  const s = makeState(2, {
    hands: [['hwatu_6_1', 'hwatu_6_2', 'hwatu_6_3', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_6_4']],
    deck: ['hwatu_9_4', 'hwatu_5_3'],
  });
  s.firstTurnPlayed = true;
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_6_1', shake: true });
  assert.equal(s.shakeCount[0], 1);
  assert.ok(s.lastPlay.events.includes('shake'));
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_6_1'), true);
});

test('흔들기 without 3 same-month is rejected', () => {
  const s = makeState(2, {
    hands: [['hwatu_6_1', 'hwatu_6_2', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_6_4']],
    deck: ['hwatu_9_4', 'hwatu_5_3'],
  });
  assert.throws(() => applyGostopPlayCard(s, 0, { cardId: 'hwatu_6_1', shake: true }));
});

test('폭탄: play 3 same-month + floor card, capture all 4, 2x and steal 1 pi', () => {
  const s = makeState(2, {
    hands: [['hwatu_6_1', 'hwatu_6_2', 'hwatu_6_3', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_6_4']],
    deck: ['hwatu_9_4', 'hwatu_5_3'],
  });
  s.firstTurnPlayed = true;
  s.captures[1] = cards('hwatu_7_3');
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_6_1', bomb: true });
  assert.equal(s.bombCount[0], 1);
  assert.ok(s.lastPlay.events.includes('bomb'));
  assert.equal(s.captures[0].filter((c) => c.month === 6).length, 4);
  assert.equal(s.captures[0].some((c) => c.id === 'hwatu_7_3'), true); // stolen
  assert.equal(s.hands[0].filter((c) => c.month === 6).length, 0); // 3장 소진
});

test('playing when it is not your turn is rejected', () => {
  const s = makeState(2, {
    hands: [['hwatu_1_1'], ['hwatu_10_1']],
    floor: [['hwatu_1_2']],
    deck: ['hwatu_9_4', 'hwatu_5_3'],
  });
  assert.throws(() => applyGostopPlayCard(s, 1, { cardId: 'hwatu_10_1' }));
});

test('reaching threshold moves to go_stop instead of passing the turn', () => {
  const s = makeState(2, {
    hands: [['hwatu_1_3', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_1_4']],
    deck: ['hwatu_9_4', 'hwatu_5_1'],
  });
  s.firstTurnPlayed = true;
  // 승자 좌석 0 이 이미 피 14장 → 이번 턴 매칭으로 16장(7점) 도달.
  const piIds = [];
  for (let m = 3; m <= 9; m += 1) piIds.push(`hwatu_${m}_3`, `hwatu_${m}_4`); // 14 피
  s.captures[0] = cards(...piIds);
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_1_3' }); // 1_3(pi) + 1_4(pi) 획득 → 16 피 = 7점
  assert.equal(s.phase, 'go_stop');
  assert.equal(s.goStopSeat, 0);
  assert.equal(s.currentSeat, 0); // 턴 유지
});

// ---------------------------------------------------------------------------
// C4: end-to-end round → settlement → continuous integration
// ---------------------------------------------------------------------------

// 규칙 준수 최소 드라이버: go_stop 은 무조건 stop, 선택은 첫 옵션, 그 외엔 손패 첫 장.
function autoDrive(state, { maxSteps = 200000 } = {}) {
  let steps = 0;
  while (state.status === 'playing' && steps < maxSteps) {
    steps += 1;
    if (state.phase === 'go_stop') {
      GOSTOP_ENGINE.applyAction(state, state.goStopSeat, { type: 'stop' });
    } else if (state.phase === 'settled') {
      GOSTOP_ENGINE.applyAction(state, state.currentSeat, { type: 'next_round' });
    } else if (state.phase === 'flip_choice') {
      const seat = state.pending.seat;
      GOSTOP_ENGINE.applyAction(state, seat, {
        type: 'flip_choice',
        payload: { cardId: state.pendingChoice.options[0] },
      });
    } else {
      const seat = state.currentSeat;
      const cardId = state.hands[seat][0].id;
      GOSTOP_ENGINE.applyAction(state, seat, { type: 'play_card', payload: { cardId } });
    }
    // 전역 재화는 항상 zero-sum(참가자 간 이동만).
    const total = state.balances.reduce((sum, b) => sum + b, 0);
    assert.equal(total, state.seatCount * state.config.startingBalance, 'balance must be zero-sum');
  }
  return steps;
}

test('a full 2인 session plays to a finish without exceptions and stays zero-sum', () => {
  let finished = 0;
  for (let i = 0; i < 12; i += 1) {
    const s = createGostopState(seats(2), 'local_ai', { seed: `e2e2-${i}` });
    autoDrive(s);
    assert.ok(['playing', 'finished'].includes(s.status));
    if (s.status === 'finished') {
      finished += 1;
      assert.ok(['bankrupt', 'opponent_left'].includes(s.finishReason));
      assert.ok(s.gameWinner);
    }
  }
  assert.ok(finished > 0, 'at least some 2인 sessions must finish via bankruptcy');
});

test('a full 3인 session plays to a finish without exceptions and stays zero-sum', () => {
  let finished = 0;
  for (let i = 0; i < 12; i += 1) {
    const s = createGostopState(seats(3), 'local_ai', { seed: `e2e3-${i}` });
    autoDrive(s);
    assert.ok(['playing', 'finished'].includes(s.status));
    if (s.status === 'finished') {
      finished += 1;
      assert.ok(['bankrupt', 'opponent_left'].includes(s.finishReason));
    }
  }
  assert.ok(finished > 0, 'at least some 3인 sessions must finish');
});

test('rounds are continuous: roundNumber increments and dealer follows the last winner', () => {
  // 여러 판이 진행되는 세션을 찾아 연속성 확인.
  let observed = false;
  for (let i = 0; i < 30 && !observed; i += 1) {
    const s = createGostopState(seats(2), 'local_ai', { seed: `cont-${i}` });
    let lastRound = s.roundNumber;
    let sawSecondRound = false;
    let steps = 0;
    while (s.status === 'playing' && steps < 200000) {
      steps += 1;
      if (s.phase === 'go_stop') {
        const winner = s.goStopSeat;
        GOSTOP_ENGINE.applyAction(s, winner, { type: 'stop' });
        if (s.phase === 'settled' && !s.lastRoundResult.nagari) {
          // 다음 판 선 = 직전 승자.
          assert.equal(s.dealer, s.lastRoundResult.winnerSeat);
        }
      } else if (s.phase === 'settled') {
        GOSTOP_ENGINE.applyAction(s, s.currentSeat, { type: 'next_round' });
        if (s.roundNumber > lastRound + 0 && s.roundNumber >= 2) sawSecondRound = true;
        lastRound = s.roundNumber;
      } else if (s.phase === 'flip_choice') {
        GOSTOP_ENGINE.applyAction(s, s.pending.seat, { type: 'flip_choice', payload: { cardId: s.pendingChoice.options[0] } });
      } else {
        GOSTOP_ENGINE.applyAction(s, s.currentSeat, { type: 'play_card', payload: { cardId: s.hands[s.currentSeat][0].id } });
      }
    }
    if (sawSecondRound) observed = true;
  }
  assert.ok(observed, 'expected at least one session to reach a second round');
});

test('viewFor exposes pendingChoice while awaiting a flip choice', () => {
  const s = makeState(2, {
    hands: [['hwatu_1_1', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_9_2', 'hwatu_9_3']],
    deck: ['hwatu_7_4', 'hwatu_9_1'],
  });
  s.firstTurnPlayed = true;
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_1_1' });
  const view = gostopViewFor(s, 0);
  assert.equal(view.phase, 'flip_choice');
  assert.ok(view.pendingChoice);
  assert.equal(view.pendingChoice.type, 'flip_pick');
});

// ---------------------------------------------------------------------------
// C5: AI (easy/medium/hard) — legality + completion
// ---------------------------------------------------------------------------

function aiDrive(state, difficulty, maxSteps = 200000) {
  let steps = 0;
  while (state.status === 'playing' && steps < maxSteps) {
    steps += 1;
    const seat =
      state.phase === 'go_stop'
        ? state.goStopSeat
        : state.phase === 'flip_choice'
          ? state.pending.seat
          : state.currentSeat;
    const action = GOSTOP_ENGINE.aiAction(state, seat, difficulty);
    if (action.type === 'play_card' && action.payload.bomb !== true) {
      assert.ok(
        state.hands[seat].some((c) => c.id === action.payload.cardId),
        `AI played a card not in hand: ${action.payload.cardId}`,
      );
    }
    GOSTOP_ENGINE.applyAction(state, seat, action);
    const total = state.balances.reduce((a, b) => a + b, 0);
    assert.equal(total, state.seatCount * state.config.startingBalance, 'balance must be zero-sum');
  }
  return steps;
}

for (const difficulty of ['easy', 'medium', 'hard']) {
  test(`AI (${difficulty}) plays legal moves and finishes 2인 sessions`, () => {
    let finished = 0;
    for (let i = 0; i < 8; i += 1) {
      const s = createGostopState(seats(2), 'local_ai', { seed: `ai2-${difficulty}-${i}`, aiDifficulty: difficulty });
      aiDrive(s, difficulty);
      assert.ok(['playing', 'finished'].includes(s.status));
      if (s.status === 'finished') {
        finished += 1;
        assert.ok(['bankrupt', 'opponent_left'].includes(s.finishReason));
      }
    }
    assert.ok(finished > 0, `${difficulty} 2인 must finish some sessions`);
  });

  test(`AI (${difficulty}) plays legal moves and finishes 3인 sessions`, () => {
    let finished = 0;
    for (let i = 0; i < 8; i += 1) {
      const s = createGostopState(seats(3), 'local_ai', { seed: `ai3-${difficulty}-${i}`, aiDifficulty: difficulty });
      aiDrive(s, difficulty);
      assert.ok(['playing', 'finished'].includes(s.status));
      if (s.status === 'finished') finished += 1;
    }
    assert.ok(finished > 0, `${difficulty} 3인 must finish some sessions`);
  });
}

test('AI takes a bomb when available (medium/hard)', () => {
  const s = makeState(2, {
    hands: [['hwatu_6_1', 'hwatu_6_2', 'hwatu_6_3', 'hwatu_2_3'], ['hwatu_10_1']],
    floor: [['hwatu_6_4']],
    deck: ['hwatu_9_4', 'hwatu_5_3'],
  });
  const action = GOSTOP_ENGINE.aiAction(s, 0, 'medium');
  assert.equal(action.type, 'play_card');
  assert.equal(action.payload.bomb, true);
  assert.equal(parseGostopCardId(action.payload.cardId).month, 6);
});

test('AI flip choice picks the higher-value floor card', () => {
  const s = makeState(2, {
    hands: [['hwatu_1_1'], ['hwatu_10_1']],
    floor: [['hwatu_9_2', 'hwatu_9_1']], // month9: tti(9) vs yeol(8) → prefer tti(9_2)
    deck: ['hwatu_7_4', 'hwatu_9_3'],
  });
  s.firstTurnPlayed = true;
  applyGostopPlayCard(s, 0, { cardId: 'hwatu_1_1' }); // placed; flip 9_3 matches size2 → flip_pick
  assert.equal(s.phase, 'flip_choice');
  const action = GOSTOP_ENGINE.aiAction(s, 0, 'hard');
  assert.equal(action.type, 'flip_choice');
  assert.equal(action.payload.cardId, 'hwatu_9_2'); // tti(9) > yeol(8)
});

test('AI go/stop returns only legal declarations', () => {
  const s = makeState(2, {
    hands: [['hwatu_1_1', 'hwatu_2_3'], ['hwatu_10_1', 'hwatu_5_1']],
    floor: [['hwatu_8_1']],
    deck: ['hwatu_9_4', 'hwatu_7_3'],
  });
  s.phase = 'go_stop';
  s.goStopSeat = 0;
  s.scores[0] = 7;
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const action = GOSTOP_ENGINE.aiAction(s, 0, difficulty);
    assert.ok(['go', 'stop'].includes(action.type));
  }
});
