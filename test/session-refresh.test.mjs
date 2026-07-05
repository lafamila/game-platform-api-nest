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

const MINUTE_MS = 60_000;

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

// 3분류 (1): 400/401/403 = 영구 거절 → 세션 삭제 + 401 SESSION_EXPIRED, 재시도 없음.
for (const status of [400, 401, 403]) {
  test(`deletes the game session when auth rejects the refresh token with ${status}`, async () => {
    const db = new FakeSessionDb();
    const service = new GamePlatformSessionService(db, new FakeAuth());
    const originalFetch = globalThis.fetch;
    let tokenCalls = 0;
    globalThis.fetch = async () => {
      tokenCalls += 1;
      return jsonResponse(status, { error: 'invalid_grant', message: 'Invalid refresh token' });
    };

    try {
      await assert.rejects(
        () => service.requireSession('session-1'),
        (error) => {
          assert.equal(error.status, 401);
          assert.equal(error.getResponse().code, 'SESSION_EXPIRED');
          assert.match(error.message, /Game-platform session expired/);
          return true;
        },
      );
      assert.equal(db.deleted, true);
      assert.equal(tokenCalls, 1, 'a permanent rejection must not be retried');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

// 3분류 (2): 5xx = 일시 장애. access token 이 아직 유효하면 세션을 삭제하지 않고 soft-fail 로 기존 토큰 반환.
test('keeps the session and soft-fails when auth is temporarily unavailable', async () => {
  const db = new FakeSessionDb({
    access_token: 'still-valid-access',
    access_token_expires_at: new Date(Date.now() + 4 * MINUTE_MS), // 5분 창 안이지만 아직 유효
    last_seen_at: new Date(Date.now() - MINUTE_MS),
  });
  const service = new GamePlatformSessionService(db, new FakeAuth());
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    tokenCalls += 1;
    return jsonResponse(503, { message: 'auth restarting' });
  };

  try {
    const session = await service.requireSession('session-1');
    assert.equal(session.accessToken, 'still-valid-access', 'soft-fail keeps serving the existing token');
    assert.equal(db.deleted, false);
    assert.equal(tokenCalls, 2, 'a transient failure retries once');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 3분류 (3): 5xx + access token 이 이미 만료 → 503 AUTH_UPSTREAM_UNAVAILABLE, 세션은 삭제하지 않는다.
test('returns 503 without deleting the session when auth is unavailable and the token expired', async () => {
  const db = new FakeSessionDb({
    access_token_expires_at: new Date(Date.now() - 10_000), // 이미 만료
  });
  const service = new GamePlatformSessionService(db, new FakeAuth());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse(500, { message: 'auth down' });

  try {
    await assert.rejects(
      () => service.requireSession('session-1'),
      (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.getResponse().code, 'AUTH_UPSTREAM_UNAVAILABLE');
        return true;
      },
    );
    assert.equal(db.deleted, false, 'a transient outage must not delete the session');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 선제 refresh: 만료 5분 전 창에 들어오면 refresh 를 트리거한다(구 30초 창에서는 발생하지 않던 시점).
test('preemptively refreshes when the access token is within five minutes of expiry', async () => {
  const db = new FakeSessionDb({
    access_token_expires_at: new Date(Date.now() + 4 * MINUTE_MS),
  });
  const service = new GamePlatformSessionService(db, new FakeAuth());
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    tokenCalls += 1;
    return jsonResponse(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900 });
  };

  try {
    const session = await service.requireSession('session-1');
    assert.equal(tokenCalls, 1);
    assert.equal(session.refreshToken, 'refresh-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not refresh while the access token is comfortably valid', async () => {
  const db = new FakeSessionDb({
    access_token_expires_at: new Date(Date.now() + 10 * MINUTE_MS),
    last_seen_at: new Date(Date.now() - MINUTE_MS),
  });
  const service = new GamePlatformSessionService(db, new FakeAuth());
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  globalThis.fetch = async () => {
    tokenCalls += 1;
    throw new Error('fetch should not be called');
  };

  try {
    const session = await service.requireSession('session-1');
    assert.equal(tokenCalls, 0);
    assert.equal(session.refreshToken, 'old-refresh');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 만료된 세션 행 → 삭제 + 401 SESSION_EXPIRED (code 계약).
test('deletes and reports SESSION_EXPIRED when the stored session row has expired', async () => {
  const db = new FakeSessionDb({
    expires_at: new Date(Date.now() - 1_000),
  });
  const service = new GamePlatformSessionService(db, new FakeAuth());

  await assert.rejects(
    () => service.requireSession('session-1'),
    (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.getResponse().code, 'SESSION_EXPIRED');
      return true;
    },
  );
  assert.equal(db.deleted, true);
});

// sliding 연장: 활동 시 expires_at = LEAST(created + ABSOLUTE, now + IDLE). idle 창이 더 좁을 때는 now + IDLE.
test('slides the session expiry forward within the absolute cap', async () => {
  process.env.GAME_PLATFORM_SESSION_IDLE_SECONDS = '60';
  process.env.GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS = '100000';
  const db = new FakeSessionDb({
    access_token_expires_at: new Date(Date.now() + 20 * MINUTE_MS), // refresh 미발생
    created_at: new Date(Date.now() - 30_000),
    last_seen_at: new Date(Date.now() - 10 * MINUTE_MS), // 5분 스로틀 초과 → 연장
  });
  const service = new GamePlatformSessionService(db, new FakeAuth());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch should not be called');
  };

  try {
    await service.requireSession('session-1');
    assert.ok(typeof db.slidingExpiresAtMs === 'number', 'a sliding extension UPDATE ran');
    assert.ok(Math.abs(db.slidingExpiresAtMs - (Date.now() + 60_000)) < 2_000, 'idle window drives the new expiry');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GAME_PLATFORM_SESSION_IDLE_SECONDS;
    delete process.env.GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS;
  }
});

test('caps the sliding session expiry at the absolute max age', async () => {
  process.env.GAME_PLATFORM_SESSION_IDLE_SECONDS = '100000';
  process.env.GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS = '60';
  const createdAt = new Date(Date.now() - 30_000);
  const db = new FakeSessionDb({
    access_token_expires_at: new Date(Date.now() + 20 * MINUTE_MS),
    created_at: createdAt,
    last_seen_at: new Date(Date.now() - 10 * MINUTE_MS),
  });
  const service = new GamePlatformSessionService(db, new FakeAuth());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch should not be called');
  };

  try {
    await service.requireSession('session-1');
    assert.equal(db.slidingExpiresAtMs, createdAt.getTime() + 60_000, 'absolute cap = created_at + ABSOLUTE');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GAME_PLATFORM_SESSION_IDLE_SECONDS;
    delete process.env.GAME_PLATFORM_SESSION_ABSOLUTE_MAX_AGE_SECONDS;
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
  slidingExpiresAtMs = undefined;
  refreshUpdated = false;

  constructor(overrides = {}) {
    this.row = {
      id: 'session-1',
      user_json: account,
      access_token: 'valid-access',
      refresh_token: 'old-refresh',
      access_token_expires_at: new Date(Date.now() - 10_000),
      created_at: new Date(Date.now() - 60_000),
      last_seen_at: new Date(Date.now() - 60_000),
      expires_at: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

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
      this.refreshUpdated = true;
      this.row.user_json = JSON.parse(args[1]);
      this.row.access_token = args[2];
      this.row.refresh_token = args[3];
      this.row.access_token_expires_at = new Date(args[4]);
      this.row.expires_at = new Date(args[5]);
      this.row.last_seen_at = new Date();
      return { rows: [] };
    }
    if (sql.includes('UPDATE app_sessions SET last_seen_at')) {
      if (typeof args[1] === 'number') {
        this.slidingExpiresAtMs = args[1];
        this.row.expires_at = new Date(args[1]);
      }
      this.row.last_seen_at = new Date();
      return { rows: [] };
    }
    return { rows: [] };
  }
}
