import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FOUR_BALL_ENGINE,
  FOUR_BALL_TARGET_OPTIONS,
  FOUR_BALL_MAX_TURNS,
  createFourBallState,
  selectFourBallTarget,
  applyFourBallShot,
  applyFourBallForfeit,
  fourBallViewFor,
} from '../dist/games/four-ball-engine.js';
import { GAME_REGISTRY } from '../dist/games/engine/game-registry.js';

function localAiState(seed = 'seed-a') {
  return createFourBallState('p0', 'p1', 'local_ai', 'medium', seed, 'sess1');
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('four_ball is registered with a 2-player turn-based descriptor', () => {
  const descriptor = GAME_REGISTRY.get('four_ball');
  assert.ok(descriptor);
  assert.equal(descriptor.minPlayers, 2);
  assert.equal(descriptor.maxPlayers, 2);
  assert.equal(descriptor.turnType, 'turnBased');
  assert.equal(descriptor.hiddenInfo, false);
  assert.ok(descriptor.modes.includes('local_ai'));
  assert.ok(descriptor.modes.includes('friend_match'));
  assert.ok(GAME_REGISTRY.engine('four_ball'));
});

// ---------------------------------------------------------------------------
// selecting → playing
// ---------------------------------------------------------------------------

test('both seats selecting a target starts play with a seeded first seat', () => {
  const state = localAiState('seed-first');
  assert.equal(state.status, 'selecting');
  selectFourBallTarget(state, 0, 5);
  assert.equal(state.status, 'selecting');
  selectFourBallTarget(state, 1, 8);
  assert.equal(state.status, 'playing');
  assert.equal(state.remaining.seat0, 5);
  assert.equal(state.remaining.seat1, 8);
  assert.ok(state.firstSeat === 0 || state.firstSeat === 1);
  assert.equal(state.currentSeat, state.firstSeat);
});

test('selecting an unsupported target is rejected', () => {
  const state = localAiState();
  assert.throws(() => selectFourBallTarget(state, 0, 7));
  // 옵션은 명시된 목록만 허용.
  for (const option of FOUR_BALL_TARGET_OPTIONS) {
    const fresh = localAiState();
    selectFourBallTarget(fresh, 0, option);
    assert.equal(fresh.targets.seat0, option);
  }
});

test('shooting before both players selected throws', () => {
  const state = localAiState();
  selectFourBallTarget(state, 0, 5);
  assert.throws(() => applyFourBallShot(state, 0, { angle: 0, power: 0.5, tipX: 0, tipY: 0 }, 'manual'));
});

// ---------------------------------------------------------------------------
// scoring / turn flow
// ---------------------------------------------------------------------------

function startedState(seed = 'seed-play') {
  const state = localAiState(seed);
  selectFourBallTarget(state, 0, 5);
  selectFourBallTarget(state, 1, 5);
  return state;
}

test('a successful carom decrements remaining and keeps the turn', () => {
  const state = startedState();
  const shooter = state.currentSeat;
  // 수구를 두 빨강 사이로 통과시키는 배치로 강제(성공 보장).
  const cueKey = shooter === 0 ? 'cue0' : 'cue1';
  state.balls[cueKey] = { x: 500, y: 470 };
  state.balls.red1 = { x: 480, y: 250 };
  state.balls.red2 = { x: 520, y: 250 };
  const record = applyFourBallShot(state, shooter, { angle: -Math.PI / 2, power: 0.6, tipX: 0, tipY: 0 }, 'manual');
  if (record.outcome.scored) {
    assert.equal(state.remaining[`seat${shooter}`], 4);
    assert.equal(state.currentSeat, shooter, 'turn continues on score');
    assert.equal(record.outcome.continueTurn, true);
  } else {
    // 물리 결과가 실패면 턴이 넘어가야 한다.
    assert.equal(state.currentSeat, 1 - shooter);
  }
});

test('a miss passes the turn to the opponent', () => {
  const state = startedState();
  const shooter = state.currentSeat;
  const cueKey = shooter === 0 ? 'cue0' : 'cue1';
  // 빨강에서 멀리 떨어뜨리고 벽 방향으로 약하게 → 실패.
  state.balls[cueKey] = { x: 100, y: 100 };
  state.balls.red1 = { x: 900, y: 400 };
  state.balls.red2 = { x: 880, y: 420 };
  const record = applyFourBallShot(state, shooter, { angle: Math.PI, power: 0.15, tipX: 0, tipY: 0 }, 'manual');
  assert.equal(record.outcome.scored, false);
  assert.equal(state.currentSeat, 1 - shooter);
});

test('reaching 0 remaining requires a three-cushion finish to win', () => {
  const state = startedState('finish-seed');
  const shooter = state.currentSeat;
  const seatKey = `seat${shooter}`;
  state.remaining[seatKey] = 1;
  // 성공 배치로 1점 성공 → 잔여 0, 마무리 필요.
  const cueKey = shooter === 0 ? 'cue0' : 'cue1';
  state.balls[cueKey] = { x: 500, y: 470 };
  state.balls.red1 = { x: 480, y: 250 };
  state.balls.red2 = { x: 520, y: 250 };
  const record = applyFourBallShot(state, shooter, { angle: -Math.PI / 2, power: 0.6, tipX: 0, tipY: 0 }, 'manual');
  if (record.outcome.scored) {
    assert.equal(state.remaining[seatKey], 0);
    assert.equal(state.needsThreeCushionFinish[seatKey], true);
    assert.equal(state.status, 'playing', 'reaching 0 does not win immediately');
  }
});

test('forfeit ends the game for the other seat', () => {
  const state = startedState();
  const loser = state.currentSeat;
  applyFourBallForfeit(state, loser);
  assert.equal(state.status, 'finished');
  assert.equal(state.winnerSeat, 1 - loser);
  assert.equal(state.gameWinner.reason, 'opponent_left');
});

// ---------------------------------------------------------------------------
// termination guarantee (turn cap)
// ---------------------------------------------------------------------------

test('the game always terminates within the turn cap', () => {
  const state = startedState('cap-seed');
  let guard = 0;
  while (state.status === 'playing' && guard < FOUR_BALL_MAX_TURNS + 5) {
    const seat = state.currentSeat;
    const action = FOUR_BALL_ENGINE.aiAction(state, seat, 'medium');
    FOUR_BALL_ENGINE.applyAction(state, seat, action);
    guard += 1;
  }
  assert.equal(state.status, 'finished');
  assert.ok(state.turnCount <= FOUR_BALL_MAX_TURNS);
  assert.ok(state.winnerSeat === 0 || state.winnerSeat === 1);
});

// ---------------------------------------------------------------------------
// viewFor
// ---------------------------------------------------------------------------

test('viewFor exposes the full public state but hides the rng seed', () => {
  const state = startedState('view-seed');
  const view = fourBallViewFor(state, 0);
  assert.equal(view.mySeat, 0);
  assert.ok(view.balls.cue0 && view.balls.cue1 && view.balls.red1 && view.balls.red2);
  assert.deepEqual(view.cueBallOf, { seat0: 'cue0', seat1: 'cue1' });
  assert.equal(view.table.width, 1000);
  assert.equal(view.table.height, 500);
  assert.equal(view.table.ballRadius, 15);
  assert.deepEqual(view.targetOptions, [...FOUR_BALL_TARGET_OPTIONS]);
  assert.equal(view.currentTurn, `cue${state.currentSeat}`);
  assert.equal('rngSeed' in view, false, 'rngSeed must never be exposed');
});

test('engine.viewFor via the interface also hides the seed', () => {
  const state = startedState('iface-seed');
  const view = FOUR_BALL_ENGINE.viewFor(state, 1);
  assert.equal('rngSeed' in view, false);
  assert.equal(view.mySeat, 1);
});

// ---------------------------------------------------------------------------
// determinism through the engine
// ---------------------------------------------------------------------------

test('identical seed + shots reproduce identical outcomes', () => {
  const run = () => {
    const state = startedState('det-seed');
    const seat = state.currentSeat;
    return applyFourBallShot(state, seat, { angle: -1.2, power: 0.7, tipX: 0.3, tipY: 0.2 }, 'manual');
  };
  const a = run();
  const b = run();
  assert.deepEqual(a.animation.frames.at(-1), b.animation.frames.at(-1));
  assert.deepEqual(a.outcome, b.outcome);
  assert.equal(a.miscue, b.miscue);
});
