import assert from 'node:assert/strict';
import test from 'node:test';

import { createSeededRng, cryptoSeed, cryptoSeedInt } from '../dist/games/engine/rng.js';
import { SPLENDOR_ENGINE, splendorClientSession } from '../dist/games/splendor-engine.js';

test('createSeededRng is deterministic for a fixed seed', () => {
  const a = createSeededRng('teddy-seed');
  const b = createSeededRng('teddy-seed');
  const seqA = Array.from({ length: 20 }, () => a.int(1000));
  const seqB = Array.from({ length: 20 }, () => b.int(1000));
  assert.deepEqual(seqA, seqB);
  assert.equal(a.seed, 'teddy-seed');

  const shuffleA = createSeededRng('deck-1').shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const shuffleB = createSeededRng('deck-1').shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(shuffleA, shuffleB);
});

test('createSeededRng without a seed generates a fresh crypto seed each time', () => {
  const a = createSeededRng();
  const b = createSeededRng();
  assert.equal(typeof a.seed, 'string');
  assert.ok(a.seed.length >= 16);
  assert.notEqual(a.seed, b.seed);
});

test('cryptoSeed / cryptoSeedInt produce non-degenerate values', () => {
  assert.notEqual(cryptoSeed(), cryptoSeed());
  const value = cryptoSeedInt();
  assert.ok(Number.isInteger(value) && value >= 0 && value <= 0x7fffffff);
});

test('splendor deal is reproducible from a recorded seed', () => {
  const players = [
    { seat: 0, accountId: 'player-1', kind: 'account', status: 'active' },
    { seat: 1, accountId: 'player-2', kind: 'account', status: 'active' },
  ];
  const first = SPLENDOR_ENGINE.createState(players, { mode: 'friend_match', seed: 'reproduce-me' });
  const second = SPLENDOR_ENGINE.createState(players, { mode: 'friend_match', seed: 'reproduce-me' });
  assert.equal(first.rngSeed, 'reproduce-me');
  assert.deepEqual(
    first.market['1'].map((card) => card.id),
    second.market['1'].map((card) => card.id),
  );
  assert.deepEqual(
    first.nobles.map((noble) => noble.id),
    second.nobles.map((noble) => noble.id),
  );
});

test('splendor client view never leaks the rng seed or the hidden decks', () => {
  const players = [
    { seat: 0, accountId: 'player-1', kind: 'account', status: 'active' },
    { seat: 1, accountId: 'player-2', kind: 'account', status: 'active' },
  ];
  const state = SPLENDOR_ENGINE.createState(players, { mode: 'friend_match' });
  assert.equal(typeof state.rngSeed, 'string');
  const view = splendorClientSession(state, 'player-1');
  assert.equal(view.rngSeed, undefined);
  assert.equal(view.decks, undefined);
  assert.ok(view.deckCounts);
});
