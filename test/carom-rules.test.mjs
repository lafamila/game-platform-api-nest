import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCarom, evaluateFourBall } from '../dist/games/carom-rules.js';

const context = { cueBallId: 'cue0', opponentCueId: 'cue1', redBallIds: ['red1', 'red2'] };

function cushion(t, ball) {
  return { t, type: 'cushion', ball, cushion: 'left' };
}
function ball(t, a, b) {
  return { t, type: 'ball', ball: a, other: b };
}

test('hitting both reds and no opponent cue scores (four-ball success)', () => {
  const events = [ball(0.2, 'cue0', 'red1'), ball(0.5, 'cue0', 'red2')];
  const outcome = evaluateFourBall(events, context);
  assert.equal(outcome.scored, true);
  assert.equal(outcome.foul, false);
});

test('hitting only one red is a miss (no score, no foul)', () => {
  const events = [ball(0.2, 'cue0', 'red1'), cushion(0.4, 'cue0')];
  const outcome = evaluateFourBall(events, context);
  assert.equal(outcome.scored, false);
  assert.equal(outcome.foul, false);
});

test('touching the opponent cue is a foul even if both reds are hit', () => {
  const events = [ball(0.1, 'cue0', 'red1'), ball(0.3, 'cue0', 'cue1'), ball(0.5, 'cue0', 'red2')];
  const outcome = evaluateFourBall(events, context);
  assert.equal(outcome.foul, true);
  assert.equal(outcome.scored, false);
});

test('cushions before the second object ball are counted', () => {
  const events = [
    cushion(0.1, 'cue0'),
    ball(0.2, 'cue0', 'red1'),
    cushion(0.3, 'cue0'),
    cushion(0.4, 'cue0'),
    cushion(0.5, 'cue0'),
    ball(0.6, 'cue0', 'red2'),
  ];
  const carom = evaluateCarom(events, context);
  assert.equal(carom.redsHit, 2);
  assert.equal(carom.cushionsBeforeSecondObject, 4);
  assert.equal(carom.threeCushion, true);
});

test('three-cushion is false when fewer than 3 cushions precede the second object', () => {
  const events = [ball(0.2, 'cue0', 'red1'), cushion(0.3, 'cue0'), ball(0.6, 'cue0', 'red2')];
  const carom = evaluateCarom(events, context);
  assert.equal(carom.threeCushion, false);
  assert.equal(carom.cushionsBeforeSecondObject, 1);
});

test('only the shooter cue events are considered; other balls are ignored', () => {
  const events = [
    ball(0.2, 'cue0', 'red1'),
    cushion(0.25, 'red1'), // 목적구가 친 쿠션 — 무시되어야 함
    ball(0.3, 'red1', 'red2'), // 목적구끼리 충돌 — 무시
    ball(0.5, 'cue0', 'red2'),
  ];
  const carom = evaluateCarom(events, context);
  assert.equal(carom.redsHit, 2);
  assert.equal(carom.cushionsBeforeSecondObject, 0);
  assert.deepEqual(carom.ballsHit, ['red1', 'red2']);
});

test('hitting the same red twice still counts as one distinct object', () => {
  const events = [ball(0.2, 'cue0', 'red1'), ball(0.4, 'cue0', 'red1'), cushion(0.5, 'cue0')];
  const carom = evaluateCarom(events, context);
  assert.equal(carom.redsHit, 1);
  assert.deepEqual(carom.ballsHit, ['red1', 'red1']);
});

test('events are evaluated in time order regardless of input order', () => {
  const events = [ball(0.6, 'cue0', 'red2'), cushion(0.3, 'cue0'), ball(0.1, 'cue0', 'red1'), cushion(0.4, 'cue0'), cushion(0.5, 'cue0')];
  const carom = evaluateCarom(events, context);
  assert.equal(carom.redsHit, 2);
  assert.equal(carom.cushionsBeforeSecondObject, 3);
  assert.equal(carom.threeCushion, true);
});

test('cue as the "other" field is still recognized', () => {
  // 물리 엔진이 (a,b) 순서를 index 로 정하므로 수구가 other 로 올 수 있다.
  const events = [{ t: 0.2, type: 'ball', ball: 'red1', other: 'cue0' }, { t: 0.5, type: 'ball', ball: 'red2', other: 'cue0' }];
  const carom = evaluateCarom(events, context);
  assert.equal(carom.redsHit, 2);
  assert.deepEqual(carom.ballsHit, ['red1', 'red2']);
});
