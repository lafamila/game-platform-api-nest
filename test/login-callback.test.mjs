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

test('reuses a completed login transaction when the auth callback is repeated', async () => {
  const db = new FakeLoginDb();
  const service = new GamePlatformSessionService(db, new FakeAuth());

  const result = await service.completeOidcCallback({
    state: 'completed-state',
    code: 'already-used-code',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.loginTransactionId, 'login-1');
  assert.equal(result.redirectUri, 'gameplatform://auth/callback?loginTransactionId=login-1&status=success');
  assert.equal(result.session?.id, 'session-1');
});

class FakeAuth {}

class FakeLoginDb {
  async one(sql, args = []) {
    if (sql.includes('FROM login_transactions') && args[0] === 'completed-state') {
      return {
        id: 'login-1',
        state: 'completed-state',
        verifier: 'verifier',
        code_challenge: 'challenge',
        return_uri: 'gameplatform://auth/callback',
        status: 'completed',
        session_id: 'session-1',
        error_code: null,
        error: null,
        expires_at: new Date(Date.now() + 60_000),
      };
    }
    if (sql.includes('FROM app_sessions') && args[0] === 'session-1') {
      return {
        id: 'session-1',
        user_json: account,
        access_token: 'access',
        refresh_token: 'refresh',
        access_token_expires_at: new Date(Date.now() + 600_000),
        created_at: new Date(Date.now() - 10_000),
        last_seen_at: new Date(Date.now() - 10_000),
        expires_at: new Date(Date.now() + 60_000),
      };
    }
    return null;
  }

  async query() {
    return { rows: [] };
  }
}
