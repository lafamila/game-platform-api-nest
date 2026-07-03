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
const opponent = {
  ...user,
  accountId: 'player-2',
  subject: 'player-2',
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

test('sokoban solo sessions generate solvable difficulty maps', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  for (const difficulty of ['easy', 'medium', 'hard']) {
    const session = await service.createSokobanSession(user, difficulty);
    assert.equal(session.mode, 'solo');
    assert.equal(session.difficulty, difficulty);
    assert.equal(session.status, 'playing');
    assert.equal(session.initialBoxes.length, difficulty === 'easy' ? 1 : difficulty === 'medium' ? 2 : 3);
    assert.equal(session.goals.length, session.initialBoxes.length);
    assert.ok(session.mapKey.startsWith(`${difficulty}-`));
  }

  const session = await service.createSokobanSession(user, 'easy');
  const solution = findSokobanSolution(session);
  assert.ok(solution.length > 0);
  let moved = session;
  for (const direction of solution) {
    moved = await service.moveSokoban(session.id, user, direction);
    if (moved.status === 'finished') {
      break;
    }
  }
  assert.equal(moved.state.solved, true);
  assert.equal(moved.status, 'finished');
  assert.equal(moved.winnerSide, 'challenger');
  assert.equal(moved.finishReason, 'solo_clear');
});

test('sokoban sessions prefer the precomputed map pool when available', async () => {
  const db = new FakeDb();
  db.sokobanMaps.push({
    id: 'map-1',
    difficulty: 'easy',
    map_key: 'stored-easy-map',
    map_json: storedEasySokobanMap(),
    metrics_json: { pushes: 2, boxLines: 1, boxChanges: 0 },
    created_at: new Date(),
  });
  const service = new GamesService(db, new FakeRealtime());

  const session = await service.createSokobanSession(user, 'easy');
  assert.equal(session.mapKey, 'stored-easy-map');
  assert.deepEqual(session.state.player, { row: 4, col: 3 });

  await service.moveSokoban(session.id, user, 'up');
  const moved = await service.moveSokoban(session.id, user, 'up');
  assert.equal(moved.state.solved, true);
  assert.equal(moved.status, 'finished');
  assert.equal(moved.finishReason, 'solo_clear');
});

test('sokoban solo sessions finish as a loss when the puzzle becomes unsolvable', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());

  const session = await service.createSokobanSession(user, 'easy');
  applySokobanPushDeadlockFixture(db.rows.get(session.id).state_json);

  const moved = await service.moveSokoban(session.id, user, 'right');
  assert.equal(moved.state.solved, false);
  assert.equal(moved.status, 'finished');
  assert.equal(moved.finishReason, 'deadlock');
  assert.equal(moved.winnerSide, undefined);
});

test('sokoban solo sessions skip deadlock checks for player-only moves', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());

  const session = await service.createSokobanSession(user, 'easy');
  applySokobanDeadlockFixture(db.rows.get(session.id).state_json);
  db.rows.get(session.id).state_json.state.player = { row: 2, col: 2 };

  const moved = await service.moveSokoban(session.id, user, 'left');
  assert.equal(moved.state.moves, 1);
  assert.equal(moved.state.solved, false);
  assert.equal(moved.status, 'playing');
  assert.equal(moved.finishReason, undefined);
});

test('sokoban matched sessions award the opponent when a player deadlocks', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());

  const session = await service.createSokobanSession(user, 'easy', opponent.accountId);
  applySokobanPushDeadlockFixture(db.rows.get(session.id).state_json, true);

  const moved = await service.moveSokoban(session.id, user, 'right');
  assert.equal(moved.state.solved, false);
  assert.equal(moved.status, 'finished');
  assert.equal(moved.finishReason, 'deadlock');
  assert.equal(moved.winnerSide, 'opponent');
  assert.equal(moved.winnerAccountId, opponent.accountId);
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storedEasySokobanMap() {
  return {
    key: 'stored-easy-map',
    walls: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 0, col: 3 },
      { row: 0, col: 4 },
      { row: 0, col: 5 },
      { row: 0, col: 6 },
      { row: 1, col: 0 },
      { row: 1, col: 6 },
      { row: 2, col: 0 },
      { row: 2, col: 6 },
      { row: 3, col: 0 },
      { row: 3, col: 6 },
      { row: 4, col: 0 },
      { row: 4, col: 6 },
      { row: 5, col: 0 },
      { row: 5, col: 1 },
      { row: 5, col: 2 },
      { row: 5, col: 3 },
      { row: 5, col: 4 },
      { row: 5, col: 5 },
      { row: 5, col: 6 },
    ],
    goals: [{ row: 1, col: 3 }],
    player: { row: 4, col: 3 },
    boxes: [{ row: 3, col: 3 }],
    metrics: { pushes: 2, boxLines: 1, boxChanges: 0 },
  };
}

function findSokobanSolution(session) {
  const start = {
    player: session.state.player,
    boxes: session.state.boxes,
    path: [],
  };
  const queue = [start];
  const seen = new Set([sokobanStateKey(start.player, start.boxes)]);
  let index = 0;
  while (index < queue.length && seen.size < 80000) {
    const current = queue[index++];
    for (const [direction, delta] of Object.entries(sokobanDeltas)) {
      const nextPlayer = addPosition(current.player, delta);
      if (!isSokobanFloorForTest(session, nextPlayer) || hasPosition(session.walls, nextPlayer)) {
        continue;
      }
      const boxIndex = current.boxes.findIndex((box) => samePosition(box, nextPlayer));
      const nextBoxes = current.boxes.map((box) => ({ ...box }));
      if (boxIndex >= 0) {
        const pushed = addPosition(nextPlayer, delta);
        if (
          !isSokobanFloorForTest(session, pushed) ||
          hasPosition(session.walls, pushed) ||
          nextBoxes.some((box, index) => index !== boxIndex && samePosition(box, pushed))
        ) {
          continue;
        }
        nextBoxes[boxIndex] = pushed;
      }
      const next = { player: nextPlayer, boxes: nextBoxes, path: [...current.path, direction] };
      if (next.boxes.every((box) => hasPosition(session.goals, box))) {
        return next.path;
      }
      const key = sokobanStateKey(next.player, next.boxes);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      queue.push(next);
    }
  }
  throw new Error(`generated sokoban map was not solved within ${seen.size} states`);
}

function applySokobanDeadlockFixture(session, matched = false) {
  session.mapKey = 'test-deadlock';
  session.walls = [
    { row: 0, col: 0 },
    { row: 0, col: 1 },
    { row: 0, col: 2 },
    { row: 0, col: 3 },
    { row: 1, col: 0 },
    { row: 1, col: 3 },
    { row: 2, col: 0 },
    { row: 2, col: 3 },
    { row: 3, col: 0 },
    { row: 3, col: 1 },
    { row: 3, col: 2 },
    { row: 3, col: 3 },
  ];
  session.goals = [{ row: 2, col: 2 }];
  session.initialPlayer = { row: 2, col: 1 };
  session.initialBoxes = [{ row: 1, col: 1 }];
  const state = {
    player: { row: 2, col: 1 },
    boxes: [{ row: 1, col: 1 }],
    moves: 0,
    solved: false,
  };
  if (matched) {
    session.states.challenger = state;
  } else {
    session.state = state;
  }
}

function applySokobanPushDeadlockFixture(session, matched = false) {
  session.mapKey = 'test-push-deadlock';
  session.walls = [
    { row: 0, col: 0 },
    { row: 0, col: 1 },
    { row: 0, col: 2 },
    { row: 0, col: 3 },
    { row: 0, col: 4 },
    { row: 1, col: 0 },
    { row: 1, col: 4 },
    { row: 2, col: 0 },
    { row: 2, col: 4 },
    { row: 3, col: 0 },
    { row: 3, col: 4 },
    { row: 4, col: 0 },
    { row: 4, col: 1 },
    { row: 4, col: 2 },
    { row: 4, col: 3 },
    { row: 4, col: 4 },
  ];
  session.goals = [{ row: 3, col: 1 }];
  session.initialPlayer = { row: 2, col: 1 };
  session.initialBoxes = [{ row: 2, col: 2 }];
  const state = {
    player: { row: 2, col: 1 },
    boxes: [{ row: 2, col: 2 }],
    moves: 0,
    solved: false,
  };
  if (matched) {
    session.states.challenger = state;
  } else {
    session.state = state;
  }
}

const sokobanDeltas = {
  up: { row: -1, col: 0 },
  down: { row: 1, col: 0 },
  left: { row: 0, col: -1 },
  right: { row: 0, col: 1 },
};

function addPosition(position, delta) {
  return { row: position.row + delta.row, col: position.col + delta.col };
}

function sokobanStateKey(player, boxes) {
  return `${positionKey(player)}|${boxes.map(positionKey).sort().join(';')}`;
}

function isSokobanFloorForTest(session, position) {
  const positions = [...session.walls, ...session.goals, session.initialPlayer, ...session.initialBoxes];
  const bounds = positions.reduce(
    (current, item) => ({
      minRow: Math.min(current.minRow, item.row),
      maxRow: Math.max(current.maxRow, item.row),
      minCol: Math.min(current.minCol, item.col),
      maxCol: Math.max(current.maxCol, item.col),
    }),
    { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 },
  );
  return position.row >= bounds.minRow && position.row <= bounds.maxRow && position.col >= bounds.minCol && position.col <= bounds.maxCol;
}

function positionKey(position) {
  return `${position.row},${position.col}`;
}

function samePosition(left, right) {
  return left.row === right.row && left.col === right.col;
}

function hasPosition(items, target) {
  return items.some((item) => samePosition(item, target));
}

class FakeDb {
  rows = new Map();
  sokobanMaps = [];
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
    if (sql.includes('FROM sokoban_maps')) {
      return { rows: this.sokobanMaps.filter((row) => row.difficulty === args[0]).slice(0, 1) };
    }
    if (sql.includes('INSERT INTO sokoban_maps')) {
      const row = {
        id: `map-${this.sokobanMaps.length + 1}`,
        difficulty: args[0],
        map_key: args[1],
        map_json: JSON.parse(args[2]),
        metrics_json: JSON.parse(args[3]),
        created_at: new Date(),
      };
      if (!this.sokobanMaps.some((item) => item.map_key === row.map_key)) {
        this.sokobanMaps.push(row);
      }
      return { rows: [] };
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
