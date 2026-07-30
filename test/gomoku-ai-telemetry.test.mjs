import assert from 'node:assert/strict';
import test from 'node:test';

import { GamesService } from '../dist/games/games.service.js';
import { initialGomokuBoard } from '../dist/games/gomoku-engine.js';
import { initialOthelloBoard } from '../dist/games/othello-engine.js';
import { FakeDb, FakeRealtime } from './helpers/fake-db.mjs';

test('hard gomoku persists best-effort decision telemetry before applying the move', async () => {
  const previousBudget = process.env.GOMOKU_AI_BUDGET_MS;
  process.env.GOMOKU_AI_BUDGET_MS = '80';
  try {
    const db = new FakeDb();
    const service = new GamesService(db, new FakeRealtime());
    const board = initialGomokuBoard();
    board[7][7] = 'black';
    const session = {
      id: '00000000-0000-0000-0000-000000000001',
      mode: 'local_ai',
      aiDifficulty: 'hard',
      board,
      currentTurn: 'white',
      status: 'playing',
      players: { black: 'human', white: '__game_platform_local_ai__' },
      moves: [{ row: 7, col: 7, color: 'black', accountId: 'human', createdAt: new Date().toISOString() }],
      moveHistory: [{ n: 0, type: 'move', seat: 0, color: 'black', x: 7, y: 7, at: new Date().toISOString() }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const move = await service.computeHardGomokuMove(session);
    assert.ok(move);
    assert.equal(db.aiDecisions.length, 1);
    assert.equal(db.aiDecisions[0].ply, 1);
    assert.equal(db.aiDecisions[0].color, 'white');
    assert.equal(db.aiDecisions[0].game_key, 'gomoku');
    assert.equal(db.aiDecisions[0].chosen_row, move.row);
    assert.equal(db.aiDecisions[0].chosen_col, move.col);
    assert.equal(db.aiDecisions[0].engine_version, 'gomoku-hard-v4');
    assert.equal(db.aiDecisions[0].decision_source, 'search_final');
    assert.equal(db.aiDecisions[0].fallback_reason, null);
    assert.ok(db.aiDecisions[0].principal_variation_json.length > 0);
  } finally {
    if (previousBudget === undefined) delete process.env.GOMOKU_AI_BUDGET_MS;
    else process.env.GOMOKU_AI_BUDGET_MS = previousBudget;
  }
});

test('hard othello persists the same decision telemetry contract', async () => {
  const previousBudget = process.env.OTHELLO_AI_BUDGET_MS;
  process.env.OTHELLO_AI_BUDGET_MS = '80';
  try {
    const db = new FakeDb();
    const service = new GamesService(db, new FakeRealtime());
    const session = {
      id: '00000000-0000-0000-0000-000000000002',
      mode: 'local_ai',
      aiDifficulty: 'hard',
      board: initialOthelloBoard(),
      currentTurn: 'black',
      status: 'playing',
      players: { black: '__game_platform_local_ai__', white: 'human' },
      moves: [],
      moveHistory: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const move = await service.computeHardOthelloMove(session);
    assert.ok(move);
    assert.equal(db.aiDecisions.length, 1);
    assert.equal(db.aiDecisions[0].game_key, 'othello');
    assert.equal(db.aiDecisions[0].engine_version, 'othello-hard-v2');
    assert.equal(db.aiDecisions[0].decision_source, 'search_final');
    assert.equal(db.aiDecisions[0].fallback_reason, null);
    assert.equal(db.aiDecisions[0].chosen_row, move.row);
    assert.equal(db.aiDecisions[0].chosen_col, move.col);
  } finally {
    if (previousBudget === undefined) delete process.env.OTHELLO_AI_BUDGET_MS;
    else process.env.OTHELLO_AI_BUDGET_MS = previousBudget;
  }
});

test('queued hard gomoku uses a deterministic local fallback and records the cause', async () => {
  const previousBudget = process.env.GOMOKU_AI_BUDGET_MS;
  process.env.GOMOKU_AI_BUDGET_MS = '500';
  try {
    const db = new FakeDb();
    const service = new GamesService(db, new FakeRealtime());
    service.aiWorkerPool = {
      run: async () => ({
        type: 'final', move: null, depth: 0, score: 0, nodes: 0, terminationReason: 'queue_timeout',
      }),
    };
    const board = initialGomokuBoard();
    board[7][7] = 'black';
    const session = {
      id: '00000000-0000-0000-0000-000000000003',
      mode: 'local_ai', aiDifficulty: 'hard', board, currentTurn: 'white', status: 'playing',
      players: { black: 'human', white: '__game_platform_local_ai__' },
      moves: [{ row: 7, col: 7, color: 'black', accountId: 'human', createdAt: new Date().toISOString() }],
      moveHistory: [{ n: 0, type: 'move', seat: 0, color: 'black', x: 7, y: 7, at: new Date().toISOString() }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    const move = await service.computeHardGomokuMove(session);
    assert.ok(move);
    assert.ok(Math.abs(move.row - 7) <= 2 && Math.abs(move.col - 7) <= 2);
    assert.equal(db.aiDecisions[0].decision_source, 'deterministic_fallback');
    assert.equal(db.aiDecisions[0].fallback_reason, 'queue_timeout');
    assert.equal(db.aiDecisions[0].exit_reason, 'queue_timeout');
  } finally {
    if (previousBudget === undefined) delete process.env.GOMOKU_AI_BUDGET_MS;
    else process.env.GOMOKU_AI_BUDGET_MS = previousBudget;
  }
});

test('timed-out hard othello records and uses the last worker interim', async () => {
  const previousBudget = process.env.OTHELLO_AI_BUDGET_MS;
  process.env.OTHELLO_AI_BUDGET_MS = '500';
  try {
    const db = new FakeDb();
    const service = new GamesService(db, new FakeRealtime());
    const interimMove = { row: 2, col: 3 };
    service.aiWorkerPool = {
      run: async () => ({
        type: 'final', move: interimMove, depth: 4, score: 120, nodes: 0, terminationReason: 'worker_timeout',
      }),
    };
    const session = {
      id: '00000000-0000-0000-0000-000000000004',
      mode: 'local_ai', aiDifficulty: 'hard', board: initialOthelloBoard(), currentTurn: 'black', status: 'playing',
      players: { black: '__game_platform_local_ai__', white: 'human' }, moves: [], moveHistory: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };

    const move = await service.computeHardOthelloMove(session);
    assert.deepEqual(move, interimMove);
    assert.equal(db.aiDecisions[0].decision_source, 'worker_interim');
    assert.equal(db.aiDecisions[0].fallback_reason, 'worker_timeout');
    assert.equal(db.aiDecisions[0].completed_depth, 4);
  } finally {
    if (previousBudget === undefined) delete process.env.OTHELLO_AI_BUDGET_MS;
    else process.env.OTHELLO_AI_BUDGET_MS = previousBudget;
  }
});
