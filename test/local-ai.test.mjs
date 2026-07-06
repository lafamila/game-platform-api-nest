import assert from 'node:assert/strict';
import test from 'node:test';

import { GamesService } from '../dist/games/games.service.js';
import {
  applySplendorAiTurn,
  applySplendorReserve,
  applySplendorTakeTokens,
  createSplendorState,
} from '../dist/games/splendor-engine.js';

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

test('gomoku local save restore rolls the server session back to the saved snapshot', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  const session = await service.createGomokuSession(user, undefined, undefined, 'medium');
  const savedPoint = await service.playGomokuMove(session.id, user, 7, 7);
  const savedSnapshot = JSON.parse(JSON.stringify(savedPoint));
  await wait(350);
  const serverLatest = await service.getGomokuSession(session.id, user);
  assert.equal(serverLatest.moves.length, 2);

  const restored = await service.restoreLocalSaveSnapshot('gomoku', session.id, user, {
    sessionId: session.id,
    board: savedSnapshot.board,
    players: savedSnapshot.players,
    aiDifficulty: savedSnapshot.aiDifficulty,
    currentTurn: savedSnapshot.currentTurn,
    mode: savedSnapshot.mode,
    status: savedSnapshot.status,
    winner: savedSnapshot.winner,
    moveCount: savedSnapshot.moves.length,
    lastMove: { row: 7, col: 7 },
  });

  assert.equal(restored.moves.length, 1);
  assert.equal(restored.currentTurn, 'white');
  assert.equal(restored.board[7][7], 'black');
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

test('splendor local sessions follow token turns and answer with AI', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  const session = await service.createSplendorSession(user, undefined, undefined, 'medium');
  assert.equal(session.mode, 'local_ai');
  assert.equal(session.mySide, 'challenger');
  assert.equal(session.currentTurn, 'challenger');
  assert.equal(session.market['1'].length, 4);
  assert.equal(session.market['2'].length, 4);
  assert.equal(session.market['3'].length, 4);
  assert.equal(session.deckCounts['1'], 36);
  assert.equal(session.deckCounts['2'], 26);
  assert.equal(session.deckCounts['3'], 16);
  assert.equal(session.nobles.length, 3);

  const moved = await service.takeSplendorTokens(session.id, user, {
    white: 1,
    blue: 1,
    green: 1,
  });
  assert.equal(moved.playerStates.challenger.tokens.white, 1);
  assert.equal(moved.moves[0].action, 'take_tokens');
  assert.equal(moved.currentTurn, 'opponent');

  await wait(350);
  const answered = await service.getSplendorSession(session.id, user);
  assert.equal(answered.currentTurn, 'challenger');
  assert.equal(answered.moves.length, 2);
  assert.equal(answered.moves[1].source, 'ai');
});

test('fortress local sessions use a long world and answer player shots', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  const session = await service.createFortressSession(user, undefined, undefined, 'hard');
  assert.equal(session.mode, 'local_ai');
  assert.equal(session.aiDifficulty, 'hard');
  assert.equal(session.status, 'selecting');
  assert.ok(session.world.width > 1000);
  assert.equal(session.tanks.opponent.accountId, '__game_platform_local_ai__');
  assert.ok(session.tanks.opponent.tankKey);

  const selected = await service.selectFortressTank(session.id, user, 'balance');
  assert.equal(selected.status, 'playing');
  assert.equal(selected.currentTurn, 'challenger');
  assert.equal(selected.tanks.challenger.tankKey, 'balance');
  assert.ok(selected.movementRemaining.challenger > 0);
  const movementBefore = selected.movementRemaining.challenger;

  const moved = await service.moveFortress(session.id, user, 10);
  assert.equal(moved.currentTurn, 'challenger');
  assert.ok(moved.movementRemaining.challenger < movementBefore);

  const result = await service.shootFortress(session.id, user, 45, 82);
  assert.ok(result.animation.projectile.length > 1);
  assert.equal(result.session.shots.length, 1);
  assert.equal(result.session.shots[0].source, 'manual');

  if (result.session.status === 'playing') {
    await wait(1_150);
    const answered = await service.getFortressSession(session.id, user);
    assert.equal(answered.shots.length, 2);
    assert.equal(answered.shots[1].source, 'ai');
    assert.equal(answered.currentTurn, 'challenger');
  }
});

test('splendor hard AI buys an immediate winning card', () => {
  const session = createSplendorState(user.accountId, 'ai-player', 'local_ai', 'hard');
  const winningCard = {
    id: 'test-winning-card',
    tier: '1',
    color: 'white',
    points: 1,
    cost: { white: 0, blue: 0, green: 0, red: 0, black: 0 },
    art: 'crown',
  };
  session.currentTurn = 'opponent';
  session.playerStates.opponent.score = 14;
  session.market = { '1': [winningCard], '2': [], '3': [] };
  session.decks = { '1': [], '2': [], '3': [] };

  applySplendorAiTurn(session);

  assert.equal(session.status, 'finished');
  assert.equal(session.winnerSide, 'opponent');
  assert.equal(session.moves.at(-1).action, 'buy');
  assert.equal(session.moves.at(-1).source, 'ai');
});

test('splendor token gain requires exact discard only when token limit is exceeded', () => {
  const session = createSplendorState(user.accountId, 'ai-player', 'local_ai', 'medium');
  session.currentTurn = 'challenger';
  session.playerStates.challenger.tokens = {
    white: 2,
    blue: 2,
    green: 2,
    red: 2,
    black: 2,
    gold: 0,
  };

  assert.throws(
    () =>
      applySplendorTakeTokens(session, 'challenger', user.accountId, {
        blue: 1,
        green: 1,
        red: 1,
      }),
    /discard 3 token/,
  );

  applySplendorTakeTokens(
    session,
    'challenger',
    user.accountId,
    { blue: 1, green: 1, red: 1 },
    { white: 1, blue: 1, green: 1 },
  );

  assert.equal(session.playerStates.challenger.tokens.white, 1);
  assert.equal(session.playerStates.challenger.tokens.blue, 2);
  assert.equal(session.playerStates.challenger.tokens.green, 2);
  assert.equal(session.playerStates.challenger.tokens.red, 3);
  assert.equal(session.playerStates.challenger.tokens.black, 2);
  assert.equal(session.moves.at(-1).detail.discardTokens.white, 1);
  assert.equal(session.moves.at(-1).detail.discardTokens.blue, 1);
  assert.equal(session.moves.at(-1).detail.discardTokens.green, 1);
});

test('splendor reserve gold can overflow only with an exact discard', () => {
  const session = createSplendorState(user.accountId, 'ai-player', 'local_ai', 'medium');
  const card = session.market['1'][0];
  session.currentTurn = 'challenger';
  session.playerStates.challenger.tokens = {
    white: 2,
    blue: 2,
    green: 2,
    red: 2,
    black: 2,
    gold: 0,
  };

  assert.throws(
    () => applySplendorReserve(session, 'challenger', user.accountId, { cardId: card.id }),
    /discard 1 token/,
  );

  applySplendorReserve(session, 'challenger', user.accountId, {
    cardId: card.id,
    discardTokens: { white: 1 },
  });

  assert.equal(session.playerStates.challenger.tokens.white, 1);
  assert.equal(session.playerStates.challenger.tokens.blue, 2);
  assert.equal(session.playerStates.challenger.tokens.green, 2);
  assert.equal(session.playerStates.challenger.tokens.red, 2);
  assert.equal(session.playerStates.challenger.tokens.black, 2);
  assert.equal(session.playerStates.challenger.tokens.gold, 1);
  assert.equal(session.playerStates.challenger.reserved[0].id, card.id);
  assert.equal(session.moves.at(-1).detail.discardTokens.white, 1);
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
    if (sql.includes('FROM game_sessions') && sql.includes('ORDER BY updated_at')) {
      const active = [...this.rows.values()].filter(
        (row) =>
          !['finished', 'cleared', 'failed'].includes(row.status) &&
          (row.owner_account_id === args[0] || row.opponent_account_id === args[0]),
      );
      return { rows: active };
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
    if (sql.includes('UPDATE game_sessions') && sql.includes('abandoned')) {
      const cutoff = Date.now() - args[0] * 86_400_000;
      const updated = [];
      for (const row of this.rows.values()) {
        if (!['finished', 'cleared', 'failed'].includes(row.status) && row.updated_at.getTime() < cutoff) {
          row.status = 'finished';
          row.state_json = { ...row.state_json, status: 'finished', finishReason: 'abandoned' };
          row.updated_at = new Date();
          updated.push(row);
        }
      }
      return { rows: updated };
    }
    if (sql.includes('UPDATE game_sessions')) {
      const row = this.rows.get(args[0]);
      if (args.length > 5 && (row.state_json.rev ?? 0) !== args[5]) {
        return { rows: [] };
      }
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
  online = true;

  emitToAccounts() {}

  isAccountConnected() {
    return this.online;
  }

  async isAccountOnline() {
    return this.online;
  }
}

test('duplicate clientMoveId re-responds without reapplying, and a new id applies', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  try {
    const session = await service.createGomokuSession(user, opponent.accountId, undefined, 'medium');

    const first = await service.playGomokuMove(session.id, user, 7, 7, 'move-1');
    assert.equal(first.moves.length, 1);
    assert.equal(first.board[7][7], 'black');
    assert.equal(first.currentTurn, 'white');
    const revAfterFirst = first.rev;

    // 동일 clientMoveId 재제출: 재적용 없이 현재 상태를 그대로 재응답 (에러 아님)
    const duplicate = await service.playGomokuMove(session.id, user, 7, 7, 'move-1');
    assert.equal(duplicate.moves.length, 1);
    assert.equal(duplicate.rev, revAfterFirst);
    assert.equal(duplicate.currentTurn, 'white');
    assert.equal(duplicate.board[7][7], 'black');

    // 새 clientMoveId 는 정상 적용된다
    const second = await service.playGomokuMove(session.id, opponent, 8, 8, 'move-2');
    assert.equal(second.moves.length, 2);
    assert.equal(second.board[8][8], 'white');
  } finally {
    service.onModuleDestroy();
  }
});

test('stale game session writes fail with a state conflict', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const session = await service.createGomokuSession(user, undefined, undefined, 'medium');
  assert.equal(session.rev, 1);

  const stale = JSON.parse(JSON.stringify(session));
  const moved = await service.playGomokuMove(session.id, user, 7, 7);
  assert.equal(moved.rev, 2);

  await assert.rejects(
    () => service.updateGame(session.id, stale.status, stale.currentTurn, null, stale),
    (error) => error.getStatus?.() === 409 && error.getResponse?.().code === 'STATE_CONFLICT',
  );

  const latest = await service.getGomokuSession(session.id, user);
  assert.equal(latest.moves.length, 1);
});

test('active session list returns my unfinished sessions', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const session = await service.createGomokuSession(user, undefined, undefined, 'medium');

  const mine = await service.listActiveSessions(user);
  assert.equal(mine.sessions.length, 1);
  assert.equal(mine.sessions[0].sessionId, session.id);
  assert.equal(mine.sessions[0].gameKey, 'gomoku');
  assert.equal(mine.sessions[0].rev, 1);
  assert.equal(mine.sessions[0].myTurn, true);

  const theirs = await service.listActiveSessions(opponent);
  assert.equal(theirs.sessions.length, 0);

  await service.forfeitGomoku(session.id, user);
  const after = await service.listActiveSessions(user);
  assert.equal(after.sessions.length, 0);
});

test('abandoned sessions are finished by the gc job', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  const session = await service.createGomokuSession(user, undefined, undefined, 'medium');
  db.rows.get(session.id).updated_at = new Date(Date.now() - 8 * 86_400_000);

  const cleaned = await service.gcAbandonedSessions();
  assert.equal(cleaned, 1);

  const after = await service.listActiveSessions(user);
  assert.equal(after.sessions.length, 0);
  const finished = await service.getGomokuSession(session.id, user);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finishReason, 'abandoned');
});

test('remaining player can claim a win after the opponent leaves', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  const session = await service.createGomokuSession(user, opponent.accountId);
  const row = db.rows.get(session.id);
  row.state_json.opponentLeftAt = new Date().toISOString();
  row.state_json.networkGraceAccountId = opponent.accountId;

  realtime.online = false;
  const finished = await service.claimDisconnectedWin('gomoku', session.id, user);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finishReason, 'disconnect');
  assert.equal(finished.players[finished.winner], user.accountId);
  service.onModuleDestroy();
});

test('claim is rejected when the opponent reconnected', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  const session = await service.createGomokuSession(user, opponent.accountId);
  const row = db.rows.get(session.id);
  row.state_json.opponentLeftAt = new Date().toISOString();
  row.state_json.networkGraceAccountId = opponent.accountId;

  realtime.online = true;
  await assert.rejects(
    () => service.claimDisconnectedWin('gomoku', session.id, user),
    (error) => error.getStatus?.() === 409 && error.getResponse?.().code === 'OPPONENT_RECONNECTED',
  );
  const resumed = await service.getGomokuSession(session.id, user);
  assert.equal(resumed.status, 'playing');
  assert.equal(resumed.opponentLeftAt, undefined);
  service.onModuleDestroy();
});

test('waiting keeps the abandoned match open for a later claim', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  const session = await service.createGomokuSession(user, opponent.accountId);
  const row = db.rows.get(session.id);
  row.state_json.opponentLeftAt = new Date().toISOString();
  row.state_json.networkGraceAccountId = opponent.accountId;

  realtime.online = false;
  const waiting = await service.waitForOpponent('gomoku', session.id, user);
  assert.equal(waiting.status, 'playing');

  const finished = await service.claimDisconnectedWin('gomoku', session.id, user);
  assert.equal(finished.status, 'finished');
  service.onModuleDestroy();
});
