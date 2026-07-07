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
