import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { FakeDb, FakeRealtime } from './helpers/fake-db.mjs';

import { GamesService } from '../dist/games/games.service.js';
import { GAME_REGISTRY } from '../dist/games/engine/game-registry.js';
import {
  applySplendorAiTurn,
  applySplendorReserve,
  applySplendorTakeTokens,
  createSplendorState,
  SPLENDOR_ENGINE,
} from '../dist/games/splendor-engine.js';
import {
  CRAZY_ARCADE_ENGINE,
  advanceCrazyArcadeServer,
  createCrazyArcadeSnapshotForSides,
} from '../dist/games/crazy-arcade-engine.js';
import {
  OTHELLO_ENGINE,
  othelloLegalMoves,
} from '../dist/games/othello-engine.js';
import {
  GOMOKU_ENGINE,
  chooseGomokuAiMove,
} from '../dist/games/gomoku-engine.js';
import { SOKOBAN_ENGINE } from '../dist/games/sokoban-engine.js';
import {
  SUDOKU_ENGINE,
  createSudokuSessionState,
} from '../dist/games/sudoku-engine.js';
import { ALKKAGI_ENGINE } from '../dist/games/alkkagi-engine.js';
import { FORTRESS_ENGINE } from '../dist/games/fortress-engine.js';

// hard AI 예산을 소예산으로 오버라이드(호출 시점 판독). 400ms 미만이라 워커 대신 동기 신 엔진 경로를 타
// 기존 타이밍 테스트(예: hard 오목 350ms 대기)가 25초 기본 예산에 깨지지 않게 한다.
process.env.GOMOKU_AI_BUDGET_MS = '80';
process.env.OTHELLO_AI_BUDGET_MS = '80';
import { MIGHTY_ENGINE } from '../dist/games/mighty-engine.js';

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

test('game registry descriptors are defensive and drive player bounds', () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const games = service.listGames();
  const sudoku = games.find((game) => game.key === 'sudoku');
  const sokoban = games.find((game) => game.key === 'sokoban');
  const othello = games.find((game) => game.key === 'othello');
  const splendor = games.find((game) => game.key === 'splendor');
  const crazyArcade = games.find((game) => game.key === 'crazy_arcade');
  const mighty = games.find((game) => game.key === 'mighty');

  assert.equal(sudoku.maxPlayers, 6);
  assert.equal(sokoban.maxPlayers, 6);
  assert.equal(othello.turnTimerSeconds, 20);
  assert.equal(othello.graceSeconds, 60);
  assert.equal(splendor.maxPlayers, 4);
  assert.equal(crazyArcade.graceSeconds, 60);
  assert.equal(crazyArcade.supportsMatchSave, true);
  assert.equal(mighty.minPlayers, 5);
  assert.equal(mighty.maxPlayers, 5);
  assert.equal(mighty.hiddenInfo, true);
  assert.equal(GAME_REGISTRY.engine('sudoku')?.descriptor.key, 'sudoku');
  assert.equal(GAME_REGISTRY.engine('gomoku')?.descriptor.key, 'gomoku');
  assert.equal(GAME_REGISTRY.engine('alkkagi')?.descriptor.key, 'alkkagi');
  assert.equal(GAME_REGISTRY.engine('othello')?.descriptor.key, 'othello');
  assert.equal(GAME_REGISTRY.engine('sokoban')?.descriptor.key, 'sokoban');
  assert.equal(GAME_REGISTRY.engine('splendor')?.descriptor.key, 'splendor');
  assert.equal(GAME_REGISTRY.engine('splendor')?.descriptor.turnTimerSeconds, undefined);
  assert.equal(GAME_REGISTRY.engine('fortress')?.descriptor.key, 'fortress');
  assert.equal(GAME_REGISTRY.engine('fortress')?.descriptor.turnTimerSeconds, 20);
  assert.equal(GAME_REGISTRY.engine('crazy_arcade')?.descriptor.key, 'crazy_arcade');
  assert.equal(GAME_REGISTRY.engine('crazy_arcade')?.descriptor.turnType, 'realtimeServer');
  assert.equal(GAME_REGISTRY.engine('mighty')?.descriptor.key, 'mighty');

  sudoku.modes.push('broken');
  const freshSudoku = service.listGames().find((game) => game.key === 'sudoku');
  assert.equal(freshSudoku.modes.includes('broken'), false);

  service.onModuleDestroy();
});

test('generic session create and get dispatch through registered game keys', async () => {
  const db = new FakeDb();
  db.sokobanMaps.push({
    id: 'map-generic-create',
    difficulty: 'easy',
    map_key: 'generic-create-easy',
    map_json: storedEasySokobanMap(),
  });
  const service = new GamesService(db, new FakeRealtime());
  try {
    for (const gameKey of [
      'sudoku',
      'gomoku',
      'alkkagi',
      'othello',
      'sokoban',
      'splendor',
      'fortress',
      'crazy_arcade',
      'mighty',
    ]) {
      const created = await service.createGameSession(gameKey, user, { difficulty: 'easy' });
      assert.equal(created.id.length > 0, true);
      const fetched = await service.getGameSession(gameKey, created.id, user);
      assert.equal(fetched.id, created.id);
    }

    await assert.rejects(
      () => service.createGameSession('missing-game', user, { difficulty: 'easy' }),
      /unsupported gameKey/,
    );
  } finally {
    service.onModuleDestroy();
  }
});

test('generic session create preserves the selected white stone color', async () => {
  for (const gameKey of ['gomoku', 'othello']) {
    const service = new GamesService(new FakeDb(), new FakeRealtime());
    try {
      const session = await service.createGameSession(gameKey, user, {
        difficulty: 'medium',
        color: 'white',
      });

      assert.notEqual(session.players.black, user.accountId);
      assert.equal(session.players.white, user.accountId);
      assert.equal(session.currentTurn, 'black');
      assert.equal(session.moves.length, 0);
    } finally {
      service.onModuleDestroy();
    }
  }
});

test('alkkagi engine contract creates state and applies shots', () => {
  const session = ALKKAGI_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
    { seat: 1, kind: 'account', accountId: opponent.accountId },
  ], { id: 'alkkagi-engine-1', mode: 'friend_match', aiDifficulty: 'medium' });

  assert.equal(ALKKAGI_ENGINE.descriptor.key, 'alkkagi');
  assert.equal(ALKKAGI_ENGINE.descriptor.turnTimerSeconds, 10);
  assert.equal(session.pieces.some((piece) => piece.id === 'red-soldier-1'), true);

  const result = ALKKAGI_ENGINE.applyAction(session, 0, {
    type: 'shoot',
    payload: { pieceId: 'red-soldier-1', vx: 12, vy: -4 },
  });

  assert.equal(result.state.shots.length, 1);
  assert.equal(result.state.currentTurn, 'blue');
  assert.equal(result.state.shots[0].team, 'red');
});

test('gomoku engine contract creates state and applies legal moves', () => {
  const session = GOMOKU_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
    { seat: 1, kind: 'account', accountId: opponent.accountId },
  ], { id: 'gomoku-engine-1', mode: 'friend_match', aiDifficulty: 'medium' });

  assert.equal(GOMOKU_ENGINE.descriptor.key, 'gomoku');
  assert.equal(GOMOKU_ENGINE.descriptor.turnTimerSeconds, 15);
  assert.equal(session.board.length, 15);
  assert.equal(session.currentTurn, 'black');

  const result = GOMOKU_ENGINE.applyAction(session, 0, {
    type: 'move',
    payload: { row: 7, col: 7 },
  });

  assert.equal(result.state.board[7][7], 'black');
  assert.equal(result.state.currentTurn, 'white');
  assert.ok(chooseGomokuAiMove(result.state, 'medium'));
});

test('sudoku engine contract hides solution and applies solo moves', () => {
  const solution = [
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    [4, 5, 6, 7, 8, 9, 1, 2, 3],
    [7, 8, 9, 1, 2, 3, 4, 5, 6],
    [2, 3, 4, 5, 6, 7, 8, 9, 1],
    [5, 6, 7, 8, 9, 1, 2, 3, 4],
    [8, 9, 1, 2, 3, 4, 5, 6, 7],
    [3, 4, 5, 6, 7, 8, 9, 1, 2],
    [6, 7, 8, 9, 1, 2, 3, 4, 5],
    [9, 1, 2, 3, 4, 5, 6, 7, 8],
  ];
  const puzzle = solution.map((row) => [...row]);
  puzzle[0][0] = 0;
  const session = createSudokuSessionState({
    id: 'sudoku-engine-1',
    mode: 'solo',
    ownerAccountId: user.accountId,
    difficulty: 'easy',
    puzzle,
    solution,
  });

  assert.equal(SUDOKU_ENGINE.descriptor.key, 'sudoku');
  assert.equal(Object.prototype.hasOwnProperty.call(SUDOKU_ENGINE.viewFor(session, 'spectator'), 'solution'), false);

  SUDOKU_ENGINE.applyAction(session, 0, {
    type: 'set_cell',
    payload: { row: 0, col: 0, value: 1 },
  });
  SUDOKU_ENGINE.applyAction(session, 0, { type: 'submit' });

  assert.equal(session.status, 'cleared');
});

test('sokoban engine contract creates state and applies moves', () => {
  const session = SOKOBAN_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
  ], {
    id: 'sokoban-engine-1',
    mode: 'solo',
    difficulty: 'easy',
    map: {
      key: 'engine-test',
      walls: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 0, col: 2 },
        { row: 0, col: 3 },
        { row: 0, col: 4 },
        { row: 1, col: 0 },
        { row: 1, col: 4 },
        { row: 2, col: 0 },
        { row: 2, col: 1 },
        { row: 2, col: 2 },
        { row: 2, col: 3 },
        { row: 2, col: 4 },
      ],
      goals: [{ row: 1, col: 3 }],
      player: { row: 1, col: 1 },
      boxes: [{ row: 1, col: 2 }],
    },
  });

  assert.equal(SOKOBAN_ENGINE.descriptor.key, 'sokoban');
  assert.equal(session.state.solved, false);

  const result = SOKOBAN_ENGINE.applyAction(session, 0, {
    type: 'move',
    payload: { direction: 'right' },
  });

  assert.equal(result.state.state.solved, true);
  assert.equal(result.state.status, 'finished');
  assert.equal(result.state.finishReason, 'solo_clear');
});

test('othello engine contract creates state and applies legal moves', () => {
  const session = OTHELLO_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
    { seat: 1, kind: 'account', accountId: opponent.accountId },
  ], { id: 'othello-engine-1', mode: 'friend_match', aiDifficulty: 'medium' });

  assert.equal(OTHELLO_ENGINE.descriptor.key, 'othello');
  assert.equal(OTHELLO_ENGINE.descriptor.turnTimerSeconds, 20);
  assert.equal(session.board[3][3], 'white');
  assert.ok(othelloLegalMoves(session.board, 'black').some((move) => move.row === 2 && move.col === 3));

  const result = OTHELLO_ENGINE.applyAction(session, 0, {
    type: 'move',
    payload: { row: 2, col: 3 },
  });

  assert.equal(result.state.board[2][3], 'black');
  assert.equal(result.state.board[3][3], 'black');
  assert.equal(result.state.currentTurn, 'white');
});

test('splendor engine contract hides deck order and keeps turns untimed', () => {
  const session = SPLENDOR_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
    { seat: 1, kind: 'account', accountId: opponent.accountId },
  ], { id: 'splendor-engine-1', mode: 'friend_match', aiDifficulty: 'medium' });

  assert.equal(SPLENDOR_ENGINE.descriptor.key, 'splendor');
  assert.equal(SPLENDOR_ENGINE.descriptor.turnTimerSeconds, undefined);
  assert.equal(session.currentTurn, 'challenger');
  assert.equal(session.bank.white, 4);
  assert.equal(session.nobles.length, 3);

  const view = SPLENDOR_ENGINE.viewFor(session, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'decks'), false);
  assert.deepEqual(view.deckCounts, {
    '1': session.decks['1'].length,
    '2': session.decks['2'].length,
    '3': session.decks['3'].length,
  });
  assert.equal(view.mySide, 'challenger');

  const result = SPLENDOR_ENGINE.applyAction(session, 0, {
    type: 'take_tokens',
    payload: { tokens: { white: 1, blue: 1, green: 1 } },
  });

  assert.equal(result.state.playerStates.challenger.tokens.white, 1);
  assert.equal(result.state.currentTurn, 'opponent');
});

test('fortress engine contract creates state and applies setup actions', () => {
  const session = FORTRESS_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
    { seat: 1, kind: 'account', accountId: opponent.accountId },
  ], { id: 'fortress-engine-1', mode: 'friend_match', aiDifficulty: 'medium' });

  assert.equal(FORTRESS_ENGINE.descriptor.key, 'fortress');
  assert.equal(FORTRESS_ENGINE.descriptor.turnTimerSeconds, 20);
  assert.equal(session.status, 'selecting');
  assert.equal(session.currentTurn, 'challenger');

  FORTRESS_ENGINE.applyAction(session, 0, {
    type: 'select_tank',
    payload: { tankKey: 'balance' },
  });
  const selected = FORTRESS_ENGINE.applyAction(session, 1, {
    type: 'select_tank',
    payload: { tankKey: 'heavy' },
  });

  assert.equal(selected.state.status, 'playing');
  assert.equal(selected.state.tanks.challenger.tankKey, 'balance');
  assert.equal(selected.state.tanks.opponent.tankKey, 'heavy');
  assert.equal(selected.state.turnDeadlineAt, undefined);

  const beforeX = selected.state.tanks.challenger.x;
  const moved = FORTRESS_ENGINE.applyAction(session, 0, {
    type: 'move',
    payload: { distance: 12 },
  });

  assert.notEqual(moved.state.tanks.challenger.x, beforeX);
  assert.equal(FORTRESS_ENGINE.viewFor(session, 0).mySide, 'challenger');
});

test('crazy arcade engine contract creates realtime snapshots for dynamic seats', () => {
  const session = CRAZY_ARCADE_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
    { seat: 1, kind: 'account', accountId: opponent.accountId },
    { seat: 2, kind: 'account', accountId: 'player-3' },
  ], { id: 'crazy-engine-1', mode: 'friend_match', difficulty: 'medium', seed: 1234 });

  assert.equal(CRAZY_ARCADE_ENGINE.descriptor.key, 'crazy_arcade');
  assert.equal(CRAZY_ARCADE_ENGINE.descriptor.turnType, 'realtimeServer');
  assert.deepEqual(Object.keys(session.players), ['seat0', 'seat1', 'seat2']);
  assert.equal(session.snapshot.playerSide, 'seat0');
  assert.equal(Object.prototype.hasOwnProperty.call(session.snapshot.others, 'seat2'), true);

  const result = CRAZY_ARCADE_ENGINE.applyAction(session, 0, {
    type: 'input',
    payload: { direction: 'right', bomb: true },
  });

  assert.equal(result.state.inputs.seat0.direction, 'right');
  assert.equal(result.state.version, 1);

  const thirdPlayerView = CRAZY_ARCADE_ENGINE.viewFor(session, 2);
  assert.equal(thirdPlayerView.mySide, 'seat2');
  assert.equal(thirdPlayerView.snapshot.playerSide, 'seat2');
});

test('mighty engine contract hides hands and advances bidding to kitty', () => {
  const session = MIGHTY_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
    { seat: 1, kind: 'account', accountId: 'player-2' },
    { seat: 2, kind: 'account', accountId: 'player-3' },
    { seat: 3, kind: 'account', accountId: 'player-4' },
    { seat: 4, kind: 'account', accountId: 'player-5' },
  ], { id: 'mighty-engine-1', mode: 'friend_match', seed: 'mighty-test-seed' });

  assert.equal(MIGHTY_ENGINE.descriptor.key, 'mighty');
  assert.equal(MIGHTY_ENGINE.descriptor.minPlayers, 5);
  assert.equal(session.hands.length, 5);
  assert.equal(session.hands.every((hand) => hand.length === 10), true);
  assert.equal(session.kitty.length, 3);

  const seat0View = MIGHTY_ENGINE.viewFor(session, 0);
  const seat1View = MIGHTY_ENGINE.viewFor(session, 1);
  assert.equal(seat0View.myHand.length, 10);
  assert.equal(seat1View.myHand.length, 10);
  assert.notDeepEqual(seat0View.myHand, seat1View.myHand);
  assert.equal(Object.prototype.hasOwnProperty.call(seat0View, 'hands'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(seat0View, 'rngSeed'), false);

  MIGHTY_ENGINE.applyAction(session, 0, {
    type: 'bid',
    payload: { count: 13, trump: 'S' },
  });
  for (const seat of [1, 2, 3, 4]) {
    MIGHTY_ENGINE.applyAction(session, seat, {
      type: 'bid',
      payload: { pass: true },
    });
  }

  assert.equal(session.phase, 'kitty');
  assert.equal(session.declarerSeat, 0);
  assert.equal(session.currentSeat, 0);
  assert.equal(session.hands[0].length, 13);
  assert.equal(MIGHTY_ENGINE.viewFor(session, 0).kitty.length, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(MIGHTY_ENGINE.viewFor(session, 1), 'kitty'), false);
});

test('mighty ai difficulties change bidding confidence', () => {
  const session = MIGHTY_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
    { seat: 1, kind: 'ai', accountId: '__game_platform_local_ai__#1' },
    { seat: 2, kind: 'ai', accountId: '__game_platform_local_ai__#2' },
    { seat: 3, kind: 'ai', accountId: '__game_platform_local_ai__#3' },
    { seat: 4, kind: 'ai', accountId: '__game_platform_local_ai__#4' },
  ], { id: 'mighty-ai-bid', mode: 'local_ai', seed: 'mighty-ai-bid-seed', firstBidder: 0 });

  session.hands[0] = [
    { suit: 'S', rank: 14 },
    { suit: 'S', rank: 13 },
    { suit: 'S', rank: 12 },
    { suit: 'S', rank: 11 },
    { suit: 'S', rank: 10 },
    { suit: 'S', rank: 9 },
    { suit: 'D', rank: 14 },
    { suit: 'H', rank: 14 },
    { suit: 'C', rank: 14 },
    { suit: 'JOKER', rank: 0 },
  ];

  const easy = MIGHTY_ENGINE.aiAction(session, 0, 'easy');
  const hard = MIGHTY_ENGINE.aiAction(session, 0, 'hard');

  assert.equal(easy.type, 'bid');
  assert.equal(hard.type, 'bid');
  assert.equal(hard.payload.pass, false);
  assert.equal(hard.payload.count > (easy.payload.pass ? 0 : easy.payload.count), true);
});

test('mighty hard ai uses the cheapest winning card for a point trick', () => {
  const session = MIGHTY_ENGINE.createState([
    { seat: 0, kind: 'account', accountId: user.accountId },
    { seat: 1, kind: 'ai', accountId: '__game_platform_local_ai__#1' },
    { seat: 2, kind: 'ai', accountId: '__game_platform_local_ai__#2' },
    { seat: 3, kind: 'ai', accountId: '__game_platform_local_ai__#3' },
    { seat: 4, kind: 'ai', accountId: '__game_platform_local_ai__#4' },
  ], { id: 'mighty-ai-play', mode: 'local_ai', seed: 'mighty-ai-play-seed' });

  session.phase = 'playing';
  session.trump = 'S';
  session.bidCount = 13;
  session.declarerSeat = 0;
  session.friend = { type: 'none', revealed: true };
  session.currentSeat = 2;
  session.currentTurn = 'seat2';
  session.currentTrick = {
    leadSeat: 1,
    plays: [
      { seat: 1, card: { suit: 'H', rank: 10 } },
    ],
  };
  session.hands[2] = [
    { suit: 'H', rank: 11 },
    { suit: 'H', rank: 3 },
    { suit: 'S', rank: 2 },
    { suit: 'JOKER', rank: 0 },
  ];

  const action = MIGHTY_ENGINE.aiAction(session, 2, 'hard');

  assert.equal(action.type, 'play');
  assert.equal(action.payload.card, 'H11');
});

test('mighty ai scheduler keeps one visible action per 1.5 second delay', () => {
  const source = readFileSync(new URL('../src/games/games.service.ts', import.meta.url), 'utf8');
  assert.match(source, /const MIGHTY_AI_RESPONSE_DELAY_MS = 1_500;/);
  const scheduleStart = source.indexOf('private scheduleMightyAi');
  const scheduleEnd = source.indexOf('private startFortressTimedTurn', scheduleStart);
  const scheduleBody = source.slice(scheduleStart, scheduleEnd);

  assert.match(scheduleBody, /MIGHTY_ENGINE\.applyAction\(current, current\.currentSeat, action\);/);
  assert.match(scheduleBody, /setTimeout\(run, MIGHTY_AI_RESPONSE_DELAY_MS\)/);
  assert.match(scheduleBody, /scheduleRoomAiTimer\(session\.id, MIGHTY_AI_RESPONSE_DELAY_MS, run\)/);
  assert.doesNotMatch(scheduleBody, /while\s*\(/);
});

test('crazy arcade server snapshots keep dynamic seat winners', () => {
  const snapshot = createCrazyArcadeSnapshotForSides(['seat0', 'seat1', 'seat2'], 1234, 'medium');
  snapshot.gameFinished = true;
  snapshot.winnerSide = 'seat2';
  snapshot.playerWon = false;
  const session = {
    id: 'crazy-seat-winner',
    mode: 'friend_match',
    status: 'playing',
    difficulty: 'medium',
    players: {
      seat0: user.accountId,
      seat1: opponent.accountId,
      seat2: 'player-3',
    },
    inputs: {
      seat0: {},
      seat1: {},
      seat2: {},
    },
    snapshot,
    version: 0,
    updatedAt: new Date('2026-07-06T00:00:00.000Z').toISOString(),
  };

  const advanced = advanceCrazyArcadeServer(session, new Date('2026-07-06T00:00:01.000Z'));

  assert.equal(advanced.status, 'finished');
  assert.equal(advanced.winnerSide, 'seat2');
  assert.equal(advanced.winnerAccountId, 'player-3');
  assert.equal(advanced.snapshot.winnerSide, 'seat2');
});

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

test('gomoku move selection is replaceable, private, and cleared by confirmation', async () => {
  const realtime = new FakeRealtime();
  const service = new GamesService(new FakeDb(), realtime);
  try {
    const session = await service.createGomokuSession(
      user,
      opponent.accountId,
      undefined,
      'medium',
    );

    const firstSelection = await service.applyGameAction(
      'gomoku',
      session.id,
      user,
      {
        type: 'select_move',
        payload: { row: 7, col: 7 },
      },
    );
    assert.equal(firstSelection.board[7][7], null);
    assert.equal(firstSelection.moves.length, 0);
    assert.deepEqual(
      {
        row: firstSelection.pendingMove.row,
        col: firstSelection.pendingMove.col,
        color: firstSelection.pendingMove.color,
        accountId: firstSelection.pendingMove.accountId,
      },
      { row: 7, col: 7, color: 'black', accountId: user.accountId },
    );
    const selectionEvent = realtime.events.find(
      (event) => event.event === 'gomoku.selection.changed',
    );
    assert.deepEqual(selectionEvent.payload, {
      id: session.id,
      rev: firstSelection.rev,
    });
    assert.equal('row' in selectionEvent.payload, false);
    assert.equal('col' in selectionEvent.payload, false);

    const opponentView = await service.getGomokuSession(
      session.id,
      opponent,
    );
    assert.equal(opponentView.pendingMove, undefined);

    const replaced = await service.applyGameAction(
      'gomoku',
      session.id,
      user,
      {
        type: 'select_move',
        payload: { row: 6, col: 8 },
      },
    );
    assert.equal(replaced.pendingMove.row, 6);
    assert.equal(replaced.pendingMove.col, 8);
    assert.equal(replaced.board[6][8], null);

    const moved = await service.playGomokuMove(
      session.id,
      user,
      6,
      8,
    );
    assert.equal(moved.board[6][8], 'black');
    assert.equal(moved.moves.length, 1);
    assert.equal(moved.pendingMove, undefined);
  } finally {
    service.onModuleDestroy();
  }
});

test('gomoku timer confirms the current selection before online random fallback', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  try {
    const session = await service.createGomokuSession(
      user,
      opponent.accountId,
      undefined,
      'medium',
    );
    await service.selectGomokuMove(session.id, user, 4, 9);

    const row = db.rows.get(session.id);
    row.state_json.turnDeadlineAt = new Date(Date.now() - 100).toISOString();
    realtime.online = false;
    await service.handleTurnTimer(session.id, 'gomoku');

    const timedOut = await service.getGomokuSession(session.id, user);
    assert.equal(timedOut.board[4][9], 'black');
    assert.equal(timedOut.moves.length, 1);
    assert.equal(timedOut.moves[0].source, 'timeout');
    assert.equal(timedOut.pendingMove, undefined);
    assert.equal(timedOut.networkGraceDeadlineAt, undefined);
  } finally {
    service.onModuleDestroy();
  }
});

test('gomoku timer retries with the latest selection after a revision race', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  let releaseOnlineCheck;
  realtime.isAccountOnline = () =>
    new Promise((resolve) => {
      releaseOnlineCheck = () => resolve(true);
    });
  const service = new GamesService(db, realtime);
  try {
    const session = await service.createGomokuSession(
      user,
      opponent.accountId,
      undefined,
      'medium',
    );
    const row = db.rows.get(session.id);
    row.state_json.turnDeadlineAt = new Date(Date.now() - 100).toISOString();

    const timer = service.handleTurnTimer(session.id, 'gomoku');
    while (!releaseOnlineCheck) {
      await wait(1);
    }
    await service.selectGomokuMove(session.id, user, 10, 3);
    releaseOnlineCheck();
    await timer;

    const timedOut = await service.getGomokuSession(session.id, user);
    assert.equal(timedOut.board[10][3], 'black');
    assert.equal(timedOut.moves.length, 1);
    assert.equal(timedOut.moves[0].source, 'timeout');
    assert.equal(timedOut.pendingMove, undefined);
  } finally {
    service.onModuleDestroy();
  }
});

test('generic game action route dispatches through handlers and migrated engines', async () => {
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

  const originalSudokuApplyAction = SUDOKU_ENGINE.applyAction;
  let sudokuApplyCalls = 0;
  SUDOKU_ENGINE.applyAction = (state, seat, action) => {
    sudokuApplyCalls += 1;
    assert.equal(seat, 0);
    return originalSudokuApplyAction(state, seat, action);
  };
  try {
    const sudoku = await service.createSudokuSession(user, 'easy');
    const fullSudoku = db.rows.get(sudoku.id).state_json;
    const emptyCell = firstEmptySudokuCell(fullSudoku.puzzle);
    const updatedSudoku = await service.applyGameAction('sudoku', sudoku.id, user, {
      type: 'set_cell',
      payload: { row: emptyCell.row, col: emptyCell.col, value: 1 },
      clientMoveId: 'generic-sudoku-cell-1',
    });
    assert.equal(updatedSudoku.solution, undefined);
    assert.equal(updatedSudoku.board[emptyCell.row][emptyCell.col], 1);

    const submittedSudoku = await service.applyGameAction('sudoku', sudoku.id, user, {
      type: 'submit',
      payload: { board: fullSudoku.solution },
      clientMoveId: 'generic-sudoku-submit-1',
    });
    assert.equal(submittedSudoku.solved, true);
    assert.equal(submittedSudoku.session.solution, undefined);
    assert.equal(sudokuApplyCalls, 2);
  } finally {
    SUDOKU_ENGINE.applyAction = originalSudokuApplyAction;
  }

  const originalGomokuApplyAction = GOMOKU_ENGINE.applyAction;
  let gomokuApplyCalls = 0;
  GOMOKU_ENGINE.applyAction = (state, seat, action) => {
    gomokuApplyCalls += 1;
    assert.equal(seat, 0);
    return originalGomokuApplyAction(state, seat, action);
  };
  try {
    const gomoku = await service.createGomokuSession(user, undefined, undefined, 'medium');
    const moved = await service.applyGameAction('gomoku', gomoku.id, user, {
      type: 'move',
      payload: { row: 7, col: 7 },
      clientMoveId: 'generic-move-1',
    });
    assert.equal(moved.moves.length, 1);
    assert.equal(moved.board[7][7], 'black');
    assert.equal(gomokuApplyCalls, 1);

    const duplicated = await service.applyGameAction('gomoku', gomoku.id, user, {
      type: 'move',
      payload: { row: 8, col: 8 },
      clientMoveId: 'generic-move-1',
    });
    assert.equal(duplicated.moves.length, 1);
    assert.equal(duplicated.board[8][8], null);
    assert.equal(gomokuApplyCalls, 1);
  } finally {
    GOMOKU_ENGINE.applyAction = originalGomokuApplyAction;
  }

  const originalOthelloApplyAction = OTHELLO_ENGINE.applyAction;
  let othelloApplyCalls = 0;
  OTHELLO_ENGINE.applyAction = (state, seat, action) => {
    othelloApplyCalls += 1;
    assert.equal(seat, 0);
    return originalOthelloApplyAction(state, seat, action);
  };
  try {
    const othello = await service.createOthelloSession(user, undefined, undefined, 'medium');
    const othelloMoved = await service.applyGameAction('othello', othello.id, user, {
      type: 'move',
      payload: { row: 2, col: 3 },
      clientMoveId: 'generic-othello-1',
    });
    assert.equal(othelloMoved.moves.length, 1);
    assert.equal(othelloMoved.board[2][3], 'black');
    assert.equal(othelloApplyCalls, 1);
  } finally {
    OTHELLO_ENGINE.applyAction = originalOthelloApplyAction;
  }

  const originalSokobanApplyAction = SOKOBAN_ENGINE.applyAction;
  let sokobanApplyCalls = 0;
  SOKOBAN_ENGINE.applyAction = (state, seat, action) => {
    sokobanApplyCalls += 1;
    assert.equal(seat, 0);
    return originalSokobanApplyAction(state, seat, action);
  };
  try {
    const sokoban = await service.createSokobanSession(user, 'easy');
    const sokobanMoved = await service.applyGameAction('sokoban', sokoban.id, user, {
      type: 'move',
      payload: { direction: 'up' },
      clientMoveId: 'generic-sokoban-1',
    });
    assert.equal(sokobanMoved.state.moves, 1);
    assert.equal(sokobanMoved.state.player.row, 3);
    assert.equal(sokobanApplyCalls, 1);
  } finally {
    SOKOBAN_ENGINE.applyAction = originalSokobanApplyAction;
  }

  const originalSplendorApplyAction = SPLENDOR_ENGINE.applyAction;
  let splendorApplyCalls = 0;
  SPLENDOR_ENGINE.applyAction = (state, seat, action) => {
    splendorApplyCalls += 1;
    assert.equal(seat, 0);
    return originalSplendorApplyAction(state, seat, action);
  };
  try {
    const splendor = await service.createSplendorSession(user, undefined, undefined, 'medium');
    const splendorMoved = await service.applyGameAction('splendor', splendor.id, user, {
      type: 'take_tokens',
      payload: { tokens: { white: 1, blue: 1, green: 1 } },
      clientMoveId: 'generic-splendor-1',
    });
    assert.equal(splendorMoved.playerStates.challenger.tokens.white, 1);
    assert.equal(splendorMoved.currentTurn, 'opponent');
    assert.equal(splendorApplyCalls, 1);
  } finally {
    SPLENDOR_ENGINE.applyAction = originalSplendorApplyAction;
  }

  const originalAlkkagiApplyAction = ALKKAGI_ENGINE.applyAction;
  let alkkagiApplyCalls = 0;
  ALKKAGI_ENGINE.applyAction = (state, seat, action) => {
    alkkagiApplyCalls += 1;
    assert.equal(seat, 0);
    return originalAlkkagiApplyAction(state, seat, action);
  };
  try {
    const alkkagi = await service.createAlkkagiSession(user, undefined, undefined, 'medium');
    const redPiece = alkkagi.pieces.find((piece) => piece.active && piece.team === 'red');
    const alkkagiMoved = await service.applyGameAction('alkkagi', alkkagi.id, user, {
      type: 'shoot',
      payload: { pieceId: redPiece.id, vx: 6, vy: -4 },
      clientMoveId: 'generic-alkkagi-1',
    });
    assert.equal(alkkagiMoved.session.shots.length, 1);
    assert.ok(alkkagiMoved.animation.frames.length > 1);
    assert.equal(alkkagiApplyCalls, 1);
  } finally {
    ALKKAGI_ENGINE.applyAction = originalAlkkagiApplyAction;
  }

  const originalFortressApplyAction = FORTRESS_ENGINE.applyAction;
  let fortressApplyCalls = 0;
  FORTRESS_ENGINE.applyAction = (state, seat, action) => {
    fortressApplyCalls += 1;
    assert.equal(seat, 0);
    return originalFortressApplyAction(state, seat, action);
  };
  try {
    const fortress = await service.createFortressSession(user, undefined, undefined, 'medium');
    const fortressSelected = await service.applyGameAction('fortress', fortress.id, user, {
      type: 'select_tank',
      payload: { tankKey: 'balance' },
    });
    assert.equal(fortressSelected.status, 'playing');
    const movementBefore = fortressSelected.movementRemaining.challenger;
    const fortressMoved = await service.applyGameAction('fortress', fortress.id, user, {
      type: 'move',
      payload: { distance: 8 },
      clientMoveId: 'generic-fortress-move-1',
    });
    assert.ok(fortressMoved.movementRemaining.challenger < movementBefore);
    const fortressShot = await service.applyGameAction('fortress', fortress.id, user, {
      type: 'shoot',
      payload: { angle: 45, power: 70 },
      clientMoveId: 'generic-fortress-shot-1',
    });
    assert.ok(fortressShot.animation.projectile.length > 1);
    assert.equal(fortressShot.session.shots.length, 1);
    assert.equal(fortressApplyCalls, 3);
  } finally {
    FORTRESS_ENGINE.applyAction = originalFortressApplyAction;
  }

  const crazy = await service.createCrazyArcadeSession(user, undefined, undefined, 'medium');
  const crazyMoved = await service.applyGameAction('crazy_arcade', crazy.id, user, {
    type: 'input',
    payload: { direction: 'right', bomb: false, carry: false },
    clientMoveId: 'generic-crazy-input-1',
  });
  assert.equal(crazyMoved.inputs.challenger.direction, 'right');
  const crazyMovedAgain = await service.applyGameAction('crazy_arcade', crazy.id, user, {
    type: 'input',
    payload: { direction: 'left', bomb: false, carry: false },
    clientMoveId: 'generic-crazy-input-1',
  });
  assert.equal(crazyMovedAgain.inputs.challenger.direction, 'right');
  assert.equal(crazyMovedAgain.version, crazyMoved.version);

  service.onModuleDestroy();
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

test('othello matched sessions expose a timed turn clock', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  const session = await service.createOthelloSession(user, opponent.accountId);
  assert.equal(session.mode, 'friend_match');
  assert.ok(session.turnStartedAt);
  assert.ok(session.turnDeadlineAt);
  assert.equal(
    Date.parse(session.turnDeadlineAt) - Date.parse(session.turnStartedAt),
    20_000,
  );

  const moved = await service.playOthelloMove(session.id, user, 2, 3);
  assert.equal(moved.currentTurn, 'white');
  assert.equal(moved.moves[0].source, 'manual');
  assert.ok(moved.turnStartedAt);
  assert.ok(moved.turnDeadlineAt);
  assert.equal(
    Date.parse(moved.turnDeadlineAt) - Date.parse(moved.turnStartedAt),
    20_000,
  );
  service.onModuleDestroy();
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

test('splendor friend match forfeit replaces the leaver with a medium AI until the last human leaves', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  const session = await service.createSplendorSession(user, opponent.accountId, 'friend_match', 'medium');

  await service.forfeitSplendor(session.id, opponent);
  const afterOpponentLeaves = db.rows.get(session.id).state_json;
  assert.equal(afterOpponentLeaves.status, 'playing');
  assert.ok(afterOpponentLeaves.players.opponent.startsWith('__game_platform_local_ai__#splendor-forfeit-'));
  const aiSeat = db.sessionPlayers.find((row) => row.session_id === session.id && row.seat === 1);
  assert.equal(aiSeat.kind, 'ai');
  assert.equal(aiSeat.ai_difficulty, 'medium');
  assert.equal((await service.listActiveSessions(opponent)).sessions.length, 0);
  assert.equal((await service.listActiveSessions(user)).sessions.length, 1);

  await service.forfeitSplendor(session.id, user);
  const afterLastHumanLeaves = db.rows.get(session.id).state_json;
  assert.equal(afterLastHumanLeaves.status, 'finished');
  assert.equal(afterLastHumanLeaves.finishReason, 'forfeit');
  assert.equal((await service.listActiveSessions(user)).sessions.length, 0);
});

test('fortress local sessions use a long world and answer player shots', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());

  // 지형/탱크 배치가 랜덤이라 특정 월드에서는 고정 각도 샷이 즉시 소멸할 수 있다.
  // 궤적 애니메이션 검증은 최대 3개의 월드에서 시도한다.
  let session;
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    session = await service.createFortressSession(user, undefined, undefined, 'hard');
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

    result = await service.shootFortress(session.id, user, 45, 82);
    if (result.animation.projectile.length > 1) {
      break;
    }
  }
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

test('server save slots cannot continue matched games until the original match finishes', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  const session = await service.createGomokuSession(user, opponent.accountId, 'friend_match', 'medium');
  await service.playGomokuMove(session.id, user, 7, 7, 'save-move-1');

  const saved = await service.saveGameSessionToSlot('gomoku', session.id, user, {
    slot: 1,
    label: 'after opener',
  });
  assert.equal(saved.save.gameKey, 'gomoku');
  assert.equal(saved.save.slot, 1);
  assert.equal(saved.save.label, 'after opener');
  assert.equal(saved.save.preview.moves.length, 1);

  await assert.rejects(
    () => service.saveGameSessionToSlot('gomoku', session.id, user, { slot: 4 }),
    (error) => error.getStatus?.() === 400,
  );

  await assert.rejects(
    () => service.continueGameSave(saved.save.id, opponent, { difficulty: 'medium' }),
    (error) => error.getStatus?.() === 403,
  );
  await assert.rejects(
    () => service.deleteGameSave(saved.save.id, opponent),
    (error) => error.getStatus?.() === 403,
  );

  const listed = await service.listGameSaves(user, 'gomoku');
  assert.equal(listed.saves.length, 1);
  assert.equal(listed.saves[0].sourceSessionId, session.id);
  assert.equal(listed.saves[0].sourceSessionStatus, 'playing');
  assert.equal(listed.saves[0].continueAvailable, false);

  await assert.rejects(
    () => service.continueGameSave(listed.saves[0].id, user, { difficulty: 'hard' }),
    (error) => error.getStatus?.() === 400,
  );

  db.rows.get(session.id).status = 'finished';
  db.rows.get(session.id).state_json.status = 'finished';
  const listedAfterFinish = await service.listGameSaves(user, 'gomoku');
  assert.equal(listedAfterFinish.saves[0].sourceSessionStatus, 'finished');
  assert.equal(listedAfterFinish.saves[0].continueAvailable, true);
  const continued = await service.continueGameSave(listed.saves[0].id, user, {
    difficulty: 'hard',
  });
  assert.equal(continued.gameKey, 'gomoku');
  assert.notEqual(continued.sessionId, session.id);
  assert.equal(continued.session.mode, 'local_ai');
  assert.equal(continued.session.aiDifficulty, 'hard');
  assert.equal(continued.session.players.black, user.accountId);
  assert.equal(continued.session.players.white, '__game_platform_local_ai__#1');
  assert.equal(continued.session.board[7][7], 'black');
  assert.equal(continued.sourceSave.id, saved.save.id);
  assert.equal(continued.sourceSave.slot, 1);

  const original = await service.getGomokuSession(session.id, user);
  assert.equal(original.mode, 'friend_match');
  assert.equal(original.players.white, opponent.accountId);

  const crazySession = await service.createCrazyArcadeSession(user, opponent.accountId, 'friend_match', 'medium');
  await service.updateCrazyArcadeInput(crazySession.id, user, { direction: 'right' }, 'crazy-save-input-1');
  const crazySaved = await service.saveGameSessionToSlot('crazy_arcade', crazySession.id, user, {
    slot: 2,
    label: 'bubble race',
  });
  assert.equal(crazySaved.save.gameKey, 'crazy_arcade');
  assert.equal(crazySaved.save.continueAvailable, false);
  assert.equal(crazySaved.save.preview.mySide, 'challenger');
  await assert.rejects(
    () => service.continueGameSave(crazySaved.save.id, user, { difficulty: 'hard' }),
    (error) => error.getStatus?.() === 400,
  );
  db.rows.get(crazySession.id).status = 'finished';
  db.rows.get(crazySession.id).state_json.status = 'finished';
  const crazyContinued = await service.continueGameSave(crazySaved.save.id, user, {
    difficulty: 'hard',
  });
  assert.equal(crazyContinued.gameKey, 'crazy_arcade');
  assert.equal(crazyContinued.session.mode, 'local_ai');
  assert.equal(crazyContinued.session.aiDifficulty, 'hard');
  assert.equal(crazyContinued.session.players.challenger, user.accountId);
  assert.equal(crazyContinued.session.players.opponent, '__game_platform_local_ai__#1');
  assert.deepEqual(Object.keys(crazyContinued.session.inputs).sort(), ['challenger', 'opponent']);
  assert.equal(crazyContinued.sourceSave.slot, 2);
  service.onModuleDestroy();
});

test('sudoku and sokoban saves continue as solo puzzles after the source match finishes', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  const sudoku = await service.createSudokuSession(user, 'medium', opponent.accountId);
  await service.updateSudokuCell(sudoku.id, user, 0, 0, 1).catch(() => undefined);
  const sudokuSave = await service.saveGameSessionToSlot('sudoku', sudoku.id, user, { slot: 1 });
  await assert.rejects(
    () => service.continueGameSave(sudokuSave.save.id, user, { difficulty: 'hard' }),
    (error) => error.getStatus?.() === 400,
  );
  db.rows.get(sudoku.id).status = 'finished';
  db.rows.get(sudoku.id).state_json.status = 'finished';
  const continuedSudoku = await service.continueGameSave(sudokuSave.save.id, user, { difficulty: 'hard' });
  assert.equal(continuedSudoku.gameKey, 'sudoku');
  assert.equal(continuedSudoku.session.mode, 'solo');
  assert.equal(continuedSudoku.session.players, undefined);
  assert.equal(continuedSudoku.session.solution, undefined);
  assert.equal(continuedSudoku.sourceSave.slot, 1);

  const sokoban = await service.createSokobanSession(user, 'easy', opponent.accountId);
  const sokobanSave = await service.saveGameSessionToSlot('sokoban', sokoban.id, user, { slot: 1 });
  db.rows.get(sokoban.id).status = 'finished';
  db.rows.get(sokoban.id).state_json.status = 'finished';
  const continuedSokoban = await service.continueGameSave(sokobanSave.save.id, user, { difficulty: 'hard' });
  assert.equal(continuedSokoban.gameKey, 'sokoban');
  assert.equal(continuedSokoban.session.mode, 'solo');
  assert.equal(continuedSokoban.session.players, undefined);
  assert.equal(continuedSokoban.session.mySide, undefined);
  service.onModuleDestroy();
});

test('superadmin matched sudoku actions prefer their exact player seat', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  try {
    const superOpponent = {
      ...opponent,
      permission: 'superadmin',
    };
    const session = await service.createSudokuSession(user, 'medium', superOpponent.accountId);
    let target = null;
    for (let row = 0; row < session.puzzle.length && !target; row += 1) {
      for (let col = 0; col < session.puzzle[row].length; col += 1) {
        if (session.puzzle[row][col] === 0) {
          target = { row, col };
          break;
        }
      }
    }
    assert.ok(target);

    const updated = await service.updateSudokuCell(
      session.id,
      superOpponent,
      target.row,
      target.col,
      7,
    );
    const persisted = db.rows.get(session.id).state_json;

    assert.equal(updated.mySide, 'opponent');
    assert.equal(updated.board[target.row][target.col], 7);
    assert.equal(persisted.boards.opponent[target.row][target.col], 7);
    assert.equal(persisted.boards.challenger[target.row][target.col], 0);
  } finally {
    service.onModuleDestroy();
  }
});

test('sudoku save previews keep the solution hidden', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const session = await service.createSudokuSession(user, 'medium', opponent.accountId);

  const saved = await service.saveGameSessionToSlot('sudoku', session.id, user, {
    slot: 1,
  });

  assert.equal(saved.save.gameKey, 'sudoku');
  assert.equal(saved.save.preview.solution, undefined);
  assert.ok(saved.save.preview.progress.challenger);
  service.onModuleDestroy();
});

test('save previews use engine views and hide splendor deck order', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  const session = await service.createSplendorSession(user, opponent.accountId, 'friend_match', 'medium');

  const saved = await service.saveGameSessionToSlot('splendor', session.id, user, {
    slot: 1,
  });

  assert.equal(saved.save.preview.decks, undefined);
  assert.equal(saved.save.preview.mySide, 'challenger');
  assert.ok(saved.save.preview.deckCounts['1'] > 0);
  service.onModuleDestroy();
});

test('continued save sessions use engine views and hide splendor deck order', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  const session = await service.createSplendorSession(user, opponent.accountId, 'friend_match', 'medium');
  const saved = await service.saveGameSessionToSlot('splendor', session.id, user, { slot: 1 });
  db.rows.get(session.id).status = 'finished';
  db.rows.get(session.id).state_json.status = 'finished';

  const continued = await service.continueGameSave(saved.save.id, user, { difficulty: 'medium' });

  assert.equal(continued.session.decks, undefined);
  assert.equal(continued.session.mySide, 'challenger');
  assert.ok(continued.session.deckCounts['1'] > 0);
  service.onModuleDestroy();
});

test('custom emote events include the sender side', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  const session = await service.createSplendorSession(user, opponent.accountId, 'friend_match', 'medium');
  await service.saveEmote(opponent, 1, {
    gridSize: 8,
    cells: Array.from({ length: 64 }, (_, index) => (index === 0 ? 'red' : null)),
  });

  const event = await service.sendSplendorEmote(session.id, opponent, 1);

  assert.equal(event.senderAccountId, opponent.accountId);
  assert.equal(event.senderSide, 'opponent');
  assert.equal(realtime.events.at(-1).event, 'game.emote.sent');
  assert.equal(realtime.events.at(-1).payload.senderSide, 'opponent');
  service.onModuleDestroy();
});

test('crazy arcade matched sessions advance from server inputs, not host snapshots', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  const session = await service.createCrazyArcadeSession(user, opponent.accountId, 'friend_match');
  assert.ok(session.snapshot.tiles);

  const originalApplyAction = CRAZY_ARCADE_ENGINE.applyAction;
  let applyCalls = 0;
  CRAZY_ARCADE_ENGINE.applyAction = (state, seat, action) => {
    applyCalls += 1;
    assert.equal(seat, 0);
    assert.equal(action.type, 'input');
    return originalApplyAction(state, seat, action);
  };
  try {
    const moved = await service.updateCrazyArcadeInput(session.id, user, { direction: 'right' });
    assert.equal(moved.status, 'playing');
    assert.equal(realtime.events.at(-1).event, 'crazy_arcade.state.synced');
    assert.ok(moved.snapshot.player.center.dx > 1.5);
    assert.equal(applyCalls, 1);

    const afterHostSync = await service.syncCrazyArcadeState(session.id, user, {
      snapshot: {
        player: { center: { dx: 99, dy: 99 } },
      },
      version: 999,
    });
    assert.notEqual(afterHostSync.snapshot.player.center.dx, 99);

    const opponentView = await service.getCrazyArcadeSession(session.id, opponent);
    assert.equal(opponentView.mySide, 'opponent');
    assert.ok(opponentView.snapshot.player.center.dx > 10);
  } finally {
    CRAZY_ARCADE_ENGINE.applyAction = originalApplyAction;
    service.onModuleDestroy();
  }
});

test('crazy arcade socket input queue advances server-authoritative snapshots idempotently', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  const session = await service.createCrazyArcadeSession(user, opponent.accountId, 'friend_match');
  const startX = session.snapshot.player.center.dx;

  const [first, duplicate] = await Promise.all([
    service.enqueueCrazyArcadeSocketInput(session.id, user, { direction: 'right' }, 'socket-move-1'),
    service.enqueueCrazyArcadeSocketInput(session.id, user, { direction: 'left' }, 'socket-move-1'),
  ]);

  assert.equal(first.mySide, 'challenger');
  assert.equal(duplicate.mySide, 'challenger');
  assert.ok(first.snapshot.player.center.dx > startX);
  assert.equal(duplicate.rev, first.rev);
  assert.equal(duplicate.snapshot.player.center.dx, first.snapshot.player.center.dx);
  assert.ok(realtime.events.some((event) => event.event === 'crazy_arcade.state.synced'));
  service.onModuleDestroy();
});

test('crazy arcade matched sessions tick on the server until paused or finished', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  const session = await service.createCrazyArcadeSession(user, opponent.accountId, 'friend_match');
  realtime.events = [];

  await wait(180);
  assert.ok(realtime.events.some((event) => event.event === 'crazy_arcade.state.synced'));

  await service.pauseMatchedGame('crazy_arcade', session.id, user);
  const pausedEventCount = realtime.events.length;
  await wait(220);
  assert.equal(realtime.events.length, pausedEventCount);

  db.rows.get(session.id).state_json.pause.resumableAt = new Date(Date.now() - 1).toISOString();
  await service.resumeMatchedGame('crazy_arcade', session.id, user);
  const resumedEventCount = realtime.events.length;
  await wait(180);
  assert.ok(realtime.events.length > resumedEventCount);

  await service.forfeitCrazyArcade(session.id, user);
  const finishedEventCount = realtime.events.length;
  await wait(220);
  assert.equal(realtime.events.length, finishedEventCount);
  service.onModuleDestroy();
});

test('crazy arcade matched sessions enter disconnect grace and allow claim-win', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  realtime.online = false;
  const service = new GamesService(db, realtime);
  const session = await service.createCrazyArcadeSession(user, opponent.accountId, 'friend_match');
  realtime.events = [];

  await wait(180);
  const row = db.rows.get(session.id);
  assert.equal(row.state_json.networkGraceAccountId, user.accountId);
  assert.ok(row.state_json.networkGraceDeadlineAt);
  assert.ok(realtime.events.some((event) => event.event === 'game.turn.network_waiting'));

  row.state_json.networkGraceDeadlineAt = new Date(Date.now() - 1).toISOString();
  await wait(180);
  assert.ok(row.state_json.opponentLeftAt);
  assert.ok(realtime.events.some((event) => event.event === 'game.opponent_left'));

  const finished = await service.claimDisconnectedWin('crazy_arcade', session.id, opponent);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.finishReason, 'disconnect');
  assert.equal(finished.winnerSide, 'opponent');
  assert.equal(finished.winnerAccountId, opponent.accountId);
  service.onModuleDestroy();
});

test('local AI result upload stores valid entries idempotently and skips invalid entries', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());

  const uploaded = await service.uploadLocalAiResults(user, {
    results: [
      {
        gameKey: 'gomoku',
        sessionId: 'local-session-1',
        result: 'win',
        difficulty: 'hard',
        reason: 'finished',
        recordedAt: '2026-07-06T01:02:03.000Z',
      },
      {
        gameKey: 'unknown',
        sessionId: 'bad-session',
        result: 'win',
      },
    ],
  });
  assert.equal(uploaded.accepted, 1);
  assert.equal(uploaded.skipped, 1);
  assert.deepEqual(uploaded.acceptedKeys, ['gomoku|local-session-1']);
  assert.equal(db.localAiResults.length, 1);
  assert.equal(db.localAiResults[0].account_id, user.accountId);
  assert.equal(db.localAiResults[0].difficulty, 'hard');

  const uploadedAgain = await service.uploadLocalAiResults(user, {
    results: [
      {
        gameKey: 'gomoku',
        sessionId: 'local-session-1',
        result: 'loss',
        difficulty: 'easy',
        reason: 'rematch',
        recordedAt: '2026-07-06T02:03:04.000Z',
      },
    ],
  });
  assert.equal(uploadedAgain.accepted, 1);
  assert.equal(db.localAiResults.length, 1);
  assert.equal(db.localAiResults[0].result, 'loss');
  assert.equal(db.localAiResults[0].reason, 'rematch');
  service.onModuleDestroy();
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstEmptySudokuCell(puzzle) {
  for (let row = 0; row < puzzle.length; row += 1) {
    for (let col = 0; col < puzzle[row].length; col += 1) {
      if (puzzle[row][col] === 0) {
        return { row, col };
      }
    }
  }
  throw new Error('sudoku puzzle has no empty cell');
}

function sudokuFilledEmptyCells(session, side) {
  let filled = 0;
  const board = session.boards[side];
  for (let row = 0; row < session.puzzle.length; row += 1) {
    for (let col = 0; col < session.puzzle[row].length; col += 1) {
      if (session.puzzle[row][col] === 0 && board[row][col] !== 0) {
        filled += 1;
      }
    }
  }
  return filled;
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

test('active session list is driven by session participants, not legacy owner columns', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  const session = await service.createGomokuSession(user, undefined, undefined, 'medium');
  const participant = {
    accountId: 'room-member',
    subject: 'room-member',
    serviceKey: 'game-platform',
    permission: 'player',
    claims: {},
  };
  db.sessionPlayers.push({
    session_id: session.id,
    seat: 2,
    account_id: participant.accountId,
    kind: 'account',
    ai_difficulty: null,
    status: 'active',
    result: null,
    joined_at: new Date(),
    left_at: null,
  });

  const listed = await service.listActiveSessions(participant);
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].sessionId, session.id);
  assert.deepEqual(listed.sessions[0].opponentAccountIds.sort(), [user.accountId].sort());
});

test('rooms start a two-player shortcut session and backfill participants', async () => {
  const db = new FakeDb();
  db.socialAccounts.set(user.accountId, {
    login_id: 'lafamila',
    name: 'Teddy',
    email: 'teddy@example.test',
    status: 'active',
    permission_key: 'player',
  });
  db.friendRequests.push({
    id: 'friend-1',
    requester_account_id: user.accountId,
    recipient_account_id: opponent.accountId,
    status: 'accepted',
  });
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  try {
    const created = await service.createRoom(user, { gameKey: 'gomoku', maxPlayers: 2 });
    const roomId = created.room.id;
    const roomCode = created.room.roomCode;
    assert.equal(created.room.members[0].account.loginId, 'lafamila');
    assert.equal(created.room.members[0].ready, false);

    await service.inviteToRoom(roomId, user, { accountId: opponent.accountId });
    assert.equal(realtime.events.some((event) => event.event === 'room.invited'), true);
    await service.joinRoom(opponent, { roomCode });
    await service.setRoomReady(roomId, user, { ready: true });
    await service.setRoomReady(roomId, opponent, { ready: true });
    const started = await service.startRoom(roomId, user);

    assert.equal(started.room.status, 'started');
    assert.ok(started.sessionId);
    const players = db.sessionPlayers.filter((row) => row.session_id === started.sessionId);
    assert.deepEqual(players.map((row) => row.account_id).sort(), [opponent.accountId, user.accountId].sort());
  } finally {
    service.onModuleDestroy();
  }
});

test('room invites stay hidden until accepted and can be reissued after expiry', async () => {
  const db = new FakeDb();
  db.friendRequests.push({
    id: 'friend-1',
    requester_account_id: user.accountId,
    recipient_account_id: opponent.accountId,
    status: 'accepted',
  });
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  try {
    const created = await service.createRoom(user, { gameKey: 'gomoku', maxPlayers: 2 });
    const invited = await service.inviteToRoom(created.room.id, user, { accountId: opponent.accountId });

    assert.equal(invited.room.joinedCount, 1);
    assert.equal(invited.room.members.length, 1);
    assert.equal(invited.room.members.some((member) => member.accountId === opponent.accountId), false);

    const inviteEvent = realtime.events.find((event) => event.event === 'room.invited');
    assert.ok(inviteEvent);
    assert.equal(inviteEvent.payload.joinedCount, 1);
    assert.equal(inviteEvent.payload.members.length, 1);
    assert.equal(typeof inviteEvent.payload.viewerInvitationExpiresAt, 'string');

    await assert.rejects(
      () => service.inviteToRoom(created.room.id, user, { accountId: opponent.accountId }),
      /room invite is pending/,
    );

    const pendingInvite = db.roomMembers.find(
      (member) => member.room_id === created.room.id && member.account_id === opponent.accountId,
    );
    pendingInvite.updated_at = new Date(Date.now() - 11_000);
    const reinvited = await service.inviteToRoom(created.room.id, user, { accountId: opponent.accountId });

    assert.equal(reinvited.room.joinedCount, 1);
    assert.equal(
      db.roomMembers.filter((member) => member.room_id === created.room.id && member.account_id === opponent.accountId)
        .length,
      1,
    );
  } finally {
    service.onModuleDestroy();
  }
});

test('room invitee sees room fill and cannot accept after capacity is reached', async () => {
  const db = new FakeDb();
  db.friendRequests.push({
    id: 'friend-1',
    requester_account_id: user.accountId,
    recipient_account_id: opponent.accountId,
    status: 'accepted',
  });
  const extra = { ...user, accountId: 'extra-player', subject: 'extra-player' };
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  try {
    const created = await service.createRoom(user, { gameKey: 'gomoku', maxPlayers: 2 });
    await service.inviteToRoom(created.room.id, user, { accountId: opponent.accountId });
    await service.joinRoom(extra, { roomCode: created.room.roomCode });

    const joinedEvent = [...realtime.events]
      .reverse()
      .find((event) => event.event === 'room.member_joined' && event.accounts.includes(opponent.accountId));
    assert.ok(joinedEvent);
    assert.equal(joinedEvent.payload.joinedCount, 2);
    assert.equal(joinedEvent.payload.members.length, 2);

    await assert.rejects(() => service.acceptRoomInvite(created.room.id, opponent), /room is full/);
    assert.equal(
      db.roomMembers.some((member) => member.room_id === created.room.id && member.account_id === opponent.accountId),
      false,
    );
  } finally {
    service.onModuleDestroy();
  }
});

test('rooms can add AI seats before start', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  try {
    const created = await service.createRoom(user, { gameKey: 'sudoku', maxPlayers: 3 });
    const added = await service.addAiToRoom(created.room.id, user, { difficulty: 'hard' });
    assert.equal(added.room.joinedCount, 2);
    const aiMember = added.room.members.find((member) => member.kind === 'ai');
    assert.ok(aiMember);
    assert.equal(aiMember.aiDifficulty, 'hard');
    assert.equal(aiMember.ready, true);

    await service.setRoomReady(created.room.id, user, { ready: true });
    const started = await service.startRoom(created.room.id, user);
    const seats = db.sessionPlayers
      .filter((row) => row.session_id === started.sessionId)
      .sort((a, b) => a.seat - b.seat);
    assert.equal(seats.length, 2);
    assert.equal(seats[1].kind, 'ai');
    assert.equal(seats[1].ai_difficulty, 'hard');
  } finally {
    service.onModuleDestroy();
  }
});

test('room AI seats actively play sudoku without mutating human boards', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  try {
    const created = await service.createRoom(user, { gameKey: 'sudoku', maxPlayers: 3 });
    await service.addAiToRoom(created.room.id, user, { difficulty: 'hard' });
    await service.setRoomReady(created.room.id, user, { ready: true });
    const started = await service.startRoom(created.room.id, user);

    await wait(950);

    const persisted = db.rows.get(started.sessionId).state_json;
    const aiFilled = sudokuFilledEmptyCells(persisted, 'seat1');
    const humanFilled = sudokuFilledEmptyCells(persisted, 'seat0');

    assert.equal(aiFilled > 0, true);
    assert.equal(humanFilled, 0);
    assert.equal(realtime.events.some((event) => event.event === 'sudoku.cell.updated'), true);
  } finally {
    service.onModuleDestroy();
  }
});

test('room AI seats solve sokoban with server-side moves', async () => {
  const db = new FakeDb();
  db.sokobanMaps.push({
    id: 'room-ai-sokoban-map',
    difficulty: 'easy',
    map_key: 'room-ai-sokoban-map',
    map_json: storedEasySokobanMap(),
    metrics_json: { pushes: 2, boxLines: 1, boxChanges: 0 },
    created_at: new Date(),
  });
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  try {
    const created = await service.createRoom(user, { gameKey: 'sokoban', maxPlayers: 3 });
    await service.addAiToRoom(created.room.id, user, { difficulty: 'hard' });
    await service.setRoomReady(created.room.id, user, { ready: true });
    const started = await service.startRoom(created.room.id, user);

    await wait(1_850);

    const persisted = db.rows.get(started.sessionId).state_json;
    assert.equal(persisted.states.seat1.moves >= 2 || persisted.status === 'finished', true);
    assert.equal(persisted.states.seat0.moves, 0);
    assert.equal(realtime.events.some((event) => event.event === 'sokoban.move.played' || event.event === 'game.session.finished'), true);
  } finally {
    service.onModuleDestroy();
  }
});

test('room AI seats take splendor and mighty turns', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  try {
    const splendorRoom = await service.createRoom(user, { gameKey: 'splendor', maxPlayers: 3 });
    await service.addAiToRoom(splendorRoom.room.id, user, { difficulty: 'hard' });
    await service.addAiToRoom(splendorRoom.room.id, user, { difficulty: 'medium' });
    await service.setRoomReady(splendorRoom.room.id, user, { ready: true });
    const startedSplendor = await service.startRoom(splendorRoom.room.id, user);

    await service.takeSplendorTokens(startedSplendor.sessionId, user, {
      white: 1,
      blue: 1,
      green: 1,
    });
    await wait(950);

    const splendor = db.rows.get(startedSplendor.sessionId).state_json;
    assert.equal(splendor.moves.some((move) => move.side === 'seat1' && move.source === 'ai'), true);
    assert.notEqual(splendor.currentTurn, 'seat1');

    const mightyRoom = await service.createRoom(user, { gameKey: 'mighty', maxPlayers: 5 });
    for (const difficulty of ['easy', 'medium', 'hard', 'medium']) {
      await service.addAiToRoom(mightyRoom.room.id, user, { difficulty });
    }
    await service.setRoomReady(mightyRoom.room.id, user, { ready: true });
    const startedMighty = await service.startRoom(mightyRoom.room.id, user);
    await service.applyGameAction('mighty', startedMighty.sessionId, user, {
      type: 'bid',
      payload: { pass: true },
    });
    await wait(1_650);

    const mighty = db.rows.get(startedMighty.sessionId).state_json;
    assert.equal(mighty.bids.length >= 2, true);
    assert.equal(mighty.bids[1].seat, 1);
  } finally {
    service.onModuleDestroy();
  }
});

test('room AI seats drive crazy arcade inputs during server ticks', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  try {
    const created = await service.createRoom(user, { gameKey: 'crazy_arcade', maxPlayers: 2 });
    await service.addAiToRoom(created.room.id, user, { difficulty: 'hard' });
    await service.setRoomReady(created.room.id, user, { ready: true });
    const started = await service.startRoom(created.room.id, user);

    await wait(280);

    const persisted = db.rows.get(started.sessionId).state_json;
    assert.match(String(persisted.inputs.seat1.direction), /^(up|right|down|left)$/);
    assert.equal(realtime.events.some((event) => event.event === 'crazy_arcade.state.synced'), true);
  } finally {
    service.onModuleDestroy();
  }
});

test('rooms can start multi-player sessions and persist every participant seat', async () => {
  const db = new FakeDb();
  const service = new GamesService(db, new FakeRealtime());
  try {
    const extraPlayers = [3, 4, 5, 6].map((index) => ({
      ...user,
      accountId: `player-${index}`,
      subject: `player-${index}`,
    }));

    const splendorRoom = await service.createRoom(user, { gameKey: 'splendor', maxPlayers: 4 });
    await service.joinRoom(opponent, { roomCode: splendorRoom.room.roomCode });
    await service.joinRoom(extraPlayers[0], { roomCode: splendorRoom.room.roomCode });
    await service.joinRoom(extraPlayers[1], { roomCode: splendorRoom.room.roomCode });
    await service.setRoomReady(splendorRoom.room.id, user, { ready: true });
    await service.setRoomReady(splendorRoom.room.id, opponent, { ready: true });
    await service.setRoomReady(splendorRoom.room.id, extraPlayers[0], { ready: true });
    await service.setRoomReady(splendorRoom.room.id, extraPlayers[1], { ready: true });
    const startedSplendor = await service.startRoom(splendorRoom.room.id, user);
    const splendorPlayers = db.sessionPlayers
      .filter((row) => row.session_id === startedSplendor.sessionId)
      .sort((a, b) => a.seat - b.seat);
    assert.deepEqual(splendorPlayers.map((row) => row.seat), [0, 1, 2, 3]);
    assert.deepEqual(
      splendorPlayers.map((row) => row.account_id),
      [user.accountId, opponent.accountId, extraPlayers[0].accountId, extraPlayers[1].accountId],
    );
    const persistedSplendor = db.rows.get(startedSplendor.sessionId).state_json;
    assert.equal(persistedSplendor.roomMode, 'multi_player');
    assert.deepEqual(persistedSplendor.turnOrder, ['seat0', 'seat1', 'seat2', 'seat3']);
    assert.equal(persistedSplendor.bank.white, 7);
    assert.equal(persistedSplendor.nobles.length, 5);
    assert.deepEqual(Object.keys(persistedSplendor.playerStates).sort(), ['seat0', 'seat1', 'seat2', 'seat3']);
    const hostSplendorView = await service.getSplendorSession(startedSplendor.sessionId, user);
    assert.equal(hostSplendorView.mySide, 'seat0');
    assert.equal(hostSplendorView.currentTurn, 'seat0');
    const afterHostTurn = await service.takeSplendorTokens(startedSplendor.sessionId, user, {
      white: 1,
      blue: 1,
      green: 1,
    });
    assert.equal(afterHostTurn.currentTurn, 'seat1');
    assert.equal(afterHostTurn.playerStates.seat0.tokens.white, 1);
    await service.forfeitSplendor(startedSplendor.sessionId, opponent);
    const afterOpponentForfeit = db.rows.get(startedSplendor.sessionId).state_json;
    assert.equal(afterOpponentForfeit.status, 'playing');
    assert.ok(afterOpponentForfeit.players.seat1.startsWith('__game_platform_local_ai__#splendor-forfeit-'));
    assert.equal(afterOpponentForfeit.seatStatus.seat1, 'active');
    const aiReplacementSeat = db.sessionPlayers.find(
      (row) => row.session_id === startedSplendor.sessionId && row.seat === 1,
    );
    assert.equal(aiReplacementSeat.kind, 'ai');
    assert.equal(aiReplacementSeat.account_id, null);
    assert.equal(aiReplacementSeat.ai_difficulty, 'medium');
    assert.equal(aiReplacementSeat.status, 'active');
    assert.equal((await service.listActiveSessions(opponent)).sessions.length, 0);
    assert.equal((await service.listActiveSessions(user)).sessions.some((session) => session.sessionId === startedSplendor.sessionId), true);
    await service.forfeitSplendor(startedSplendor.sessionId, extraPlayers[0]);
    await service.forfeitSplendor(startedSplendor.sessionId, extraPlayers[1]);
    assert.equal(db.rows.get(startedSplendor.sessionId).state_json.status, 'playing');
    await service.forfeitSplendor(startedSplendor.sessionId, user);
    const afterLastHumanLeaves = db.rows.get(startedSplendor.sessionId).state_json;
    assert.equal(afterLastHumanLeaves.status, 'finished');
    assert.equal(afterLastHumanLeaves.finishReason, 'forfeit');
    assert.equal((await service.listActiveSessions(user)).sessions.length, 0);

    const sudokuRoom = await service.createRoom(user, { gameKey: 'sudoku', maxPlayers: 6 });
    const sudokuPlayers = [opponent, ...extraPlayers];
    for (const player of sudokuPlayers) {
      await service.joinRoom(player, { roomCode: sudokuRoom.room.roomCode });
      await service.setRoomReady(sudokuRoom.room.id, player, { ready: true });
    }
    await service.setRoomReady(sudokuRoom.room.id, user, { ready: true });
    const startedSudoku = await service.startRoom(sudokuRoom.room.id, user);
    const persistedSudokuPlayers = db.sessionPlayers.filter((row) => row.session_id === startedSudoku.sessionId);
    assert.equal(persistedSudokuPlayers.length, 6);
    const persistedSudoku = db.rows.get(startedSudoku.sessionId).state_json;
    assert.equal(persistedSudoku.roomMode, 'multi_player');
    assert.deepEqual(Object.keys(persistedSudoku.players).sort(), ['seat0', 'seat1', 'seat2', 'seat3', 'seat4', 'seat5']);
    assert.deepEqual(Object.keys(persistedSudoku.boards).sort(), ['seat0', 'seat1', 'seat2', 'seat3', 'seat4', 'seat5']);
    assert.deepEqual(Object.keys(persistedSudoku.battle).sort(), ['seat0', 'seat1', 'seat2', 'seat3', 'seat4', 'seat5']);
    const lastSudokuPlayerView = await service.getSudokuSession(startedSudoku.sessionId, extraPlayers[3]);
    assert.equal(lastSudokuPlayerView.mySide, 'seat5');
    assert.equal(lastSudokuPlayerView.solution, undefined);
    assert.equal(Object.keys(lastSudokuPlayerView.progress).length, 6);
    const emptySudokuCell = firstEmptySudokuCell(persistedSudoku.puzzle);
    const updatedSudoku = await service.updateSudokuCell(
      startedSudoku.sessionId,
      extraPlayers[3],
      emptySudokuCell.row,
      emptySudokuCell.col,
      1,
    );
    assert.equal(updatedSudoku.mySide, 'seat5');
    assert.equal(updatedSudoku.board[emptySudokuCell.row][emptySudokuCell.col], 1);
    assert.equal(db.rows.get(startedSudoku.sessionId).state_json.boards.seat5[emptySudokuCell.row][emptySudokuCell.col], 1);
    const afterSudokuForfeit = await service.forfeitSudoku(startedSudoku.sessionId, opponent);
    assert.equal(afterSudokuForfeit.status, 'playing');
    assert.equal(afterSudokuForfeit.mySeatStatus, 'forfeited');
    const persistedSudokuAfterForfeit = db.rows.get(startedSudoku.sessionId).state_json;
    assert.equal(persistedSudokuAfterForfeit.seatStatus.seat1, 'forfeited');
    assert.equal(persistedSudokuAfterForfeit.status, 'playing');
    const forfeitedSudokuSeat = db.sessionPlayers.find(
      (row) => row.session_id === startedSudoku.sessionId && row.account_id === opponent.accountId,
    );
    assert.equal(forfeitedSudokuSeat.status, 'forfeited');
    assert.equal((await service.listActiveSessions(opponent)).sessions.length, 0);
    assert.equal((await service.listActiveSessions(user)).sessions.some((session) => session.sessionId === startedSudoku.sessionId), true);

    const sokobanRoom = await service.createRoom(user, { gameKey: 'sokoban', maxPlayers: 6 });
    for (const player of sudokuPlayers) {
      await service.joinRoom(player, { roomCode: sokobanRoom.room.roomCode });
      await service.setRoomReady(sokobanRoom.room.id, player, { ready: true });
    }
    await service.setRoomReady(sokobanRoom.room.id, user, { ready: true });
    const startedSokoban = await service.startRoom(sokobanRoom.room.id, user);
    const persistedSokobanPlayers = db.sessionPlayers.filter((row) => row.session_id === startedSokoban.sessionId);
    assert.equal(persistedSokobanPlayers.length, 6);
    const persistedSokoban = db.rows.get(startedSokoban.sessionId).state_json;
    assert.equal(persistedSokoban.roomMode, 'multi_player');
    assert.deepEqual(Object.keys(persistedSokoban.players).sort(), ['seat0', 'seat1', 'seat2', 'seat3', 'seat4', 'seat5']);
    assert.deepEqual(Object.keys(persistedSokoban.states).sort(), ['seat0', 'seat1', 'seat2', 'seat3', 'seat4', 'seat5']);
    const lastSokobanPlayerView = await service.getSokobanSession(startedSokoban.sessionId, extraPlayers[3]);
    assert.equal(lastSokobanPlayerView.mySide, 'seat5');
    assert.deepEqual(lastSokobanPlayerView.state.player, persistedSokoban.initialPlayer);

    const crazyRoom = await service.createRoom(user, { gameKey: 'crazy_arcade', maxPlayers: 4 });
    await service.joinRoom(opponent, { roomCode: crazyRoom.room.roomCode });
    await service.joinRoom(extraPlayers[0], { roomCode: crazyRoom.room.roomCode });
    await service.joinRoom(extraPlayers[1], { roomCode: crazyRoom.room.roomCode });
    await service.setRoomReady(crazyRoom.room.id, user, { ready: true });
    await service.setRoomReady(crazyRoom.room.id, opponent, { ready: true });
    await service.setRoomReady(crazyRoom.room.id, extraPlayers[0], { ready: true });
    await service.setRoomReady(crazyRoom.room.id, extraPlayers[1], { ready: true });
    const startedCrazy = await service.startRoom(crazyRoom.room.id, user);
    const persistedCrazyPlayers = db.sessionPlayers
      .filter((row) => row.session_id === startedCrazy.sessionId)
      .sort((a, b) => a.seat - b.seat);
    assert.deepEqual(persistedCrazyPlayers.map((row) => row.seat), [0, 1, 2, 3]);
    const persistedCrazy = db.rows.get(startedCrazy.sessionId).state_json;
    assert.equal(persistedCrazy.roomMode, 'multi_player');
    assert.deepEqual(Object.keys(persistedCrazy.players).sort(), ['seat0', 'seat1', 'seat2', 'seat3']);
    assert.deepEqual(Object.keys(persistedCrazy.inputs).sort(), ['seat0', 'seat1', 'seat2', 'seat3']);
    assert.ok(persistedCrazy.snapshot.tiles);
    assert.equal(persistedCrazy.snapshot.playerSide, 'seat0');
    assert.equal(persistedCrazy.snapshot.opponentSide, 'seat1');
    assert.deepEqual(Object.keys(persistedCrazy.snapshot.others).sort(), ['seat2', 'seat3']);
    const thirdPlayerView = await service.getCrazyArcadeSession(startedCrazy.sessionId, extraPlayers[0]);
    assert.equal(thirdPlayerView.mySide, 'seat2');
    assert.equal(thirdPlayerView.snapshot.playerSide, 'seat2');
    assert.equal(thirdPlayerView.snapshot.opponentSide, 'seat0');
    const beforeMoveX = thirdPlayerView.snapshot.player.center.dx;
    const movedCrazy = await service.updateCrazyArcadeInput(startedCrazy.sessionId, extraPlayers[0], { direction: 'right' });
    assert.equal(movedCrazy.mySide, 'seat2');
    assert.ok(movedCrazy.snapshot.player.center.dx > beforeMoveX);

    const mightyRoom = await service.createRoom(user, { gameKey: 'mighty', maxPlayers: 5 });
    for (const player of [opponent, extraPlayers[0], extraPlayers[1], extraPlayers[2]]) {
      await service.joinRoom(player, { roomCode: mightyRoom.room.roomCode });
      await service.setRoomReady(mightyRoom.room.id, player, { ready: true });
    }
    await service.setRoomReady(mightyRoom.room.id, user, { ready: true });
    const startedMighty = await service.startRoom(mightyRoom.room.id, user);
    const mightyPlayers = db.sessionPlayers
      .filter((row) => row.session_id === startedMighty.sessionId)
      .sort((a, b) => a.seat - b.seat);
    assert.deepEqual(mightyPlayers.map((row) => row.seat), [0, 1, 2, 3, 4]);
    assert.deepEqual(
      mightyPlayers.map((row) => row.account_id),
      [user.accountId, opponent.accountId, extraPlayers[0].accountId, extraPlayers[1].accountId, extraPlayers[2].accountId],
    );
    const persistedMighty = db.rows.get(startedMighty.sessionId).state_json;
    assert.equal(persistedMighty.roomMode, 'multi_player');
    assert.equal(persistedMighty.phase, 'bidding');
    assert.equal(persistedMighty.hands.length, 5);
    const hostMightyView = await service.getMightySession(startedMighty.sessionId, user);
    const secondMightyView = await service.getMightySession(startedMighty.sessionId, opponent);
    assert.equal(hostMightyView.mySeat, 0);
    assert.equal(secondMightyView.mySeat, 1);
    assert.equal(hostMightyView.myHand.length, 10);
    assert.equal(secondMightyView.myHand.length, 10);
    assert.notDeepEqual(hostMightyView.myHand, secondMightyView.myHand);
  } finally {
    service.onModuleDestroy();
  }
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

test('remaining fortress player can claim a disconnect win', async () => {
  const db = new FakeDb();
  const realtime = new FakeRealtime();
  const service = new GamesService(db, realtime);
  const session = await service.createFortressSession(user, opponent.accountId);
  await service.selectFortressTank(session.id, user, 'balance');
  const playing = await service.selectFortressTank(session.id, opponent, 'heavy');
  const row = db.rows.get(playing.id);
  row.state_json.opponentLeftAt = new Date().toISOString();
  row.state_json.networkGraceAccountId = opponent.accountId;

  realtime.online = false;
  const finished = await service.claimDisconnectedWin('fortress', playing.id, user);

  assert.equal(finished.status, 'finished');
  assert.equal(finished.finishReason, 'disconnect');
  assert.equal(finished.winnerAccountId, user.accountId);
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

test('gostop local session dispatches create/get/actions through the service', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  try {
    const created = await service.createGameSession('gostop', user, {
      difficulty: 'easy',
      config: { aiOpponents: 1 },
    });
    assert.equal(created.gameKey, 'gostop');
    assert.equal(created.mySeat, 0);
    assert.equal(Array.isArray(created.myHand), true);
    assert.equal(typeof created.deckCount, 'number');

    const fetched = await service.getGameSession('gostop', created.id, user);
    assert.equal(fetched.id, created.id);

    if (fetched.phase === 'playing' && fetched.currentSeat === 0 && fetched.myHand.length > 0) {
      const after = await service.applyGameAction('gostop', created.id, user, {
        type: 'play_card',
        payload: { cardId: fetched.myHand[0] },
        clientMoveId: 'gostop-play-1',
      });
      assert.equal(after.gameKey, 'gostop');
      // 멱등: 같은 clientMoveId 재전송은 현재 상태를 재응답한다.
      const replay = await service.applyGameAction('gostop', created.id, user, {
        type: 'play_card',
        payload: { cardId: fetched.myHand[0] },
        clientMoveId: 'gostop-play-1',
      });
      assert.equal(replay.gameKey, 'gostop');
    }
  } finally {
    service.onModuleDestroy();
  }
});

test('gostop rejects friend-match create without a room', async () => {
  const service = new GamesService(new FakeDb(), new FakeRealtime());
  try {
    await assert.rejects(
      () => service.createGameSession('gostop', user, { difficulty: 'easy', opponentAccountId: opponent.accountId }),
      /gostop friend matches require a room/,
    );
  } finally {
    service.onModuleDestroy();
  }
});
