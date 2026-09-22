import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { env, hasEnv, intEnv } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { GamePlatformSession } from '../auth/auth.types';

const DEFAULT_CHAT_TIMEOUT_MS = 3000;

export interface ChatSessionResponse {
  token: string;
  sessionId: string;
  expiresAt: string;
  serviceKey: string;
  account: {
    id: string;
    loginId: string | null;
    name: string | null;
  };
}

interface ChatSessionLinkRow {
  chat_token: string;
  expires_at: Date;
  response_json: unknown;
}

@Injectable()
export class ChatBridgeService {
  private readonly logger = new Logger(ChatBridgeService.name);

  constructor(private readonly db: DatabaseService) {}

  async exchange(session: GamePlatformSession): Promise<ChatSessionResponse> {
    this.baseUrl();
    return this.db.withAdvisoryLock(`chat-session:${session.id}`, async (db) => {
      const appSession = await db.one<{ id: string }>(
        `SELECT id FROM app_sessions WHERE id = $1 AND account_id = $2 AND expires_at > now()`,
        [session.id, session.account.accountId],
      );
      if (!appSession) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          code: 'CHAT_GAME_SESSION_UNAVAILABLE',
          message: 'Game-platform session is no longer available for chat exchange',
          error: 'Service Unavailable',
        });
      }
      const previous = await db.one<ChatSessionLinkRow>(
        `SELECT chat_token, expires_at, response_json
         FROM chat_session_links
         WHERE game_session_id = $1`,
        [session.id],
      );
      const reusable = this.reusableSession(previous, session);
      if (reusable) {
        return reusable;
      }

      const chatSession = await this.exchangeUpstream(session);
      await db.query(
        `INSERT INTO chat_session_links
         (game_session_id, chat_session_id, chat_token, service_key, expires_at, response_json)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
         ON CONFLICT (game_session_id) DO UPDATE
         SET chat_session_id = EXCLUDED.chat_session_id,
             chat_token = EXCLUDED.chat_token,
             service_key = EXCLUDED.service_key,
             expires_at = EXCLUDED.expires_at,
             response_json = EXCLUDED.response_json,
             updated_at = now()`,
        [
          session.id,
          chatSession.sessionId,
          chatSession.token,
          chatSession.serviceKey,
          chatSession.expiresAt,
          JSON.stringify(chatSession),
        ],
      );
      if (previous?.chat_token && previous.chat_token !== chatSession.token) {
        await this.revokeToken(previous.chat_token).catch((error) => {
          this.logger.warn(`failed to revoke replaced chat session: ${errorMessage(error)}`);
        });
      }
      return chatSession;
    });
  }

  async revokeForGameSession(gameSessionId: string, afterRevoke?: () => Promise<void>): Promise<void> {
    await this.db.withAdvisoryLock(`chat-session:${gameSessionId}`, async (db) => {
      const link = await db.one<ChatSessionLinkRow>(
        `SELECT chat_token, expires_at, response_json
         FROM chat_session_links
         WHERE game_session_id = $1`,
        [gameSessionId],
      );
      if (link && hasEnv('CHAT_API_URL')) {
        await this.revokeToken(link.chat_token).catch((error) => {
          this.logger.warn(`failed to revoke chat session for game session ${gameSessionId}: ${errorMessage(error)}`);
        });
      }
      await db.query(`DELETE FROM chat_session_links WHERE game_session_id = $1`, [gameSessionId]);
      await afterRevoke?.();
    });
  }

  private async revokeToken(token: string): Promise<void> {
    await this.withTimeout(async (signal) => {
      const response = await fetch(new URL('/api/session/current', this.baseUrl()), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal,
      });
      if (!response.ok && response.status !== 401 && response.status !== 404) {
        throw chatUpstreamError(response.status);
      }
    });
  }

  private baseUrl(): string {
    if (!hasEnv('CHAT_API_URL')) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'CHAT_INTEGRATION_DISABLED',
        message: 'Chat integration is not configured',
        error: 'Service Unavailable',
      });
    }
    return env('CHAT_API_URL');
  }

  private async exchangeUpstream(session: GamePlatformSession): Promise<ChatSessionResponse> {
    return this.withTimeout(async (signal) => {
      const response = await fetch(new URL('/api/session/exchange', this.baseUrl()), {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
        redirect: 'manual',
        signal,
      });
      if (!response.ok) {
        throw chatUpstreamError(response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw invalidChatResponse();
      }
      return parseChatSession(body, session);
    });
  }

  private reusableSession(link: ChatSessionLinkRow | undefined, session: GamePlatformSession): ChatSessionResponse | undefined {
    if (!link || link.expires_at.getTime() <= Date.now() || link.expires_at.getTime() > sourceAccessExpiresAt(session)) {
      return undefined;
    }
    try {
      return parseChatSession(link.response_json, session);
    } catch {
      return undefined;
    }
  }

  private async withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(chatTimeout());
      }, intEnv('CHAT_API_TIMEOUT_MS', DEFAULT_CHAT_TIMEOUT_MS));
    });
    try {
      return await Promise.race([operation(controller.signal), timeoutFailure]);
    } catch (error) {
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) {
        throw chatTimeout();
      }
      if (error instanceof HttpException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'CHAT_UPSTREAM_UNAVAILABLE',
        message: 'Chat service is temporarily unavailable',
        error: 'Service Unavailable',
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

function parseChatSession(value: unknown, source: GamePlatformSession): ChatSessionResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidChatResponse();
  }
  const body = value as Record<string, unknown>;
  const account = body.account;
  if (
    typeof body.token !== 'string' || !body.token ||
    typeof body.sessionId !== 'string' || !body.sessionId ||
    typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt)) ||
    typeof body.serviceKey !== 'string' || !body.serviceKey ||
    !account || typeof account !== 'object' || Array.isArray(account)
  ) {
    throw invalidChatResponse();
  }
  const accountRecord = account as Record<string, unknown>;
  const expiresAt = Date.parse(body.expiresAt as string);
  if (
    typeof accountRecord.id !== 'string' || !accountRecord.id ||
    !isNullableString(accountRecord.loginId) ||
    !isNullableString(accountRecord.name) ||
    accountRecord.id !== source.account.accountId ||
    body.serviceKey !== env('AUTH_SERVICE_KEY', 'game-platform') ||
    expiresAt <= Date.now() ||
    expiresAt > sourceAccessExpiresAt(source)
  ) {
    throw invalidChatResponse();
  }
  return {
    token: body.token,
    sessionId: body.sessionId,
    expiresAt: body.expiresAt,
    serviceKey: body.serviceKey,
    account: {
      id: accountRecord.id,
      loginId: accountRecord.loginId,
      name: accountRecord.name,
    },
  };
}

function sourceAccessExpiresAt(session: GamePlatformSession): number {
  const claim = session.account.claims.exp;
  const claimExpiry = typeof claim === 'number' && Number.isFinite(claim) ? claim * 1000 : undefined;
  return claimExpiry ? Math.min(claimExpiry, session.accessTokenExpiresAt) : session.accessTokenExpiresAt;
}

function chatTimeout(): GatewayTimeoutException {
  return new GatewayTimeoutException({
    statusCode: 504,
    code: 'CHAT_UPSTREAM_TIMEOUT',
    message: 'Chat service did not respond before the timeout',
    error: 'Gateway Timeout',
  });
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function invalidChatResponse(): BadGatewayException {
  return new BadGatewayException({
    statusCode: 502,
    code: 'CHAT_INVALID_RESPONSE',
    message: 'Chat service returned an invalid session response',
    error: 'Bad Gateway',
  });
}

function chatUpstreamError(status: number): BadGatewayException {
  return new BadGatewayException({
    statusCode: 502,
    code: 'CHAT_EXCHANGE_FAILED',
    message: `Chat service rejected the session exchange (HTTP ${status})`,
    error: 'Bad Gateway',
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
