import assert from 'node:assert/strict';
import test from 'node:test';

import { ReplayService } from '../dist/replay/replay.service.js';

const AI = '__game_platform_local_ai__';
const iso = (ms) => new Date(ms).toISOString();
const T = 1_700_000_000_000;

function move(n, color, x, y, atMs) {
  return { n, type: 'move', seat: color === 'black' ? 0 : 1, color, x, y, at: iso(atMs) };
}

// s1 gomoku local_ai (newest), s2 othello friend_match (middle), s6 othello forfeit (oldest)
// s3 finished but no moveHistory (retroactive → excluded), s4 playing (excluded), s5 sudoku (excluded)
function sessions() {
  return [
    {
      id: 's1', game_key: 'gomoku', mode: 'local_ai', status: 'finished', winner: 'black',
      owner_account_id: 'acc-1', opponent_account_id: null, created_at: new Date(T + 3000),
      state_json: {
        players: { black: 'acc-1', white: AI }, aiDifficulty: 'hard', winner: 'black',
        moveHistory: [move(0, 'black', 7, 7, T), move(1, 'white', 7, 8, T + 3000), move(2, 'black', 8, 8, T + 3000 + 50000)],
      },
    },
    {
      id: 's2', game_key: 'othello', mode: 'friend_match', status: 'finished', winner: 'white',
      owner_account_id: 'acc-1', opponent_account_id: 'acc-2', created_at: new Date(T + 2000),
      state_json: {
        players: { black: 'acc-1', white: 'acc-2' }, winner: 'white', finishReason: 'board_complete',
        moveHistory: [move(0, 'black', 2, 3, T), move(1, 'white', 2, 2, T + 1500)],
      },
    },
    {
      id: 's3', game_key: 'gomoku', mode: 'local_ai', status: 'finished', winner: 'black',
      owner_account_id: 'acc-1', opponent_account_id: null, created_at: new Date(T + 500),
      state_json: { players: { black: 'acc-1', white: AI }, winner: 'black' }, // no moveHistory
    },
    {
      id: 's4', game_key: 'gomoku', mode: 'friend_match', status: 'playing', winner: null,
      owner_account_id: 'acc-1', opponent_account_id: 'acc-2', created_at: new Date(T + 400),
      state_json: { players: { black: 'acc-1', white: 'acc-2' }, moveHistory: [move(0, 'black', 7, 7, T)] },
    },
    {
      id: 's5', game_key: 'sudoku', mode: 'friend_match', status: 'finished', winner: null,
      owner_account_id: 'acc-1', opponent_account_id: 'acc-2', created_at: new Date(T + 300),
      state_json: { players: { black: 'acc-1', white: 'acc-2' }, moveHistory: [move(0, 'black', 1, 1, T)] },
    },
    {
      id: 's6', game_key: 'othello', mode: 'friend_match', status: 'finished', winner: 'white',
      owner_account_id: 'acc-3', opponent_account_id: 'acc-1', created_at: new Date(T + 1000),
      state_json: {
        players: { black: 'acc-3', white: 'acc-1' }, winner: 'white', finishReason: 'forfeit',
        moveHistory: [move(0, 'black', 2, 3, T), move(1, 'white', 2, 2, T + 500), move(2, 'black', 3, 2, T + 900), move(3, 'white', 4, 5, T + 1200)],
      },
    },
  ];
}

const ACCOUNTS = [
  { account_id: 'acc-1', login_id: 'alice', name: 'Alice' },
  { account_id: 'acc-2', login_id: 'bob', name: '' },
];

class FakeReplayDb {
  constructor(rows, accounts) { this.rows = rows; this.accounts = accounts; }
  _filter(sql, params) {
    const games = params[0];
    const accountId = sql.includes('owner_account_id') ? params[1] : null;
    return this.rows
      .filter((s) =>
        s.status === 'finished' &&
        games.includes(s.game_key) &&
        Array.isArray(s.state_json.moveHistory) && s.state_json.moveHistory.length > 0 &&
        (!accountId || s.owner_account_id === accountId || s.opponent_account_id === accountId))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }
  async one(sql, params = []) {
    if (sql.includes('count(*)')) { return { total: this._filter(sql, params).length }; }
    if (sql.includes('FROM game_sessions') && sql.includes('WHERE id = $1')) {
      return this.rows.find((s) => s.id === params[0]);
    }
    return undefined;
  }
  async query(sql, params = []) {
    if (sql.includes('FROM social_accounts')) {
      const ids = params[0];
      return { rows: this.accounts.filter((a) => ids.includes(a.account_id)) };
    }
    if (sql.includes('FROM game_sessions')) {
      const rows = this._filter(sql, params);
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return { rows: rows.slice(offset, offset + limit) };
    }
    return { rows: [] };
  }
}

function service() { return new ReplayService(new FakeReplayDb(sessions(), ACCOUNTS)); }

// ---------------------------------------------------------------------------
// list: filtering, exclusion, ordering, format
// ---------------------------------------------------------------------------

test('list returns only finished gomoku/othello games that have a moveHistory, newest first', async () => {
  const result = await service().listReplays({});
  assert.equal(result.total, 3);
  assert.deepEqual(result.items.map((i) => i.sessionId), ['s1', 's2', 's6']);
});

test('list formats a local_ai gomoku row (human display name + AI difficulty + winner)', async () => {
  const { items } = await service().listReplays({ game: 'gomoku' });
  assert.equal(items.length, 1);
  const row = items[0];
  assert.equal(row.mode, 'local_ai');
  assert.equal(row.aiDifficulty, 'hard');
  assert.equal(row.moveCount, 3);
  assert.equal(row.winner, 'acc-1');
  assert.equal(row.startedAt, new Date(T + 3000).toISOString());
  const human = row.players.find((p) => !p.isAi);
  const ai = row.players.find((p) => p.isAi);
  assert.equal(human.displayName, 'Alice');
  assert.equal(ai.displayName, 'AI');
});

test('list formats a friend_match othello row and resolves both display names (name→loginId→id)', async () => {
  const { items } = await service().listReplays({ game: 'othello' });
  assert.deepEqual(items.map((i) => i.sessionId), ['s2', 's6']);
  const s2 = items[0];
  assert.equal(s2.players[0].displayName, 'Alice'); // acc-1 name
  assert.equal(s2.players[1].displayName, 'bob'); // acc-2 has no name → loginId
  assert.equal(s2.winner, 'acc-2');
  assert.equal(s2.finishReason, 'board_complete');
  const s6 = items[1];
  assert.equal(s6.players[0].displayName, 'acc-3'); // uncached → account id fallback
  assert.equal(s6.winner, 'acc-1');
  assert.equal(s6.finishReason, 'forfeit');
});

test('list filters by accountId across owner and opponent seats', async () => {
  const forAcc1 = await service().listReplays({ accountId: 'acc-1' });
  assert.deepEqual(forAcc1.items.map((i) => i.sessionId), ['s1', 's2', 's6']);
  const forAcc2 = await service().listReplays({ accountId: 'acc-2' });
  assert.deepEqual(forAcc2.items.map((i) => i.sessionId), ['s2']);
});

test('list paginates with a stable total', async () => {
  const page1 = await service().listReplays({ pageSize: 2, page: 1 });
  assert.equal(page1.total, 3);
  assert.deepEqual(page1.items.map((i) => i.sessionId), ['s1', 's2']);
  const page2 = await service().listReplays({ pageSize: 2, page: 2 });
  assert.equal(page2.total, 3);
  assert.deepEqual(page2.items.map((i) => i.sessionId), ['s6']);
});

test('list rejects an unknown game filter', async () => {
  await assert.rejects(() => service().listReplays({ game: 'chess' }), /gomoku or othello/);
});

// ---------------------------------------------------------------------------
// detail: moves + delayMs + snapshots
// ---------------------------------------------------------------------------

test('detail returns per-move snapshots and clamped delays', async () => {
  const detail = await service().getReplay('s1');
  assert.equal(detail.gameKey, 'gomoku');
  assert.equal(detail.boardSize, 15);
  assert.equal(detail.moves.length, 3);
  assert.equal(detail.snapshots.length, 3);
  assert.equal(detail.moves[0].delayMs, 0);
  assert.equal(detail.moves[1].delayMs, 3000);
  assert.equal(detail.moves[2].delayMs, 30000); // clamped from 50s
  assert.equal(detail.snapshots[0][7][7], 'black');
  assert.equal(detail.aiDifficulty, 'hard');
  assert.equal(detail.winner, 'acc-1');
});

test('detail 404s for missing, non-replay, or un-logged (retroactive) sessions', async () => {
  await assert.rejects(() => service().getReplay('nope'), /Replay not found/);
  await assert.rejects(() => service().getReplay('s5'), /Replay not found/); // sudoku
  await assert.rejects(() => service().getReplay('s3'), /Replay not found/); // no moveHistory
});
