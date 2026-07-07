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
