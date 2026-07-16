import assert from 'node:assert/strict';
import test from 'node:test';

import { AiWorkerPool } from '../dist/games/engine/ai-worker-pool.js';
import { initialOthelloBoard } from '../dist/games/othello-engine.js';
import { initialGomokuBoard } from '../dist/games/gomoku-engine.js';

test('the worker returns a legal move for a request', async () => {
  const pool = new AiWorkerPool(2);
  const board = initialGomokuBoard();
  board[7][7] = 'black';
  const result = await pool.run({ game: 'gomoku', board, turn: 'white', aiColor: 'white', budgetMs: 300 });
  assert.equal(result.type, 'final');
  assert.ok(result.move, 'a move is returned');
  assert.ok(result.move.row >= 0 && result.move.row < 15);
});

test('a hard AI think runs off the main event loop (worker isolation)', async () => {
  const pool = new AiWorkerPool(2);
  const budgetMs = 1200;
  const started = Date.now();
  // Othello from the opening keeps deepening until the deadline, so it genuinely
  // occupies its whole budget — a good stress for the isolation check.
  const runPromise = pool.run({
    game: 'othello',
    board: initialOthelloBoard(),
    turn: 'black',
    aiColor: 'black',
    budgetMs,
  });

  // While the worker is computing, a timer on the main thread must still fire promptly.
  const scheduledAt = Date.now();
  const firedAt = await new Promise((resolve) => setTimeout(() => resolve(Date.now()), 50));
  const timerLatency = firedAt - scheduledAt;

  const result = await runPromise;
  const elapsed = Date.now() - started;

  assert.ok(result.move, 'worker produced a move');
  assert.ok(elapsed >= 1000, `the search actually used its budget (elapsed ${elapsed}ms)`);
  assert.ok(
    timerLatency < 200,
    `main event loop stayed responsive during the worker think (timer latency ${timerLatency}ms)`,
  );
});

test('two concurrent worker jobs both complete on a pool of size 2', async () => {
  const pool = new AiWorkerPool(2);
  const [a, b] = await Promise.all([
    pool.run({ game: 'gomoku', board: seededGomoku(), turn: 'black', aiColor: 'black', budgetMs: 300 }),
    pool.run({ game: 'othello', board: initialOthelloBoard(), turn: 'black', aiColor: 'black', budgetMs: 300 }),
  ]);
  assert.ok(a.move);
  assert.ok(b.move);
});

test('worker queue time is charged to the absolute request deadline', async () => {
  const pool = new AiWorkerPool(1);
  const first = pool.run({
    game: 'othello',
    board: initialOthelloBoard(),
    turn: 'black',
    aiColor: 'black',
    budgetMs: 500,
  });
  const deadlineAt = Date.now() + 100;
  const second = pool.run({
    game: 'gomoku',
    board: seededGomoku(),
    turn: 'white',
    aiColor: 'white',
    budgetMs: 500,
    deadlineAt,
  });

  await first;
  const result = await second;
  assert.equal(result.move, null, 'expired queued work must not start a fresh full-budget search');
  assert.ok(Date.now() - deadlineAt < 550, 'the queued request returned as soon as the occupied slot was released');
});

test('a worker spawn failure rejects so the caller can fall back to the sync engine', async () => {
  const badPool = new AiWorkerPool(2, '/nonexistent/path/ai-worker.js');
  await assert.rejects(
    badPool.run({ game: 'gomoku', board: initialGomokuBoard(), turn: 'black', aiColor: 'black', budgetMs: 300 }),
  );
});

function seededGomoku() {
  const board = initialGomokuBoard();
  board[7][7] = 'black';
  board[7][8] = 'white';
  board[8][7] = 'black';
  return board;
}
