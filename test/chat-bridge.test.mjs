import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatBridgeService } from '../dist/chat/chat-bridge.service.js';

const gameSession = {
  id: 'game-session-1',
  account: {
    accountId: 'account-1',
    subject: 'account-1',
    serviceKey: 'game-platform',
    permission: 'player',
    claims: {},
  },
  accessToken: 'private-auth-access-token',
  refreshToken: 'private-auth-refresh-token',
  accessTokenExpiresAt: Date.now() + 60_000,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};

test('exchanges the server-held auth token and returns only the public chat session contract', async () => {
  process.env.CHAT_API_URL = 'http://chat.internal:3044';
  const db = new FakeChatDb();
  const service = new ChatBridgeService(db);
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return jsonResponse(201, {
      token: 'opaque-chat-token',
      sessionId: 'chat-session-1',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      serviceKey: 'game-platform',
      account: { id: 'account-1', loginId: 'player', name: 'Player' },
      sourceAccessToken: 'must-not-pass-through',
      internal: { node: 'chat-1' },
    });
  };

  try {
    const result = await service.exchange(gameSession);
    assert.equal(request.url, 'http://chat.internal:3044/api/session/exchange');
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.redirect, 'manual');
    assert.equal(request.init.headers.Authorization, 'Bearer private-auth-access-token');
    assert.equal(result.token, 'opaque-chat-token');
    assert.equal(result.sessionId, 'chat-session-1');
    assert.equal(result.serviceKey, 'game-platform');
    assert.deepEqual(result.account, { id: 'account-1', loginId: 'player', name: 'Player' });
    assert.equal(JSON.stringify(result).includes('private-auth'), false);
    assert.equal(db.links.get('game-session-1').chat_token, 'opaque-chat-token');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CHAT_API_URL;
  }
});

test('is explicitly disabled when CHAT_API_URL is unset', async () => {
  delete process.env.CHAT_API_URL;
  const service = new ChatBridgeService(new FakeChatDb());

  await assert.rejects(
    () => service.exchange(gameSession),
    (error) => error.status === 503 && error.getResponse().code === 'CHAT_INTEGRATION_DISABLED',
  );
});

test('reports chat exchange timeouts as a gateway timeout', async () => {
  process.env.CHAT_API_URL = 'http://chat.internal:3044';
  process.env.CHAT_API_TIMEOUT_MS = '10';
  const service = new ChatBridgeService(new FakeChatDb());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => new Promise(() => undefined),
  });

  try {
    await assert.rejects(
      () => service.exchange(gameSession),
      (error) => error.status === 504 && error.getResponse().code === 'CHAT_UPSTREAM_TIMEOUT',
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CHAT_API_URL;
    delete process.env.CHAT_API_TIMEOUT_MS;
  }
});

test('revokes the linked opaque chat session without exposing the auth token', async () => {
  process.env.CHAT_API_URL = 'http://chat.internal:3044';
  const db = new FakeChatDb();
  db.links.set('game-session-1', {
    chat_token: 'opaque-chat-token',
    expires_at: new Date(Date.now() + 30_000),
    response_json: null,
  });
  const service = new ChatBridgeService(db);
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(null, { status: 204 });
  };

  try {
    await service.revokeForGameSession('game-session-1');
    assert.equal(request.url, 'http://chat.internal:3044/api/session/current');
    assert.equal(request.init.method, 'DELETE');
    assert.equal(request.init.redirect, 'manual');
    assert.equal(request.init.headers.Authorization, 'Bearer opaque-chat-token');
    assert.equal(db.links.has('game-session-1'), false);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CHAT_API_URL;
  }
});

test('rejects chat sessions that are not bound to the game account, service, and source-token expiry', async () => {
  process.env.CHAT_API_URL = 'http://chat.internal:3044';
  const invalidResponses = [
    {
      token: 'chat-1', sessionId: 'chat-1', expiresAt: new Date(Date.now() + 30_000).toISOString(),
      serviceKey: 'game-platform', account: { id: 'other-account', loginId: null, name: null },
    },
    {
      token: 'chat-2', sessionId: 'chat-2', expiresAt: new Date(Date.now() + 30_000).toISOString(),
      serviceKey: 'other-service', account: { id: 'account-1', loginId: null, name: null },
    },
    {
      token: 'chat-3', sessionId: 'chat-3', expiresAt: new Date(gameSession.accessTokenExpiresAt + 1_000).toISOString(),
      serviceKey: 'game-platform', account: { id: 'account-1', loginId: null, name: null },
    },
  ];
  const originalFetch = globalThis.fetch;

  try {
    for (const response of invalidResponses) {
      const db = new FakeChatDb();
      const service = new ChatBridgeService(db);
      globalThis.fetch = async () => jsonResponse(201, response);
      await assert.rejects(
        () => service.exchange(gameSession),
        (error) => error.status === 502 && error.getResponse().code === 'CHAT_INVALID_RESPONSE',
      );
      assert.equal(db.links.size, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CHAT_API_URL;
  }
});

test('serializes concurrent exchanges and reuses the still-valid opaque chat session', async () => {
  process.env.CHAT_API_URL = 'http://chat.internal:3044';
  const db = new FakeChatDb();
  const service = new ChatBridgeService(db);
  const originalFetch = globalThis.fetch;
  let exchangeCalls = 0;
  globalThis.fetch = async () => {
    exchangeCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse(201, {
      token: 'shared-chat-token',
      sessionId: 'shared-chat-session',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      serviceKey: 'game-platform',
      account: { id: 'account-1', loginId: 'player', name: 'Player' },
    });
  };

  try {
    const [first, second] = await Promise.all([service.exchange(gameSession), service.exchange(gameSession)]);
    assert.equal(exchangeCalls, 1);
    assert.deepEqual(second, first);
    assert.equal(db.links.size, 1);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CHAT_API_URL;
  }
});

test('logout cleanup waits for an in-flight exchange and revokes the session it created', async () => {
  process.env.CHAT_API_URL = 'http://chat.internal:3044';
  const db = new FakeChatDb();
  const service = new ChatBridgeService(db);
  const originalFetch = globalThis.fetch;
  let releaseExchange;
  let exchangeStarted;
  const started = new Promise((resolve) => { exchangeStarted = resolve; });
  const release = new Promise((resolve) => { releaseExchange = resolve; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/exchange')) {
      exchangeStarted();
      await release;
      return jsonResponse(201, {
        token: 'created-during-race',
        sessionId: 'chat-race',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        serviceKey: 'game-platform',
        account: { id: 'account-1', loginId: null, name: null },
      });
    }
    return new Response(null, { status: 204 });
  };

  try {
    const exchanging = service.exchange(gameSession);
    await started;
    let gameSessionDeleted = false;
    const revoking = service.revokeForGameSession('game-session-1', async () => {
      gameSessionDeleted = true;
      db.appSessions.delete('game-session-1');
    });
    releaseExchange();
    await exchanging;
    await revoking;
    assert.equal(gameSessionDeleted, true);
    assert.equal(db.links.has('game-session-1'), false);
    assert.equal(requests.filter((entry) => entry.url.endsWith('/api/session/current')).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CHAT_API_URL;
  }
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class FakeChatDb {
  links = new Map();
  appSessions = new Set(['game-session-1']);
  locks = new Map();

  async one(sql, args = []) {
    if (sql.includes('FROM app_sessions')) {
      return this.appSessions.has(args[0]) && args[1] === 'account-1' ? { id: args[0] } : undefined;
    }
    if (sql.includes('FROM chat_session_links')) {
      return this.links.get(args[0]);
    }
    return undefined;
  }

  async query(sql, args = []) {
    if (sql.includes('INSERT INTO chat_session_links')) {
      this.links.set(args[0], {
        chat_session_id: args[1],
        chat_token: args[2],
        service_key: args[3],
        expires_at: new Date(args[4]),
        response_json: JSON.parse(args[5]),
      });
    }
    if (sql.includes('DELETE FROM chat_session_links')) {
      this.links.delete(args[0]);
    }
    return { rows: [] };
  }

  async withAdvisoryLock(key, callback) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.locks.set(key, queued);
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
      if (this.locks.get(key) === queued) {
        this.locks.delete(key);
      }
    }
  }
}
