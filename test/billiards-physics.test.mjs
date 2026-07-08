import assert from 'node:assert/strict';
import test from 'node:test';

import {
  simulateBilliards,
  miscueProbability,
  TABLE_WIDTH,
  TABLE_HEIGHT,
  BALL_RADIUS,
  MAX_SPEED,
  FRAME_MS,
  MISCUE_MAX_PROB,
} from '../dist/games/billiards-physics.js';

// 삑사리 RNG 를 결정적으로 흉내내는 헬퍼(고정 시퀀스).
function seqRng(values) {
  let index = 0;
  return {
    next() {
      const value = values[index] ?? 0;
      index += 1;
      return value;
    },
  };
}

// 항상 삑사리가 절대 안 나게(첫 next 가 1) 하는 rng.
function noMiscueRng() {
  return { next: () => 0.999999 };
}

function speedOf(result, id, frameIndex) {
  const frames = result.frames;
  const a = frames[frameIndex][id];
  const b = frames[frameIndex + 1][id];
  return Math.hypot(b.x - a.x, b.y - a.y) / (FRAME_MS / 1000);
}

// ---------------------------------------------------------------------------
// 기본 시뮬레이션 무결성
// ---------------------------------------------------------------------------

test('balls stay on the table and come to rest', () => {
  const balls = [
    { id: 'cue', x: 200, y: 250 },
    { id: 'red', x: 700, y: 250 },
  ];
  const result = simulateBilliards(balls, { ballId: 'cue', angle: 0, power: 1, tipX: 0, tipY: 0 }, noMiscueRng());
  assert.equal(result.frameMs, FRAME_MS);
  assert.ok(result.frames.length > 2);
  for (const frame of result.frames) {
    for (const id of ['cue', 'red']) {
      assert.ok(frame[id].x >= BALL_RADIUS - 0.5 && frame[id].x <= TABLE_WIDTH - BALL_RADIUS + 0.5, `${id} x in bounds`);
      assert.ok(frame[id].y >= BALL_RADIUS - 0.5 && frame[id].y <= TABLE_HEIGHT - BALL_RADIUS + 0.5, `${id} y in bounds`);
    }
  }
  // 마지막 두 프레임은 정지 상태여야 한다.
  const last = result.frames[result.frames.length - 1];
  const prev = result.frames[result.frames.length - 2];
  for (const id of ['cue', 'red']) {
    assert.ok(Math.hypot(last[id].x - prev[id].x, last[id].y - prev[id].y) < 1, `${id} at rest`);
  }
});

// ---------------------------------------------------------------------------
// 1) 쿠션 반발 후 속력 감소
// ---------------------------------------------------------------------------

test('cushion bounce reduces speed', () => {
  // 우측 벽을 향해 정면으로 굴려 반발 전후 속력 비교.
  const balls = [{ id: 'cue', x: 500, y: 250 }];
  const result = simulateBilliards(balls, { ballId: 'cue', angle: 0, power: 1, tipX: 0, tipY: 0 }, noMiscueRng());
  const cushion = result.events.find((event) => event.type === 'cushion' && event.cushion === 'right');
  assert.ok(cushion, 'expected a right-cushion contact');

  // 반사 지점(= x 가 최대인 프레임)을 실측한 뒤, 그 앞/뒤로 straddle 프레임을 피해 속력 비교.
  let turnFrame = 0;
  for (let i = 1; i < result.frames.length; i += 1) {
    if (result.frames[i].cue.x > result.frames[turnFrame].cue.x) {
      turnFrame = i;
    }
  }
  assert.ok(turnFrame >= 4 && turnFrame + 4 < result.frames.length, `usable turnaround frame: ${turnFrame}`);
  const before = speedOf(result, 'cue', turnFrame - 4);
  const after = speedOf(result, 'cue', turnFrame + 3);
  assert.ok(after < before * 0.95, `speed should drop after cushion: before=${before} after=${after}`);
});

// ---------------------------------------------------------------------------
// 2) 사이드 스핀 유/무에 따른 반사각 차이
// ---------------------------------------------------------------------------

test('side spin changes the cushion reflection angle', () => {
  const start = () => [{ id: 'cue', x: 500, y: 250 }];
  const plain = simulateBilliards(start(), { ballId: 'cue', angle: 0, power: 1, tipX: 0, tipY: 0 }, noMiscueRng());
  const spun = simulateBilliards(start(), { ballId: 'cue', angle: 0, power: 1, tipX: 0.9, tipY: 0 }, noMiscueRng());

  const plainFinal = plain.finalPositions.cue;
  const spunFinal = spun.finalPositions.cue;
  // 무회전은 y 가 거의 그대로, 사이드 스핀은 반사 후 접선(y) 방향으로 휜다.
  assert.ok(Math.abs(spunFinal.y - 250) > Math.abs(plainFinal.y - 250) + 5,
    `spin should deflect tangentially: plainΔy=${plainFinal.y - 250} spunΔy=${spunFinal.y - 250}`);
});

// ---------------------------------------------------------------------------
// 3) 하단 당점(draw) 정면 충돌 후 수구 후진
// 4) 상단 당점(follow) 정면 충돌 후 수구 전진
// 5) 무회전 정면 충돌 시 수구 정지(스톱샷) 근사
// ---------------------------------------------------------------------------

test('draw / follow / stop-shot behavior after a head-on collision', () => {
  const layout = () => [
    { id: 'cue', x: 300, y: 250 },
    { id: 'red', x: 600, y: 250 },
  ];
  const shot = (tipY) => ({ ballId: 'cue', angle: 0, power: 0.6, tipX: 0, tipY });

  const stop = simulateBilliards(layout(), shot(0), noMiscueRng());
  const draw = simulateBilliards(layout(), shot(-0.9), noMiscueRng());
  const follow = simulateBilliards(layout(), shot(0.9), noMiscueRng());

  // 충돌 이벤트가 실제로 발생했는지 확인.
  for (const [name, result] of [['stop', stop], ['draw', draw], ['follow', follow]]) {
    assert.ok(result.events.some((event) => event.type === 'ball'), `${name}: expected a ball collision`);
  }

  const stopCue = stop.finalPositions.cue.x;
  const drawCue = draw.finalPositions.cue.x;
  const followCue = follow.finalPositions.cue.x;

  // 스톱샷: 수구는 충돌 지점(≈ red 위치 - 지름 = 570) 근처에 거의 멈춘다.
  assert.ok(Math.abs(stopCue - (600 - BALL_RADIUS * 2)) < 40, `stop shot cue should rest near impact: ${stopCue}`);
  // draw: 수구가 충돌 뒤 후진(시작 300 방향, 즉 스톱샷보다 왼쪽).
  assert.ok(drawCue < stopCue - 20, `draw cue should end left of stop cue: draw=${drawCue} stop=${stopCue}`);
  // follow: 수구가 충돌 뒤 전진(스톱샷보다 오른쪽).
  assert.ok(followCue > stopCue + 20, `follow cue should end right of stop cue: follow=${followCue} stop=${stopCue}`);
});

// ---------------------------------------------------------------------------
// 6) 동일 입력 재현성
// ---------------------------------------------------------------------------

test('identical input produces identical output (determinism)', () => {
  const layout = () => [
    { id: 'cue', x: 250, y: 200 },
    { id: 'red1', x: 650, y: 300 },
    { id: 'red2', x: 500, y: 120 },
  ];
  const shot = { ballId: 'cue', angle: 0.4, power: 0.85, tipX: 0.5, tipY: 0.3 };
  const first = simulateBilliards(layout(), shot, seqRng([0.5, 0.5]));
  const second = simulateBilliards(layout(), shot, seqRng([0.5, 0.5]));
  assert.deepEqual(first.finalPositions, second.finalPositions);
  assert.deepEqual(first.events, second.events);
  assert.equal(first.frames.length, second.frames.length);
});

// ---------------------------------------------------------------------------
// 삑사리 확률 곡선
// ---------------------------------------------------------------------------

test('miscue probability is 0 below threshold and rises to the cap', () => {
  assert.equal(miscueProbability(0, 0), 0);
  assert.equal(miscueProbability(0.2, 0.1), 0); // d≈0.22 < 0.3
  assert.ok(miscueProbability(0.7, 0) > 0);
  assert.ok(Math.abs(miscueProbability(1, 0) - MISCUE_MAX_PROB) < 1e-9);
  assert.ok(Math.abs(miscueProbability(0, 1) - MISCUE_MAX_PROB) < 1e-9);
});

test('a miscue reduces power (shorter travel) and is flagged', () => {
  const layout = () => [{ id: 'cue', x: 200, y: 250 }];
  const shot = { ballId: 'cue', angle: 0, power: 1, tipX: 0.9, tipY: 0.9 };
  // 첫 next=0 이면 확률(>0) 아래이므로 반드시 삑사리 발생, 두번째 next=0.5 는 각도 지터.
  const miscued = simulateBilliards(layout(), shot, seqRng([0, 0.5]));
  const clean = simulateBilliards(layout(), shot, noMiscueRng());
  assert.equal(miscued.miscue, true);
  assert.equal(clean.miscue, false);
  // 발사 직후 속력으로 비교(벽 반사로 순수변위가 왜곡되지 않도록).
  const miscuedLaunch = speedOf(miscued, 'cue', 0);
  const cleanLaunch = speedOf(clean, 'cue', 0);
  assert.ok(miscuedLaunch < cleanLaunch * 0.5, `miscue should launch slower: miscue=${miscuedLaunch} clean=${cleanLaunch}`);
});
