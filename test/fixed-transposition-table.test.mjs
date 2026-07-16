import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FixedTranspositionTable,
  TT_EXACT,
  TT_LOWER,
  TT_MISS,
  TT_NO_MOVE,
  TT_UPPER,
} from '../dist/games/engine/fixed-transposition-table.js';

test('uses a power-of-two capacity selected by exponent', () => {
  assert.equal(new FixedTranspositionTable(0).capacity, 1);
  assert.equal(new FixedTranspositionTable(10).capacity, 1 << 10);
  for (const power of [-1, 1.5, 31, Number.NaN]) {
    assert.throws(() => new FixedTranspositionTable(power), RangeError);
  }
});

test('round-trips primitive fields without allocating an entry object', () => {
  const table = new FixedTranspositionTable(3);
  assert.equal(
    table.store(0x89abcdef, 0xfedcba98, 12, -2_147_483_648, TT_EXACT, 224),
    true,
  );

  const slot = table.probe(0x89abcdef, 0xfedcba98);
  assert.notEqual(slot, TT_MISS);
  assert.equal(table.depthAt(slot), 12);
  assert.equal(table.scoreAt(slot), -2_147_483_648);
  assert.equal(table.flagAt(slot), TT_EXACT);
  assert.equal(table.moveAt(slot), 224);

  assert.equal(table.store(2, 3, 4, 2_147_483_647, TT_LOWER), true);
  const noMoveSlot = table.probe(2, 3);
  assert.equal(table.scoreAt(noMoveSlot), 2_147_483_647);
  assert.equal(table.flagAt(noMoveSlot), TT_LOWER);
  assert.equal(table.moveAt(noMoveSlot), TT_NO_MOVE);
});

test('checks both uint32 key halves on probe', () => {
  const table = new FixedTranspositionTable(2);
  table.store(1, 0x12345678, 5, 100, TT_UPPER, 7);

  assert.notEqual(table.probe(1, 0x12345678), TT_MISS);
  assert.equal(table.probe(5, 0x12345678), TT_MISS, 'a colliding primary key must not match');
  assert.equal(table.probe(1, 0x12345679), TT_MISS, 'a verifier collision must not match');

  table.store(-1, -2, 3, 30, TT_EXACT, 3);
  assert.notEqual(table.probe(0xffffffff, 0xfffffffe), TT_MISS, 'keys use uint32 semantics');
});

test('keeps a deeper current-generation entry on collision', () => {
  const table = new FixedTranspositionTable(2);
  table.store(1, 11, 9, 900, TT_EXACT, 90);

  assert.equal(table.store(5, 55, 8, 800, TT_LOWER, 80), false);
  const original = table.probe(1, 11);
  assert.notEqual(original, TT_MISS);
  assert.equal(table.depthAt(original), 9);
  assert.equal(table.scoreAt(original), 900);

  assert.equal(table.store(5, 55, 9, 901, TT_UPPER, 81), true);
  assert.equal(table.probe(1, 11), TT_MISS);
  const replacement = table.probe(5, 55);
  assert.notEqual(replacement, TT_MISS);
  assert.equal(table.flagAt(replacement), TT_UPPER);
});

test('stale generations yield to shallower entries', () => {
  const table = new FixedTranspositionTable(1);
  table.store(0, 10, 20, 2_000, TT_EXACT, 20);
  assert.equal(table.beginGeneration(), 2);

  assert.equal(table.store(2, 12, 1, 100, TT_LOWER, 1), true);
  assert.equal(table.probe(0, 10), TT_MISS);
  const replacement = table.probe(2, 12);
  assert.notEqual(replacement, TT_MISS);
  assert.equal(table.depthAt(replacement), 1);
});

test('a probe refreshes an old entry before replacement', () => {
  const table = new FixedTranspositionTable(1);
  table.store(1, 10, 7, 700, TT_EXACT, 7);
  table.beginGeneration();

  assert.notEqual(table.probe(1, 10), TT_MISS);
  assert.equal(table.store(3, 30, 6, 600, TT_LOWER, 6), false);
  assert.notEqual(table.probe(1, 10), TT_MISS);
});

test('clear invalidates entries and resets generation', () => {
  const table = new FixedTranspositionTable(2);
  table.store(2, 20, 2, 200, TT_UPPER, 2);
  table.beginGeneration();
  table.clear();

  assert.equal(table.generation, 1);
  assert.equal(table.probe(2, 20), TT_MISS);
});
