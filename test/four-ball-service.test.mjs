import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeDb, FakeRealtime } from './helpers/fake-db.mjs';
import { GamesService } from '../dist/games/games.service.js';

const user = { accountId: 'p1', subject: 'p1', serviceKey: 'game-platform', permission: 'player', claims: {} };
const opponent = { ...user, accountId: 'p2', subject: 'p2' };

test('four_ball local_ai create is in selecting phase with the AI target chosen', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const view = await service.createFourBallSession(user, undefined, undefined, 'medium');
  assert.equal(view.status, 'selecting');
  assert.equal(view.mode, 'local_ai');
  assert.equal(view.balls.red1.y, view.balls.red2.y);
  assert.equal(view.balls.cue0.x, view.balls.cue1.x);
  // AI(seat1)의 목표는 이미 선택되어 있고 사람(seat0)은 아직이다.
  assert.ok(view.targets.seat1 !== undefined);
  assert.equal(view.targets.seat0, undefined);
  assert.equal('rngSeed' in view, false);
});

test('four_ball common create/get routes work through the registry', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const created = await service.createGameSession('four_ball', user, { difficulty: 'easy' });
  const fetched = await service.getGameSession('four_ball', created.id, user);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.table.width, 1000);
  assert.deepEqual(fetched.targetOptions, [3, 5, 8, 10, 15, 20]);
});

test('four_ball friend match: select → play → shoot returns session + animation and is idempotent', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const created = await service.createFourBallSession(user, opponent.accountId, 'friend_match');
  assert.equal(created.status, 'selecting');

  await service.applyGameAction('four_ball', created.id, user, { type: 'select_target', payload: { target: 5 } });
  const afterBoth = await service.applyGameAction('four_ball', created.id, opponent, { type: 'select_target', payload: { target: 5 } });
  assert.equal(afterBoth.status, 'playing');

  const shooter = afterBoth.currentSeat === 0 ? user : opponent;
  const shot = await service.applyGameAction('four_ball', created.id, shooter, {
    type: 'shoot',
    payload: { angle: -1.4, power: 0.7, tipX: 0, tipY: 0 },
    clientMoveId: 'shot-1',
  });
  assert.ok(shot.animation.frames.length > 1, 'shot returns animation frames');
  assert.ok(shot.session.lastShot, 'session carries the last shot');
  assert.equal('rngSeed' in shot.session, false);

  // 동일 clientMoveId 재전송 → 재적용 없이 빈 애니메이션.
  const replay = await service.applyGameAction('four_ball', created.id, shooter, {
    type: 'shoot',
    payload: { angle: -1.4, power: 0.7, tipX: 0, tipY: 0 },
    clientMoveId: 'shot-1',
  });
  assert.equal(replay.animation.frames.length, 0, 'duplicate shot returns empty animation');
});

test('four_ball rejects a shot from the seat that is not on turn', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const created = await service.createFourBallSession(user, opponent.accountId, 'friend_match');
  await service.applyGameAction('four_ball', created.id, user, { type: 'select_target', payload: { target: 5 } });
  const afterBoth = await service.applyGameAction('four_ball', created.id, opponent, { type: 'select_target', payload: { target: 5 } });
  const offTurn = afterBoth.currentSeat === 0 ? opponent : user;
  await assert.rejects(() => service.applyGameAction('four_ball', created.id, offTurn, {
    type: 'shoot',
    payload: { angle: 0, power: 0.5, tipX: 0, tipY: 0 },
    clientMoveId: 'off-turn',
  }));
});

test('four_ball forfeit finishes the game for the opponent', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const created = await service.createFourBallSession(user, opponent.accountId, 'friend_match');
  await service.applyGameAction('four_ball', created.id, user, { type: 'select_target', payload: { target: 5 } });
  await service.applyGameAction('four_ball', created.id, opponent, { type: 'select_target', payload: { target: 5 } });
  const finished = await service.forfeitFourBall(created.id, user);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.winnerSeat, 1);
  assert.equal(finished.gameWinner.reason, 'opponent_left');
});
