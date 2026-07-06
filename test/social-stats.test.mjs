import assert from 'node:assert/strict';
import test from 'node:test';

import { SocialService } from '../dist/social/social.service.js';

const user = {
  accountId: 'player-1',
  subject: 'player-1',
  serviceKey: 'game-platform',
  permission: 'player',
  loginId: 'lafamila',
  name: 'Teddy',
  email: 'teddy@example.test',
  claims: {},
};

const friendAccountId = 'player-2';

class FakeSocialDb {
  friendRequests = [
    {
      id: 'friend-1',
      requester_account_id: user.accountId,
      recipient_account_id: friendAccountId,
      status: 'accepted',
      created_at: new Date(),
      updated_at: new Date(),
    },
  ];
  sessions = [];
  players = [];

  async query(sql, args = []) {
    if (sql.includes('INSERT INTO social_accounts')) {
      return { rows: [] };
    }
    if (sql.includes('JOIN game_session_players me')) {
      const [meAccountId, targetFriendAccountId] = args;
      const rows = this.sessions
        .filter(
          (session) =>
            session.mode === 'friend_match' &&
            ['finished', 'cleared'].includes(session.status) &&
            this.players.some(
              (player) =>
                player.session_id === session.id &&
                player.account_id === meAccountId &&
                player.kind === 'account' &&
                player.status !== 'left',
            ) &&
            this.players.some(
              (player) =>
                player.session_id === session.id &&
                player.account_id === targetFriendAccountId &&
                player.kind === 'account' &&
                player.status !== 'left',
            ),
        )
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .map((session) => ({
          id: session.id,
          game_key: session.game_key,
          state_json: session.state_json,
          updated_at: session.updated_at,
        }));
      return { rows };
    }
    return { rows: [] };
  }

  async one(sql, args = []) {
    if (sql.includes('FROM friend_requests')) {
      const [left, right] = args;
      return (
        this.friendRequests.find(
          (row) =>
            row.status === 'accepted' &&
            ((row.requester_account_id === left &&
              row.recipient_account_id === right) ||
              (row.requester_account_id === right &&
                row.recipient_account_id === left)),
        ) ?? null
      );
    }
    return null;
  }
}

test('friend stats use session participants so N-player rooms are counted', async () => {
  const db = new FakeSocialDb();
  db.sessions.push(
    {
      id: 'session-1',
      game_key: 'splendor',
      mode: 'friend_match',
      status: 'finished',
      state_json: { winnerAccountId: user.accountId },
      updated_at: new Date('2026-07-06T00:00:02.000Z'),
    },
    {
      id: 'session-2',
      game_key: 'sudoku',
      mode: 'friend_match',
      status: 'cleared',
      state_json: { winnerAccountId: friendAccountId },
      updated_at: new Date('2026-07-06T00:00:01.000Z'),
    },
    {
      id: 'session-3',
      game_key: 'crazy_arcade',
      mode: 'friend_match',
      status: 'finished',
      state_json: {
        winnerSide: 'seat2',
        players: {
          seat0: user.accountId,
          seat2: friendAccountId,
        },
      },
      updated_at: new Date('2026-07-06T00:00:00.000Z'),
    },
  );
  db.players.push(
    { session_id: 'session-1', account_id: user.accountId, kind: 'account', status: 'active' },
    { session_id: 'session-1', account_id: friendAccountId, kind: 'account', status: 'active' },
    { session_id: 'session-1', account_id: 'player-3', kind: 'account', status: 'active' },
    { session_id: 'session-1', account_id: 'player-4', kind: 'account', status: 'active' },
    { session_id: 'session-2', account_id: user.accountId, kind: 'account', status: 'active' },
    { session_id: 'session-2', account_id: friendAccountId, kind: 'account', status: 'active' },
    { session_id: 'session-2', account_id: 'player-3', kind: 'account', status: 'active' },
    { session_id: 'session-3', account_id: user.accountId, kind: 'account', status: 'active' },
    { session_id: 'session-3', account_id: friendAccountId, kind: 'account', status: 'active' },
  );

  const service = new SocialService(db, {}, {}, {});
  const stats = await service.friendStats(user, friendAccountId);

  assert.deepEqual(
    stats.games.find((game) => game.gameKey === 'splendor'),
    { gameKey: 'splendor', label: '스플렌더', wins: 1, losses: 0 },
  );
  assert.deepEqual(
    stats.games.find((game) => game.gameKey === 'sudoku'),
    { gameKey: 'sudoku', label: '스도쿠', wins: 0, losses: 1 },
  );
  assert.deepEqual(
    stats.games.find((game) => game.gameKey === 'crazy_arcade'),
    { gameKey: 'crazy_arcade', label: '크레이지 아케이드', wins: 0, losses: 1 },
  );
  assert.deepEqual(stats.total, { wins: 1, losses: 2 });
});
