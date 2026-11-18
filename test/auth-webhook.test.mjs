import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';

import { AuthWebhookService } from '../dist/auth/auth-webhook.service.js';

process.env.AUTH_WEBHOOK_SECRET = 'webhook-test-secret';
process.env.AUTH_SERVICE_KEY = 'game-platform';

test('rejects an invalid webhook signature before recording or refreshing', async () => {
  const fixture = createFixture();
  const signed = signedEvent();

  await assert.rejects(
    () => fixture.service.handle({ ...signed, signature: `v1=${'0'.repeat(64)}` }),
    (error) => error.status === 401 && /signature/i.test(error.message),
  );
  assert.equal(fixture.db.events.size, 0);
  assert.deepEqual(fixture.sessions.accounts, []);
});

test('rejects a signed webhook outside the timestamp tolerance', async () => {
  const fixture = createFixture();
  const signed = signedEvent({ timestamp: String(Math.floor(Date.now() / 1000) - 301) });

  await assert.rejects(
    () => fixture.service.handle(signed),
    (error) => error.status === 401 && /timestamp/i.test(error.message),
  );
  assert.equal(fixture.db.events.size, 0);
});

test('deduplicates a processed event and emits refreshed permission data once', async () => {
  const fixture = createFixture();
  const signed = signedEvent({ accountId: 'account-target' });

  const first = await fixture.service.handle(signed);
  const duplicate = await fixture.service.handle(signed);

  assert.deepEqual(first, { ok: true, duplicate: false, refreshedSessions: 2 });
  assert.deepEqual(duplicate, { ok: true, duplicate: true, refreshedSessions: 0 });
  assert.deepEqual(fixture.sessions.accounts, ['account-target'], 'only the event account is refreshed');
  assert.equal(fixture.realtime.events.length, 1);
  assert.equal(fixture.realtime.events[0].event, 'permission.updated');
  assert.deepEqual(fixture.realtime.events[0].accountIds, ['account-target']);
  assert.equal(fixture.realtime.events[0].data.accountId, 'account-target');
  assert.equal(fixture.realtime.events[0].data.permission, 'premium');
  assert.equal(fixture.realtime.events[0].data.user.permission, 'premium');
  assert.equal('accessToken' in fixture.realtime.events[0].data, false);
  assert.equal(fixture.db.events.get(signed.eventId).attempts, 1);
  assert.ok(fixture.db.events.get(signed.eventId).processed_at instanceof Date);
});

test('rejects reuse of an event id with different signed content', async () => {
  const fixture = createFixture({ failRefreshOnce: true });
  const first = signedEvent({ accountId: 'account-1' });
  await assert.rejects(() => fixture.service.handle(first), /temporary auth failure/);
  const conflicting = signedEvent({ eventId: first.eventId, accountId: 'account-2' });

  await assert.rejects(
    () => fixture.service.handle(conflicting),
    (error) => error.status === 409,
  );
  assert.deepEqual(fixture.sessions.accounts, ['account-1']);
});

test('retries a previously failed durable event instead of treating it as processed', async () => {
  const fixture = createFixture({ failRefreshOnce: true });
  const signed = signedEvent();

  await assert.rejects(() => fixture.service.handle(signed), /temporary auth failure/);
  const storedAfterFailure = fixture.db.events.get(signed.eventId);
  assert.equal(storedAfterFailure.processed_at, null);
  assert.match(storedAfterFailure.last_error, /temporary auth failure/);

  const retried = await fixture.service.handle(signed);
  assert.deepEqual(retried, { ok: true, duplicate: false, refreshedSessions: 2 });
  assert.equal(fixture.sessions.accounts.length, 2);
  assert.equal(fixture.db.events.get(signed.eventId).attempts, 2);
  assert.ok(fixture.db.events.get(signed.eventId).processed_at instanceof Date);
});

test('emits session.revoked and disconnects account realtime when current auth rejects every session', async () => {
  const fixture = createFixture({ revokedSessionIds: ['session-1', 'session-2'] });
  const signed = signedEvent({
    data: {
      permission: null,
      previousPermission: 'player',
      status: 'revoked',
      reason: 'revoked',
    },
  });

  const result = await fixture.service.handle(signed);

  assert.deepEqual(result, { ok: true, duplicate: false, refreshedSessions: 0 });
  assert.equal(fixture.realtime.events.length, 1);
  assert.equal(fixture.realtime.events[0].event, 'session.revoked');
  assert.equal(fixture.realtime.events[0].accountId, 'account-1');
});

test('forwards application rejection without rotating active sessions', async () => {
  const fixture = createFixture();
  const signed = signedEvent({
    type: 'service_application.rejected',
    data: {
      applicationId: randomUUID(),
      status: 'rejected',
      requestedPermission: 'player',
    },
  });

  await fixture.service.handle(signed);

  assert.deepEqual(fixture.sessions.accounts, []);
  assert.equal(fixture.realtime.events[0].event, 'service_application.rejected');
});

test('policy rejection never escalates scoped cleanup into an account-wide disconnect', async () => {
  const fixture = createFixture({ revokedSessionIds: ['kakao-session'], policyRejectedSessionIds: ['kakao-session'] });
  await fixture.service.handle(signedEvent());
  assert.equal(fixture.realtime.events.some((event) => event.event === 'session.revoked'), false,
    'the session service already delivered its policy-specific scoped revocation');
  assert.equal(fixture.realtime.events[0].event, 'permission.updated');
});

function signedEvent(overrides = {}) {
  const eventId = overrides.eventId ?? randomUUID();
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const body = {
    id: eventId,
    type: overrides.type ?? 'permission.updated',
    occurredAt: new Date().toISOString(),
    serviceKey: 'game-platform',
    accountId: overrides.accountId ?? 'account-1',
    data: overrides.data ?? {
      permission: 'premium',
      previousPermission: 'player',
      status: 'active',
      reason: 'changed',
    },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const digest = createHmac('sha256', process.env.AUTH_WEBHOOK_SECRET)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  return {
    rawBody,
    body,
    eventId,
    timestamp,
    signature: `v1=${digest}`,
  };
}

function createFixture(options = {}) {
  const db = new FakeWebhookDb();
  const sessions = {
    accounts: [],
    failed: false,
    async refreshAccountSessions(accountId) {
      this.accounts.push(accountId);
      if (options.failRefreshOnce && !this.failed) {
        this.failed = true;
        throw new Error('temporary auth failure');
      }
      const account = {
        accountId,
        subject: accountId,
        serviceKey: 'game-platform',
        permission: 'premium',
        claims: {},
      };
      return {
        refreshed: options.revokedSessionIds ? [] : [
            { id: 'session-1', account },
            { id: 'session-2', account },
          ],
        rejectedSessionIds: options.revokedSessionIds ?? [],
        policyRejectedSessionIds: options.policyRejectedSessionIds,
      };
    },
  };
  const realtime = {
    events: [],
    emitToAccounts(accountIds, event, data) {
      this.events.push({ accountIds, event, data });
    },
    revokeSessions(accountId, sessionIds, data) {
      this.events.push({ accountId, sessionIds, event: 'session.revoked', data });
    },
    revokeAccount(accountId, data) {
      this.events.push({ accountId, event: 'session.revoked', data });
    },
  };
  return {
    db,
    sessions,
    realtime,
    service: new AuthWebhookService(db, sessions, realtime),
  };
}

class FakeWebhookDb {
  events = new Map();

  async query(sql, args = []) {
    if (sql.includes('INSERT INTO auth_webhook_events')) {
      if (!this.events.has(args[0])) {
        this.events.set(args[0], {
          event_type: args[1],
          service_key: args[2],
          account_id: args[3],
          payload_json: JSON.parse(args[4]),
          processed_at: null,
          attempts: 0,
          last_error: null,
        });
      }
      return { rows: [] };
    }
    if (sql.includes('SET attempts = attempts + 1')) {
      const row = this.events.get(args[0]);
      row.attempts += 1;
      row.last_error = null;
      return { rows: [] };
    }
    if (sql.includes('SET processed_at = now()')) {
      const row = this.events.get(args[0]);
      row.processed_at = new Date();
      row.last_error = null;
      return { rows: [] };
    }
    if (sql.includes('SET last_error = left')) {
      this.events.get(args[0]).last_error = args[1];
      return { rows: [] };
    }
    return { rows: [] };
  }

  async one(sql, args = []) {
    if (sql.includes('FROM auth_webhook_events')) {
      return this.events.get(args[0]);
    }
    return undefined;
  }

  async withAdvisoryLock(_key, callback) {
    return callback(this);
  }
}
