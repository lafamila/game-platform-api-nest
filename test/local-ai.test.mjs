import assert from 'node:assert/strict';
import test from 'node:test';

import { GamesService } from '../dist/games/games.service.js';

const user = {
  accountId: 'player-1',
  subject: 'player-1',
  serviceKey: 'game-platform',
  permission: 'player',
  claims: {},
};

test('gomoku local sessions are AI games and answer player moves', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  const session = await service.createGomokuSession(user, undefined, undefined, 'hard');
  assert.equal(session.mode, 'local_ai');
  assert.equal(session.aiDifficulty, 'hard');
  assert.notEqual(session.players.white, user.accountId);

  const moved = await service.playGomokuMove(session.id, user, 7, 7);
  assert.equal(moved.moves.length, 1);
  assert.equal(moved.moves[0].source, 'manual');
  assert.equal(moved.currentTurn, 'white');

  await wait(350);
  const answered = await service.getGomokuSession(session.id, user);
  assert.equal(answered.moves.length, 2);
  assert.equal(answered.moves[1].source, 'ai');
  assert.equal(answered.currentTurn, 'black');
});

test('alkkagi local sessions are AI games and answer player shots', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  const session = await service.createAlkkagiSession(user, undefined, undefined, 'easy');
  assert.equal(session.mode, 'local_ai');
  assert.equal(session.aiDifficulty, 'easy');
  assert.notEqual(session.players.blue, user.accountId);

  const redPiece = session.pieces.find((piece) => piece.active && piece.team === 'red');
  const result = await service.shootAlkkagi(session.id, user, redPiece.id, 4, -8);
  assert.equal(result.session.shots.length, 1);
  assert.equal(result.session.shots[0].source, 'manual');
  assert.equal(result.session.currentTurn, 'blue');
  assert.ok(result.animation.frames.length > 1);

  await wait(900);
  const answered = await service.getAlkkagiSession(session.id, user);
  assert.equal(answered.shots.length, 2);
  assert.equal(answered.shots[1].source, 'ai');
  assert.equal(answered.currentTurn, 'red');
});

test('othello local sessions are AI games and answer player moves', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  const session = await service.createOthelloSession(user, undefined, undefined, 'medium');
  assert.equal(session.mode, 'local_ai');
  assert.equal(session.aiDifficulty, 'medium');
  assert.equal(session.players.black, user.accountId);
  assert.notEqual(session.players.white, user.accountId);

  const moved = await service.playOthelloMove(session.id, user, 2, 3);
  assert.equal(moved.moves.length, 1);
  assert.equal(moved.moves[0].source, 'manual');
  assert.equal(moved.currentTurn, 'white');

  await wait(350);
  const answered = await service.getOthelloSession(session.id, user);
  assert.equal(answered.moves.length, 2);
  assert.equal(answered.moves[1].source, 'ai');
  assert.equal(answered.currentTurn, 'black');
});

test('sokoban solo sessions load difficulty maps and finish on solved moves', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  const session = await service.createSokobanSession(user, 'easy');
  assert.equal(session.mode, 'solo');
  assert.equal(session.difficulty, 'easy');
  assert.equal(session.status, 'playing');
  assert.deepEqual(session.state.player, { row: 1, col: 1 });

  const moved = await service.moveSokoban(session.id, user, 'right');
  assert.equal(moved.state.moves, 1);
  assert.equal(moved.state.solved, true);
  assert.equal(moved.status, 'finished');
  assert.equal(moved.winnerSide, 'challenger');
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeDb {
  rows = new Map();
  nextId = 1;

  async query(sql, args = []) {
    if (sql.includes('INSERT INTO game_sessions')) {
      const row = {
        id: `game-${this.nextId++}`,
        game_key: args[0],
        mode: args[1],
        status: args[2],
        current_turn: args[3],
        winner: args[4],
        owner_account_id: args[5],
        opponent_account_id: args[6],
        state_json: JSON.parse(args[7]),
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.rows.set(row.id, row);
      return { rows: [row] };
    }
    if (sql.includes('UPDATE game_sessions')) {
      const row = this.rows.get(args[0]);
      row.status = args[1];
      row.current_turn = args[2];
      row.winner = args[3];
      row.state_json = JSON.parse(args[4]);
      row.updated_at = new Date();
      return { rows: [row] };
    }
    return { rows: [] };
  }

  async one(_sql, args = []) {
    const row = this.rows.get(args[0]);
    if (!row || row.game_key !== args[1]) {
      return null;
    }
    return row;
  }
}

class FakeRealtime {
  emitToAccounts() {}
  isAccountConnected() {
    return true;
  }
}
