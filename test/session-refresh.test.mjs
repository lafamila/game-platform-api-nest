import assert from 'node:assert/strict';
import test from 'node:test';

import { GamePlatformSessionService } from '../dist/auth/session.service.js';

const account = {
  accountId: 'player-1',
  subject: 'player-1',
  serviceKey: 'game-platform',
  permission: 'player',
  claims: {},
};

process.env.GAME_PLATFORM_OIDC_CLIENT_SECRET = 'test-secret';

test('serializes concurrent refreshes for one game session', async () => {
  const db = new FakeSessionDb();
  const auth = new FakeAuth();
  const service = new GamePlatformSessionService(db, auth);
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    tokenCalls += 1;
    await wait(25);
    return jsonResponse(200, {
      access_token: `access-${tokenCalls}`,
      refresh_token: `refresh-${tokenCalls}`,
      expires_in: 900,
    });
  };

  try {
    const [first, second] = await Promise.all([
      service.requireSession('session-1'),
      service.requireSession('session-1'),
    ]);

    assert.equal(tokenCalls, 1);
    assert.equal(first.refreshToken, 'refresh-1');
    assert.equal(second.refreshToken, 'refresh-1');
    assert.equal(db.row.refresh_token, 'refresh-1');
    assert.equal(db.deleted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deletes the game session when auth rejects the refresh token', async () => {
  const db = new FakeSessionDb();
  const auth = new FakeAuth();
  const service = new GamePlatformSessionService(db, auth);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse(401, { message: 'Invalid refresh token' });

  try {
    await assert.rejects(
      () => service.requireSession('session-1'),
      /Game-platform session expired/,
    );
    assert.equal(db.deleted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeAuth {
  async verifyBearerToken() {
    return account;
  }
}

class FakeSessionDb {
  deleted = false;
  row = {
    id: 'session-1',
    user_json: account,
    access_token: 'expired-access',
    refresh_token: 'old-refresh',
    access_token_expires_at: new Date(Date.now() - 10_000),
    created_at: new Date(Date.now() - 60_000),
    last_seen_at: new Date(Date.now() - 60_000),
    expires_at: new Date(Date.now() + 60_000),
  };

  async one(sql, args = []) {
    if (sql.includes('FROM app_sessions') && args[0] === this.row.id && !this.deleted) {
      return { ...this.row };
    }
    return null;
  }

  async query(sql, args = []) {
    if (sql.includes('DELETE FROM app_sessions')) {
      if (args[0] === this.row.id) {
        this.deleted = true;
      }
      return { rows: [] };
    }
    if (sql.includes('UPDATE app_sessions') && sql.includes('refresh_token')) {
      this.row.user_json = JSON.parse(args[1]);
      this.row.access_token = args[2];
      this.row.refresh_token = args[3];
      this.row.access_token_expires_at = new Date(args[4]);
      this.row.expires_at = new Date(args[5]);
      this.row.last_seen_at = new Date();
      return { rows: [] };
    }
    if (sql.includes('UPDATE app_sessions SET last_seen_at')) {
      this.row.last_seen_at = new Date();
      return { rows: [] };
    }
    return { rows: [] };
  }
}
