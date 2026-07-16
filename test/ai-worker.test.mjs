import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
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
  // Othello performs a non-trivial search but may now return before the hard
  // deadline when the next iterative-deepening layer is predicted not to finish.
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
  assert.ok(elapsed >= 100, `the worker performed a non-trivial search (elapsed ${elapsed}ms)`);
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
  assert.equal(result.terminationReason, 'queue_timeout');
  assert.ok(Date.now() - deadlineAt < 550, 'the queued request returned as soon as the occupied slot was released');
});

test('an Othello worker search observes the forwarded absolute deadline', async () => {
  const pool = new AiWorkerPool(1);
  const startedAt = Date.now();
  const deadlineAt = startedAt + 800;
  const result = await pool.run({
    game: 'othello',
    board: initialOthelloBoard(),
    turn: 'black',
    aiColor: 'black',
    budgetMs: 1_200,
    deadlineAt,
  });
  assert.ok(result.move, 'the depth-zero interim provides a legal deadline fallback');
  assert.ok(result.diagnostics, 'the search should return cleanly before the pool kills its worker');
  assert.ok(result.diagnostics.budgetMs < 1_200, 'worker startup and the absolute deadline reduce the engine budget');
  assert.ok(Date.now() - deadlineAt < 150, 'the worker returns at the absolute deadline rather than starting a fresh budget');
});

test('a killed worker returns its last interim with an explicit timeout reason', async () => {
  const workerFile = fileURLToPath(new URL('./fixtures/slow-ai-worker.cjs', import.meta.url));
  const pool = new AiWorkerPool(1, workerFile);
  const result = await pool.run({
    game: 'gomoku',
    board: seededGomoku(),
    turn: 'white',
    aiColor: 'white',
    budgetMs: 100,
  });

  assert.deepEqual(result.move, { row: 6, col: 7 });
  assert.equal(result.depth, 0);
  assert.equal(result.terminationReason, 'worker_timeout');
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
