import assert from 'node:assert/strict';
import test from 'node:test';

import { GamesService } from '../dist/games/games.service.js';
import { initialGomokuBoard } from '../dist/games/gomoku-engine.js';
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
    assert.equal(db.aiDecisions[0].chosen_row, move.row);
    assert.equal(db.aiDecisions[0].chosen_col, move.col);
    assert.equal(db.aiDecisions[0].engine_version, 'gomoku-hard-v2');
    assert.ok(db.aiDecisions[0].principal_variation_json.length > 0);
  } finally {
    if (previousBudget === undefined) delete process.env.GOMOKU_AI_BUDGET_MS;
    else process.env.GOMOKU_AI_BUDGET_MS = previousBudget;
  }
});
