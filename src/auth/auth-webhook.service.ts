import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { env, intEnv } from '../config/env';
import { DatabaseQueryExecutor, DatabaseService } from '../database/database.service';
import { RealtimeService } from '../realtime/realtime.service';
import { GamePlatformSessionService } from './session.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/i;
const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;

interface AuthWebhookBase {
  id: string;
  occurredAt: string;
  serviceKey: string;
  accountId: string;
}

export interface AuthPermissionUpdatedWebhook extends AuthWebhookBase {
  type: 'permission.updated';
  data: {
    permission: string | null;
    previousPermission: string | null;
    status: 'active' | 'revoked';
    reason: 'approved' | 'changed' | 'revoked';
  };
}

export interface AuthServiceApplicationRejectedWebhook extends AuthWebhookBase {
  type: 'service_application.rejected';
  data: {
    applicationId: string;
    status: 'rejected';
    requestedPermission: string | null;
  };
}

export type AuthWebhookEvent = AuthPermissionUpdatedWebhook | AuthServiceApplicationRejectedWebhook;

interface StoredWebhookRow {
  event_type: string;
  service_key: string;
  account_id: string;
  payload_json: unknown;
  processed_at: Date | null;
}

@Injectable()
export class AuthWebhookService {
  constructor(
    private readonly db: DatabaseService,
    private readonly sessions: GamePlatformSessionService,
    private readonly realtime: RealtimeService,
  ) {}

  async handle(input: {
    rawBody: Buffer | undefined;
    body: unknown;
    eventId: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
  }): Promise<{ ok: true; duplicate: boolean; refreshedSessions: number }> {
    const event = this.verifyAndParse(input);
    await this.db.query(
      `INSERT INTO auth_webhook_events
       (event_id, event_type, service_key, account_id, payload_json)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.id, event.type, event.serviceKey, event.accountId, JSON.stringify(event)],
    );

    return this.db.withAdvisoryLock(`auth-webhook:${event.id}`, async (db) => {
      const stored = await db.one<StoredWebhookRow>(
        `SELECT event_type, service_key, account_id, payload_json, processed_at
         FROM auth_webhook_events
         WHERE event_id = $1::uuid`,
        [event.id],
      );
      if (
        !stored ||
        stored.event_type !== event.type ||
        stored.service_key !== event.serviceKey ||
        stored.account_id !== event.accountId ||
        !isDeepStrictEqual(stored.payload_json, event)
      ) {
        throw new ConflictException('Auth webhook event id was already used for different content');
      }
      if (stored?.processed_at) {
        return { ok: true, duplicate: true, refreshedSessions: 0 };
      }

      await db.query(
        `UPDATE auth_webhook_events
         SET attempts = attempts + 1, last_error = NULL
         WHERE event_id = $1::uuid`,
        [event.id],
      );
      try {
        let refreshedSessions = 0;
        if (event.type === 'service_application.rejected') {
          this.realtime.emitToAccounts([event.accountId], event.type, {
            eventId: event.id,
            accountId: event.accountId,
            data: event.data,
            updatedAt: new Date().toISOString(),
          });
        } else {
          const result = await this.sessions.refreshAccountSessions(event.accountId);
          refreshedSessions = result.refreshed.length;
          const account = result.refreshed.at(-1)?.account;
          if (result.refreshed.length === 0 && (event.data.status === 'revoked' || result.rejectedSessionIds.length > 0)) {
            this.realtime.revokeAccount(event.accountId, {
              eventId: event.id,
              accountId: event.accountId,
              reason: 'permission_revoked',
            });
          } else {
            if (result.rejectedSessionIds.length > 0) {
              this.realtime.revokeSessions(event.accountId, result.rejectedSessionIds, {
                eventId: event.id,
                accountId: event.accountId,
                reason: 'permission_revoked',
              });
            }
            this.realtime.emitToAccounts([event.accountId], 'permission.updated', {
              eventId: event.id,
              accountId: event.accountId,
              ...(account ? { user: account, permission: account.permission } : {}),
              updatedAt: new Date().toISOString(),
            });
          }
        }
        await db.query(
          `UPDATE auth_webhook_events
           SET processed_at = now(), last_error = NULL
           WHERE event_id = $1::uuid`,
          [event.id],
        );
        return { ok: true, duplicate: false, refreshedSessions };
      } catch (error) {
        await this.recordFailure(db, event.id, error);
        throw error;
      }
    });
  }

  private verifyAndParse(input: {
    rawBody: Buffer | undefined;
    body: unknown;
    eventId: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
  }): AuthWebhookEvent {
    if (!input.rawBody) {
      throw new BadRequestException('Raw webhook body is required');
    }
    const secret = process.env.AUTH_WEBHOOK_SECRET?.trim();
    if (!secret) {
      throw new ServiceUnavailableException('Auth webhook is not configured');
    }
    if (!input.eventId || !UUID_PATTERN.test(input.eventId)) {
      throw new BadRequestException('Invalid auth webhook event id');
    }
    if (!input.timestamp || !/^\d+$/.test(input.timestamp)) {
      throw new UnauthorizedException('Invalid auth webhook timestamp');
    }
    const timestampSeconds = Number(input.timestamp);
    const toleranceSeconds = intEnv('AUTH_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS', DEFAULT_TIMESTAMP_TOLERANCE_SECONDS);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > toleranceSeconds) {
      throw new UnauthorizedException('Auth webhook timestamp is outside the allowed window');
    }
    const signatureMatch = input.signature?.match(SIGNATURE_PATTERN);
    if (!signatureMatch) {
      throw new UnauthorizedException('Invalid auth webhook signature');
    }
    const expected = createHmac('sha256', secret)
      .update(`${input.timestamp}.`)
      .update(input.rawBody)
      .digest();
    const actual = Buffer.from(signatureMatch[1], 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException('Invalid auth webhook signature');
    }

    if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
      throw new BadRequestException('Invalid auth webhook body');
    }
    const body = input.body as Record<string, unknown>;
    if (body.id !== input.eventId) {
      throw new BadRequestException('Auth webhook event id does not match body');
    }
    if (body.type !== 'permission.updated' && body.type !== 'service_application.rejected') {
      throw new BadRequestException('Unsupported auth webhook event type');
    }
    if (body.serviceKey !== env('AUTH_SERVICE_KEY', 'game-platform')) {
      throw new BadRequestException('Auth webhook service key does not match');
    }
    if (typeof body.accountId !== 'string' || body.accountId.trim().length === 0) {
      throw new BadRequestException('Auth webhook accountId is required');
    }
    if (typeof body.occurredAt !== 'string' || !Number.isFinite(Date.parse(body.occurredAt))) {
      throw new BadRequestException('Auth webhook occurredAt is invalid');
    }
    if (!isRecord(body.data)) {
      throw new BadRequestException('Auth webhook data is required');
    }
    if (body.type === 'permission.updated') {
      if (
        !isNullableString(body.data.permission) ||
        !isNullableString(body.data.previousPermission) ||
        (body.data.status !== 'active' && body.data.status !== 'revoked') ||
        !['approved', 'changed', 'revoked'].includes(String(body.data.reason))
      ) {
        throw new BadRequestException('Invalid permission.updated webhook data');
      }
      return body as unknown as AuthPermissionUpdatedWebhook;
    }
    if (
      typeof body.data.applicationId !== 'string' || !body.data.applicationId ||
      body.data.status !== 'rejected' ||
      !isNullableString(body.data.requestedPermission)
    ) {
      throw new BadRequestException('Invalid service_application.rejected webhook data');
    }
    return body as unknown as AuthServiceApplicationRejectedWebhook;
  }

  private async recordFailure(db: DatabaseQueryExecutor, eventId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Webhook processing failed';
    await db.query(
      `UPDATE auth_webhook_events
       SET last_error = left($2, 1000)
       WHERE event_id = $1::uuid`,
      [eventId, message],
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
