import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { AuthService } from '../dist/auth/auth.service.js';
import { GamePlatformSessionService } from '../dist/auth/session.service.js';
import { GamePlatformSessionGuard } from '../dist/auth/session.guard.js';
import { SessionController } from '../dist/auth/session.controller.js';
import { RealtimeService } from '../dist/realtime/realtime.service.js';
import { REPLAY_VIEW_HTML } from '../dist/replay/replay-view.page.js';
import vm from 'node:vm';
import { RealtimeGateway } from '../dist/realtime/realtime.gateway.js';

const METHOD = 'https://lafamila.xyz/claims/authentication_method';
const CATEGORY = 'https://lafamila.xyz/claims/service_category';
const MESSAGE = '카카오로 로그인한 경우 정책상 게임서비스는 이용할 수 없습니다. 다른 방식으로 로그인해주세요.';
const REAUTH = 'AUTHENTICATION_METHOD_REAUTHENTICATION_REQUIRED';
const DENIED = 'AUTHENTICATION_METHOD_NOT_ALLOWED';
const proof = 'native-proof-0123456789012345678901234567890123456789';
process.env.GAME_PLATFORM_OIDC_CLIENT_SECRET = 'test-secret';
const hash = (value) => createHash('sha256').update(value).digest('base64url');
const account = (method = 'local', category = 'game') => ({
  accountId: 'account-1', subject: 'account-1', serviceKey: 'game-platform', permission: 'player',
  claims: { [METHOD]: method, [CATEGORY]: category, linkedProviders: ['kakao'] },
});
const policyError = (bodyCode = DENIED, message = MESSAGE) => (error) => {
  assert.equal(error.status, 401);
  assert.equal(error.getResponse().code, 'SESSION_AUTH_METHOD_DENIED');
  assert.equal(error.getResponse().bodyCode, bodyCode);
  assert.equal(error.getResponse().message, message);
  return true;
};

test('signed game Kakao bearer is denied; local/google/naver and non-game Kakao are allowed', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const auth = new AuthService();
  auth.getJwks = async () => publicKey;
  const service = new GamePlatformSessionService(new Db(), auth);
  const jwt = async (method, category) => new SignJWT({
    [METHOD]: method, [CATEGORY]: category, linkedProviders: ['kakao'],
    'https://lafamila.xyz/claims/service': { key: 'game-platform', permission: 'player' },
  }).setProtectedHeader({ alg: 'RS256' }).setSubject('account-1')
    .setIssuer('http://localhost:3032').setAudience('service:game-platform').setExpirationTime('15m').sign(privateKey);
  await assert.rejects(() => service.requireTokenOrSession({ bearerToken: '' }).then(async () => {}));
  await assert.rejects(async () => service.requireTokenOrSession({ bearerToken: await jwt('kakao', 'game') }), policyError());
  for (const [method, category] of [['local', 'game'], ['google', 'game'], ['naver', 'game'], ['kakao', 'productivity']]) {
    const result = await service.requireTokenOrSession({ bearerToken: await jwt(method, category) });
    assert.equal(result.account.authenticationMethod, method);
    assert.equal(result.account.serviceCategory, category);
  }
  await assert.rejects(async () => service.requireTokenOrSession({ bearerToken: await jwt('legacy', 'game') }), (error) => {
    assert.equal(error.getResponse().bodyCode, REAUTH);
    assert.notEqual(error.message, MESSAGE);
    return true;
  });
  await assert.rejects(async () => service.requireTokenOrSession({ bearerToken: await jwt(['local'], 'game') }), (error) => {
    assert.equal(error.getResponse().bodyCode, REAUTH, 'authentication_method must be an exact string');
    return true;
  });
  const signed = await jwt('local', 'game');
  const parts = signed.split('.');
  const forged = { ...JSON.parse(Buffer.from(parts[1], 'base64url')), [METHOD]: 'kakao' };
  parts[1] = Buffer.from(JSON.stringify(forged)).toString('base64url');
  await assert.rejects(() => service.requireTokenOrSession({ bearerToken: parts.join('.') }), (error) => {
    assert.equal(error.status, 401);
    assert.notEqual(error.message, MESSAGE, 'never trust a claim before signature verification');
    return true;
  });
});

test('legacy without a stored refresh token requires reauthentication, never a Kakao denial', async () => {
  const db = new Db(account('legacy'));
  db.row.refresh_token = '';
  await assert.rejects(() => new GamePlatformSessionService(db, {}).requireSession('session-1'), (error) => {
    assert.equal(error.getResponse().bodyCode, REAUTH);
    assert.notEqual(error.message, MESSAGE);
    return true;
  });
});

test('missing provenance and Auth outage keep the row but do not authorize a game', async () => {
  const db = new Db({ ...account(), claims: {} });
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    await assert.rejects(() => new GamePlatformSessionService(db, {}).requireSession('session-1'), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.getResponse().code, 'AUTH_UPSTREAM_UNAVAILABLE');
      assert.notEqual(error.message, MESSAGE);
      return true;
    });
    assert.deepEqual(db.deleted, []);
  } finally { globalThis.fetch = previous; }
});

test('cached game Kakao deletes only its session and revokes chat/realtime before returning policy', async () => {
  const db = new Db(account('kakao'));
  const revoked = [];
  const chat = { async revokeForGameSession(id, remove) { revoked.push(['chat', id]); await remove(); } };
  const realtime = { revokeSessions(id, sessions, payload) { revoked.push(['realtime', id, sessions, payload]); } };
  const service = new GamePlatformSessionService(db, {}, chat, realtime);
  await assert.rejects(() => service.requireSession('session-1'), policyError());
  assert.deepEqual(db.deleted, ['session-1']);
  assert.equal(revoked[0][1], 'session-1');
  assert.deepEqual(revoked[1][2], ['session-1']);
  assert.equal(revoked[1][3].message, MESSAGE);
});

for (const bodyCode of [DENIED, REAUTH]) {
  test(`refresh preserves structured ${bodyCode} and exact description, without soft fail`, async () => {
    const db = new Db(account('legacy'));
    const service = new GamePlatformSessionService(db, {});
    const message = bodyCode === DENIED ? MESSAGE : '로그인 방식을 확인할 수 없습니다. 다시 로그인해주세요.';
    const previous = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ code: bodyCode, error: 'access_denied', error_description: message }), { status: 403 }); };
    try {
      await assert.rejects(() => service.requireSession('session-1'), policyError(bodyCode, message));
      assert.equal(calls, 1);
      assert.deepEqual(db.deleted, ['session-1']);
    } finally { globalThis.fetch = previous; }
  });
}

test('missing cached provenance refreshes once and accepts verified Google without per-request Auth calls', async () => {
  const db = new Db(account('legacy'));
  const auth = { async verifyBearerToken() { return account('google'); } };
  const service = new GamePlatformSessionService(db, auth);
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 900 })); };
  try {
    await service.requireSession('session-1');
    await service.requireSession('session-1');
    assert.equal(calls, 1);
    assert.deepEqual(db.deleted, []);
  } finally { globalThis.fetch = previous; }
});

test('native failed completion validates proof before deleting the previous session', async () => {
  const db = new Db(account('kakao'));
  db.transaction = transaction();
  const service = new GamePlatformSessionService(db, {});
  const result = await service.completeOidcCallback({ state: 'state-1', error: 'access_denied', errorDescription: MESSAGE, policyCode: DENIED });
  assert.equal(result.error, MESSAGE);
  assert.deepEqual(db.deleted, [], 'native callback must not clean up before proof');
  await assert.rejects(() => service.completeOidcLogin('tx-1', 'wrong-proof'));
  await assert.rejects(() => service.completeOidcLogin('tx-1', 123));
  assert.deepEqual(db.deleted, []);
  await assert.rejects(() => service.completeOidcLogin('tx-1', proof), policyError());
  assert.deepEqual(db.deleted, ['session-1']);
});

test('browser failed callback requires initiating browser state before logout', async () => {
  const db = new Db(account('kakao'));
  db.transaction = { ...transaction(), return_uri: 'http://localhost:3035/replay', login_proof_hash: null };
  const service = new GamePlatformSessionService(db, {});
  const input = { state: 'state-1', error: 'access_denied', errorDescription: MESSAGE, policyCode: DENIED };
  await service.completeOidcCallback({ ...input, browserState: 'forged-state' });
  assert.deepEqual(db.deleted, []);
  assert.equal(db.transaction.status, 'pending');
  await service.completeOidcCallback({ ...input, browserState: 'state-1' });
  assert.deepEqual(db.deleted, ['session-1']);
});

test('guard clears the RP cookie when policy invalidates a request', async () => {
  const error = { getResponse: () => ({ code: 'SESSION_AUTH_METHOD_DENIED' }), status: 401 };
  const guard = new GamePlatformSessionGuard({ async requireTokenOrSession() { throw error; } });
  const cleared = [];
  const context = { switchToHttp: () => ({ getRequest: () => ({ headers: { cookie: 'game_platform_session=session-1' } }), getResponse: () => ({ clearCookie: (...args) => cleared.push(args) }) }) };
  await assert.rejects(() => guard.canActivate(context));
  assert.equal(cleared[0][0], 'game_platform_session');
});

test('policy response never clears a different, permitted browser session cookie', async () => {
  const error = { getResponse: () => ({ code: 'SESSION_AUTH_METHOD_DENIED' }), status: 401 };
  const guard = new GamePlatformSessionGuard({ async requireTokenOrSession() { throw error; } });
  const cleared = [];
  const context = { switchToHttp: () => ({ getRequest: () => ({ headers: { cookie: 'game_platform_session=google-session', 'x-game-platform-session': 'kakao-session' } }), getResponse: () => ({ clearCookie: (...args) => cleared.push(args) }) }) };
  await assert.rejects(() => guard.canActivate(context));
  assert.deepEqual(cleared, []);
});

test('native start persists only a proof hash and does not leak proof into Auth or return URLs', async () => {
  const db = new Db();
  let args;
  db.query = async (_sql, values) => { args = values; return { rows: [] }; };
  const service = new GamePlatformSessionService(db, {});
  const result = await service.startOidcLogin({ returnUri: 'gameplatform://auth/callback', loginProof: proof, previousSessionId: 'session-1' });
  assert.equal(args[7], hash(proof));
  assert.equal(args[8], 'session-1');
  assert.ok(!JSON.stringify(result).includes(proof));
  assert.ok(!result.authorizeUrl.includes(hash(proof)));
  await assert.rejects(() => service.startOidcLogin({ returnUri: 'gameplatform://auth/callback' }));
});

test('bound browser callback clears its old cookie and no other session', async () => {
  for (const cookieId of ['session-1', 'later-google-session']) {
    const db = new Db(account('kakao'));
    db.transaction = { ...transaction(), return_uri: 'http://localhost:3035/replay', login_proof_hash: null };
    const controller = new SessionController(new GamePlatformSessionService(db, {}));
    const cleared = [];
    const response = { clearCookie: (...args) => cleared.push(args), redirect() {} };
    const request = { headers: { cookie: `game_platform_session=${cookieId}; game_platform_session_oidc_state=state-1` } };
    await controller.oidcCallback(undefined, 'state-1', 'access_denied', MESSAGE, DENIED, undefined, request, response);
    assert.deepEqual(db.deleted, ['session-1']);
    assert.equal(cleared.some(([name]) => name === 'game_platform_session'), cookieId === 'session-1');
  }
});

test('failed new Kakao login preserves an existing permitted local or Google session', async () => {
  for (const method of ['local', 'google']) {
    for (const native of [true, false]) {
      const db = new Db(account(method));
      db.transaction = { ...transaction(), ...(native ? {} : { return_uri: 'http://localhost:3035/replay', login_proof_hash: null }) };
      const revoked = [];
      const service = new GamePlatformSessionService(db, {}, undefined, { revokeSessions: (...args) => revoked.push(args) });
      const result = await service.completeOidcCallback({ state: 'state-1', error: 'access_denied', errorDescription: MESSAGE, policyCode: DENIED, browserState: native ? undefined : 'state-1' });
      assert.equal(result.error, MESSAGE);
      assert.equal(result.invalidatedSessionId, undefined);
      if (native) {
        await assert.rejects(() => service.completeOidcLogin('tx-1', proof), (error) => {
          policyError()(error);
          assert.equal(error.getResponse().sessionInvalidated, false);
          return true;
        });
      }
      assert.deepEqual(db.deleted, []);
      assert.deepEqual(revoked, []);
      assert.equal((await service.requireSession('session-1')).id, 'session-1');
    }
  }
});

test('failed new Kakao browser callback preserves a permitted session cookie', async () => {
  const db = new Db(account('google'));
  db.transaction = { ...transaction(), return_uri: 'http://localhost:3035/replay', login_proof_hash: null };
  const controller = new SessionController(new GamePlatformSessionService(db, {}));
  const cleared = [];
  const response = { clearCookie: (...args) => cleared.push(args), redirect() {} };
  const request = { headers: { cookie: 'game_platform_session=session-1; game_platform_session_oidc_state=state-1' } };
  await controller.oidcCallback(undefined, 'state-1', 'access_denied', MESSAGE, DENIED, undefined, request, response);
  assert.deepEqual(db.deleted, []);
  assert.equal(cleared.some(([name]) => name === 'game_platform_session'), false);
});

test('failed new login does not refresh or remove a known permitted session near token expiry', async () => {
  const db = new Db(account('google'));
  db.row.access_token_expires_at = new Date(Date.now() + 60_000);
  db.transaction = transaction();
  const service = new GamePlatformSessionService(db, {});
  const previous = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('failed switch must not refresh a known permitted current session');
  try {
    await service.completeOidcCallback({ state: 'state-1', error: 'access_denied', errorDescription: MESSAGE, policyCode: DENIED });
    await assert.rejects(() => service.completeOidcLogin('tx-1', proof), (error) => {
      assert.equal(error.getResponse().sessionInvalidated, false);
      return true;
    });
    assert.deepEqual(db.deleted, []);
  } finally { globalThis.fetch = previous; }
});

test('existing presence timer revalidates sessions without adding an independent Auth poller', async () => {
  const previous = globalThis.setInterval;
  const callbacks = [];
  globalThis.setInterval = (callback) => { callbacks.push(callback); return { unref() {} }; };
  try {
    let validations = 0;
    const realtime = new RealtimeService({ async connect() { return false; }, async refresh() {} });
    realtime.registerSocketConnection('account-1', 'connection-1', async () => { validations++; });
    assert.equal(callbacks.length, 1);
    callbacks[0]();
    assert.equal(validations, 1);
  } finally { globalThis.setInterval = previous; }
});

test('presence timer disconnects only the rejected session even after another instance removed its row', async () => {
  const previous = globalThis.setInterval;
  const callbacks = [];
  globalThis.setInterval = (callback) => { callbacks.push(callback); return { unref() {} }; };
  try {
    const events = [];
    const realtime = new RealtimeService({ async connect() { return false; }, async refresh() {} });
    realtime.attachSocketServer({ to: (room) => ({ emit: (event, payload) => events.push({ room, event, payload }) }), in: (room) => ({ disconnectSockets: () => events.push({ room, disconnected: true }) }) });
    realtime.registerSocketConnection('account-1', 'connection-1', async () => { throw { status: 401, getResponse: () => ({ code: 'SESSION_EXPIRED', message: 'expired' }) }; }, 'session-1');
    callbacks[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.some((event) => event.disconnected));
    assert.ok(events.every((event) => event.room === 'app-session:session-1'));
  } finally { globalThis.setInterval = previous; }
});

test('policy webhook refresh reports scoped policy rejection separately from generic revocation', async () => {
  const db = new Db(account());
  db.query = async function (sql, args = []) {
    if (sql.includes('FROM app_sessions') && sql.includes('account_id')) return { rows: [this.row] };
    if (sql.includes('DELETE FROM app_sessions')) this.deleted.push(args[0]);
    return { rows: [] };
  };
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: DENIED, error: 'access_denied', error_description: MESSAGE }), { status: 403 });
  try {
    const result = await new GamePlatformSessionService(db, {}).refreshAccountSessions('account-1');
    assert.deepEqual(result.policyRejectedSessionIds, ['session-1']);
    assert.deepEqual(result.rejectedSessionIds, ['session-1']);
  } finally { globalThis.fetch = previous; }
});

test('socket action revalidates its RP session instead of trusting the cached account', async () => {
  const calls = [];
  const gateway = new RealtimeGateway({ async requireSession(id) { calls.push(id); throw { status: 401, getResponse: () => ({ code: 'SESSION_AUTH_METHOD_DENIED', message: MESSAGE }) }; } }, {}, { async enqueueCrazyArcadeSocketInput() { assert.fail('blocked action processed'); } });
  const socket = { data: { accountId: 'account-1', account: account(), gameSessionId: 'session-1' }, emit: (...args) => calls.push(args), disconnect: () => calls.push('disconnected') };
  const result = await gateway.handleCrazyArcadeInput(socket, { sessionId: 'game-1', input: {} });
  assert.equal(calls[0], 'session-1');
  assert.equal(result.code, 'SESSION_AUTH_METHOD_DENIED');
  assert.equal(result.message, MESSAGE);
  assert.ok(calls.includes('disconnected'));
});

test('replay preserves policy descriptions but keeps generic non-policy 401 behavior', async () => {
  const script = REPLAY_VIEW_HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const kind of ['direct', 'callback', 'generic', 'permitted']) {
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, { classList: { add() {}, remove() {} }, addEventListener() {}, innerHTML: '', textContent: '', value: '' });
      return elements.get(id);
    };
    const query = kind === 'callback' || kind === 'permitted' ? new URLSearchParams({ status: 'error', errorCode: DENIED, error: MESSAGE }).toString() : '';
    const body = kind === 'direct' ? { code: 'SESSION_AUTH_METHOD_DENIED', message: MESSAGE } : { code: 'AUTH_REQUIRED', message: 'generic' };
    vm.runInNewContext(script, { document: { getElementById: element }, location: { search: query ? `?${query}` : '', origin: 'http://localhost:3035' }, URLSearchParams, fetch: async () => ({ status: kind === 'permitted' ? 200 : 401, json: async () => body }), setTimeout });
    await new Promise((resolve) => setImmediate(resolve));
    if (kind === 'permitted') assert.equal(element('auth-attempt-message').textContent, MESSAGE);
    else if (kind === 'generic') assert.notEqual(element('login-message').textContent, MESSAGE);
    else assert.equal(element('login-message').textContent, MESSAGE);
  }
});

function transaction() {
  return { id: 'tx-1', state: 'state-1', verifier: 'pkce', code_challenge: 'challenge', return_uri: 'gameplatform://auth/callback', status: 'pending', session_id: null, error_code: null, error: null, expires_at: new Date(Date.now() + 300000), login_proof_hash: hash(proof), previous_session_id: 'session-1' };
}

class Db {
  deleted = [];
  transaction;
  constructor(user = account()) {
    this.row = { id: 'session-1', account_id: 'account-1', user_json: user, access_token: 'old-access', refresh_token: 'refresh-1', access_token_expires_at: new Date(Date.now() + 3600000), created_at: new Date(), last_seen_at: new Date(), expires_at: new Date(Date.now() + 86400000) };
  }
  async one(sql, args) {
    if (sql.includes('login_transactions')) return this.transaction;
    if (sql.includes('app_sessions') && !this.deleted.includes(args[0])) return { ...this.row };
  }
  async query(sql, args = []) {
    if (sql.includes('DELETE FROM app_sessions')) this.deleted.push(args[0]);
    if (sql.includes('UPDATE app_sessions') && sql.includes('refresh_token')) Object.assign(this.row, { user_json: JSON.parse(args[1]), access_token: args[2], refresh_token: args[3], access_token_expires_at: new Date(args[4]) });
    if (sql.includes('UPDATE login_transactions') && sql.includes("status = 'failed'")) Object.assign(this.transaction, { status: 'failed', error_code: args[1], error: args[2] });
    return { rows: [] };
  }
  async withAdvisoryLock(_key, callback) { return callback(this); }
}
