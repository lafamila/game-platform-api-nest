import { BadRequestException, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { env, intEnv, listEnv } from '../config/env';
import { AuthService } from './auth.service';
import { AuthAccount, GamePlatformSession, LoginTransaction } from './auth.types';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

type ReadinessStatus = 'ok' | 'down';

interface ReadinessProbe {
  status: ReadinessStatus;
  latencyMs: number;
  url?: string;
  httpStatus?: number;
  error?: string;
}

interface DiscoveryReadinessProbe extends ReadinessProbe {
  issuer?: string;
  jwksUri?: string;
}

export interface LoginReadinessResponse {
  status: ReadinessStatus;
  checkedAt: string;
  gameApi: {
    status: ReadinessStatus;
    database: ReadinessProbe;
  };
  authServer: {
    status: ReadinessStatus;
    discovery: DiscoveryReadinessProbe;
    jwks: ReadinessProbe;
  };
}

/** 400/401/403 만 refresh token 영구 무효로 취급(D2 보류 전제). 그 외는 일시 장애. */
const PERMANENT_AUTH_REJECT_STATUSES = new Set([400, 401, 403]);
/** 일시 장애 시 refresh 재시도 대기(root §1.3-(1) — 0.5s 1회). */
const REFRESH_RETRY_DELAY_MS = 500;

/** auth 가 refresh 를 영구 거절(400/401/403)했을 때. */
class AuthRejectedError extends Error {}
/** auth 가 일시적으로 불가(5xx·네트워크·JWKS 미로딩)일 때. */
class AuthUnavailableError extends Error {}

@Injectable()
export class GamePlatformSessionService {
  private readonly refreshLocks = new Map<string, Promise<GamePlatformSession>>();
  private readonly logger = new Logger(GamePlatformSessionService.name);

  /**
   * 세션 끊김 원인 배분을 위한 계측(원칙: root §1.1). 세션 삭제/refresh 실패 사유를
   * 원인 코드로 서버 로그에 남긴다. 클라이언트 측 SSE 재연결/refresh 실패는
   * `POST /api/client-errors` 로 수집되어 `client_error_reports` 에 적재된다.
   */
  private logSessionEvent(event: 'deleted' | 'refresh_failed', reason: string, sessionId: string): void {
    this.logger.warn(`session ${event} reason=${reason} session=${sessionId}`);
  }

  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}

  async loginReadiness(): Promise<LoginReadinessResponse> {
    const authBaseUrl = env('AUTH_API_BASE_URL', 'http://localhost:3032');
    const discoveryUrl = new URL('/.well-known/openid-configuration', authBaseUrl).toString();
    const [database, discoveryResult] = await Promise.all([
      this.checkDatabaseReadiness(),
      fetchJsonWithTimeout(discoveryUrl, 2500),
    ]);
    const discovery = this.discoveryProbe(discoveryResult);
    const configuredJwksUrl = process.env.AUTH_JWKS_URL?.trim();
    const jwksUrl = configuredJwksUrl && configuredJwksUrl.length > 0
      ? configuredJwksUrl
      : discovery.jwksUri ?? new URL('/oauth/jwks', authBaseUrl).toString();
    const jwks = await fetchJsonWithTimeout(jwksUrl, 2500);
    const gameReady = database.status === 'ok';
    const authReady = discovery.status === 'ok' && jwks.status === 'ok';
    return {
      status: gameReady && authReady ? 'ok' : 'down',
      checkedAt: new Date().toISOString(),
      gameApi: {
        status: gameReady ? 'ok' : 'down',
        database,
      },
      authServer: {
        status: authReady ? 'ok' : 'down',
        discovery,
        jwks,
      },
    };
  }

  async startOidcLogin(input: { returnUri?: string }): Promise<{ authorizeUrl: string; loginTransactionId: string; expiresAt: string }> {
    const verifier = randomToken(48);
    const transaction: LoginTransaction = {
      id: randomToken(32),
      state: randomToken(32),
      verifier,
      codeChallenge: pkceChallenge(verifier),
      returnUri: this.normalizeReturnUri(input.returnUri),
      expiresAt: Date.now() + 5 * 60 * 1000,
      status: 'pending',
    };
    await this.db.query(
      `INSERT INTO login_transactions
       (id, state, verifier, code_challenge, return_uri, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))`,
      [
        transaction.id,
        transaction.state,
        transaction.verifier,
        transaction.codeChallenge,
        transaction.returnUri ?? null,
        transaction.status,
        transaction.expiresAt,
      ],
    );
    return {
      authorizeUrl: this.buildAuthorizeUrl(transaction),
      loginTransactionId: transaction.id,
      expiresAt: new Date(transaction.expiresAt).toISOString(),
    };
  }

  async completeOidcCallback(input: {
    code?: string;
    state?: string;
    error?: string;
    errorDescription?: string;
  }): Promise<{ loginTransactionId?: string; redirectUri?: string; session?: GamePlatformSession; errorCode?: string; error?: string }> {
    const transaction = await this.findTransactionByState(input.state);
    if (!transaction) {
      return { errorCode: 'invalid_state', error: 'Invalid or expired login state' };
    }
    if (transaction.status === 'completed' && transaction.sessionId) {
      return {
        loginTransactionId: transaction.id,
        redirectUri: this.returnUriWithResult(transaction, 'success'),
        session: await this.requireSession(transaction.sessionId),
      };
    }
    if (transaction.status !== 'pending') {
      return { errorCode: 'invalid_state', error: 'Invalid or expired login state' };
    }
    if (input.error) {
      await this.markTransactionFailed(transaction.id, input.error, input.errorDescription ?? input.error);
      return {
        loginTransactionId: transaction.id,
        redirectUri: this.returnUriWithResult(transaction, 'error', input.error, input.errorDescription ?? input.error),
        errorCode: input.error,
        error: input.errorDescription ?? input.error,
      };
    }
    if (!input.code) {
      await this.markTransactionFailed(transaction.id, 'authorization_code_missing', 'Authorization code missing');
      return {
        loginTransactionId: transaction.id,
        redirectUri: this.returnUriWithResult(transaction, 'error', 'authorization_code_missing', 'Authorization code missing'),
        errorCode: 'authorization_code_missing',
        error: 'Authorization code missing',
      };
    }

    try {
      const token = await this.requestToken({
        grant_type: 'authorization_code',
        client_id: env('GAME_PLATFORM_OIDC_CLIENT_ID', 'game-platform-api'),
        client_secret: env('GAME_PLATFORM_OIDC_CLIENT_SECRET'),
        redirect_uri: env('GAME_PLATFORM_OIDC_REDIRECT_URI', 'http://localhost:3035/api/session/oidc/callback'),
        code: input.code,
        code_verifier: transaction.verifier,
      });
      const session = await this.createSession(token);
      await this.db.query(
        `UPDATE login_transactions
         SET status = 'completed', session_id = $2, updated_at = now()
         WHERE id = $1`,
        [transaction.id, session.id],
      );
      return {
        loginTransactionId: transaction.id,
        redirectUri: this.returnUriWithResult(transaction, 'success'),
        session,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      await this.markTransactionFailed(transaction.id, 'login_failed', message);
      return {
        loginTransactionId: transaction.id,
        redirectUri: this.returnUriWithResult(transaction, 'error', 'login_failed', message),
        errorCode: 'login_failed',
        error: message,
      };
    }
  }

  async completeOidcLogin(loginTransactionId: string): Promise<GamePlatformSession> {
    const row = await this.db.one<{
      id: string;
      status: string;
      session_id: string | null;
      error: string | null;
      expires_at: Date;
    }>(
      `SELECT id, status, session_id, error, expires_at
       FROM login_transactions
       WHERE id = $1`,
      [loginTransactionId],
    );
    if (!row || row.expires_at.getTime() <= Date.now()) {
      throw new UnauthorizedException('Login transaction expired');
    }
    if (row.status === 'failed') {
      throw new UnauthorizedException(row.error ?? 'Login failed');
    }
    if (row.status !== 'completed' || !row.session_id) {
      throw new UnauthorizedException('Login transaction is not complete');
    }
    const session = await this.requireSession(row.session_id);
    await this.db.query(`UPDATE login_transactions SET status = 'consumed', updated_at = now() WHERE id = $1`, [row.id]);
    return session;
  }

  async requireSession(sessionId: string | undefined): Promise<GamePlatformSession> {
    if (!sessionId) {
      throw new UnauthorizedException('Game-platform session is required');
    }
    const row = await this.db.one<{
      id: string;
      user_json: AuthAccount;
      access_token: string;
      refresh_token: string;
      access_token_expires_at: Date;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
    }>(
      `SELECT id, user_json, access_token, refresh_token, access_token_expires_at, created_at, last_seen_at, expires_at
       FROM app_sessions
       WHERE id = $1`,
      [sessionId],
    );
    if (!row || row.expires_at.getTime() <= Date.now()) {
      if (row) {
        await this.db.query(`DELETE FROM app_sessions WHERE id = $1`, [sessionId]);
        this.logSessionEvent('deleted', 'session_expired', sessionId);
      } else {
        this.logSessionEvent('deleted', 'session_missing', sessionId);
      }
      throw new UnauthorizedException('Game-platform session expired');
    }
    let session = rowToSession(row);
    if (session.accessTokenExpiresAt - Date.now() <= 30_000) {
      session = await this.refreshSessionLocked(session);
    }
    await this.db.query(`UPDATE app_sessions SET last_seen_at = now() WHERE id = $1`, [session.id]);
    return session;
  }

  async requireTokenOrSession(input: { bearerToken?: string; sessionId?: string }): Promise<GamePlatformSession> {
    if (input.sessionId) {
      return this.requireSession(input.sessionId);
    }
    if (input.bearerToken) {
      const account = await this.auth.verifyBearerToken(input.bearerToken);
      const now = Date.now();
      return {
        id: `bearer:${account.accountId}`,
        account,
        accessToken: input.bearerToken,
        refreshToken: '',
        accessTokenExpiresAt: now + 15 * 60 * 1000,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 15 * 60 * 1000,
      };
    }
    throw new UnauthorizedException('Game-platform session is required');
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      return;
    }
    const session = await this.requireSession(sessionId).catch(() => undefined);
    await this.db.query(`DELETE FROM app_sessions WHERE id = $1`, [sessionId]);
    if (session?.refreshToken) {
      await fetch(`${env('AUTH_API_BASE_URL', 'http://localhost:3032')}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: session.refreshToken }),
      }).catch(() => undefined);
    }
  }

  async refreshSessionNow(session: GamePlatformSession | undefined): Promise<GamePlatformSession> {
    if (!session?.refreshToken) {
      throw new UnauthorizedException('Refreshable game-platform session is required');
    }
    return this.refreshSessionLocked(session);
  }

  private buildAuthorizeUrl(transaction: LoginTransaction): string {
    const url = new URL('/oauth/authorize', env('AUTH_API_BASE_URL', 'http://localhost:3032'));
    url.searchParams.set('client_id', env('GAME_PLATFORM_OIDC_CLIENT_ID', 'game-platform-api'));
    url.searchParams.set('redirect_uri', env('GAME_PLATFORM_OIDC_REDIRECT_URI', 'http://localhost:3035/api/session/oidc/callback'));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email service.permission');
    url.searchParams.set('state', transaction.state);
    url.searchParams.set('code_challenge', transaction.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  private async findTransactionByState(state: string | undefined): Promise<LoginTransaction | undefined> {
    if (!state) {
      return undefined;
    }
    const row = await this.db.one<{
      id: string;
      state: string;
      verifier: string;
      code_challenge: string;
      return_uri: string | null;
      status: LoginTransaction['status'];
      session_id: string | null;
      error_code: string | null;
      error: string | null;
      expires_at: Date;
    }>(
      `SELECT id, state, verifier, code_challenge, return_uri, status, session_id, error_code, error, expires_at
       FROM login_transactions
       WHERE state = $1`,
      [state],
    );
    if (!row || row.expires_at.getTime() <= Date.now()) {
      return undefined;
    }
    return {
      id: row.id,
      state: row.state,
      verifier: row.verifier,
      codeChallenge: row.code_challenge,
      returnUri: row.return_uri ?? undefined,
      expiresAt: row.expires_at.getTime(),
      status: row.status,
      sessionId: row.session_id ?? undefined,
      errorCode: row.error_code ?? undefined,
      error: row.error ?? undefined,
    };
  }

  private async requestToken(body: Record<string, string | undefined>): Promise<TokenResponse> {
    const clean = Object.fromEntries(Object.entries(body).filter(([, value]) => typeof value !== 'undefined'));
    let response: Response;
    try {
      response = await fetch(`${env('AUTH_API_BASE_URL', 'http://localhost:3032')}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clean),
      });
    } catch (error) {
      // 네트워크 실패(connection refused / DNS / abort) = 일시 장애
      throw new AuthUnavailableError(errorMessage(error, 'Token exchange failed'));
    }
    if (!response.ok) {
      const message = await responseText(response, 'Token exchange failed');
      // 400/401/403 = 영구 거절(refresh token 무효), 그 외(5xx·429 등) = 일시 장애
      if (PERMANENT_AUTH_REJECT_STATUSES.has(response.status)) {
        throw new AuthRejectedError(message);
      }
      throw new AuthUnavailableError(message);
    }
    return (await response.json()) as TokenResponse;
  }

  private async createSession(token: TokenResponse): Promise<GamePlatformSession> {
    if (!token.access_token || !token.refresh_token || !token.expires_in) {
      throw new UnauthorizedException('Invalid token response');
    }
    const account = await this.auth.verifyBearerToken(token.access_token);
    const now = Date.now();
    const maxAgeMs = intEnv('GAME_PLATFORM_SESSION_MAX_AGE_SECONDS', 604800) * 1000;
    const session: GamePlatformSession = {
      id: randomToken(32),
      account,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: now + token.expires_in * 1000,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + maxAgeMs,
    };
    await this.db.query(
      `INSERT INTO app_sessions
       (id, account_id, user_json, access_token, refresh_token, access_token_expires_at, created_at, last_seen_at, expires_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0))`,
      [
        session.id,
        session.account.accountId,
        JSON.stringify(session.account),
        session.accessToken,
        session.refreshToken,
        session.accessTokenExpiresAt,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
      ],
    );
    return session;
  }

  private async refreshSession(session: GamePlatformSession): Promise<GamePlatformSession> {
    const token = await this.requestToken({
      grant_type: 'refresh_token',
      client_id: env('GAME_PLATFORM_OIDC_CLIENT_ID', 'game-platform-api'),
      client_secret: env('GAME_PLATFORM_OIDC_CLIENT_SECRET'),
      refresh_token: session.refreshToken,
    });
    if (!token.access_token || !token.refresh_token || !token.expires_in) {
      // 2xx 이지만 형식 이상: 명확한 거절이 아니므로 일시 장애로 취급(로그아웃 승격 방지)
      throw new AuthUnavailableError('Invalid refresh token response');
    }
    let account: AuthAccount;
    try {
      account = await this.auth.verifyBearerToken(token.access_token);
    } catch (error) {
      // refresh 직후 JWKS 미로딩/검증 실패(auth 재기동 중) = 일시 장애 (root §1.1-7)
      throw new AuthUnavailableError(errorMessage(error, 'Invalid refresh token response'));
    }
    const now = Date.now();
    const refreshed: GamePlatformSession = {
      ...session,
      account,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      accessTokenExpiresAt: now + token.expires_in * 1000,
      lastSeenAt: now,
    };
    await this.db.query(
      `UPDATE app_sessions
       SET user_json = $2::jsonb,
           access_token = $3,
           refresh_token = $4,
           access_token_expires_at = to_timestamp($5 / 1000.0),
           last_seen_at = now(),
           expires_at = to_timestamp($6 / 1000.0)
       WHERE id = $1`,
      [
        session.id,
        JSON.stringify(refreshed.account),
        refreshed.accessToken,
        refreshed.refreshToken,
        refreshed.accessTokenExpiresAt,
        refreshed.expiresAt,
      ],
    );
    return refreshed;
  }

  private refreshSessionLocked(session: GamePlatformSession): Promise<GamePlatformSession> {
    const existing = this.refreshLocks.get(session.id);
    if (existing) {
      return existing;
    }
    const refresh = this.refreshWithClassification(session).finally(() => {
      this.refreshLocks.delete(session.id);
    });
    this.refreshLocks.set(session.id, refresh);
    return refresh;
  }

  /**
   * refresh 실패 3분류 (root §1.3-(1)):
   *  - AuthRejectedError(400/401/403) → refresh token 영구 무효 → 세션 DELETE + 401
   *  - AuthUnavailableError(5xx·네트워크·JWKS 미로딩) → 일시 장애 →
   *      0.5s 후 1회 재시도, 그래도 실패면 기존 access token 이 유효하면 soft-fail(세션 유지),
   *      만료 상태면 503 AUTH_UPSTREAM_UNAVAILABLE (세션은 삭제하지 않는다)
   */
  private async refreshWithClassification(session: GamePlatformSession): Promise<GamePlatformSession> {
    try {
      return await this.refreshSession(session);
    } catch (error) {
      if (error instanceof AuthRejectedError) {
        return this.deleteRejectedSession(session);
      }
      if (!(error instanceof AuthUnavailableError)) {
        // 예기치 못한 오류 — 세션은 유지하고 원본 오류를 전파
        this.logSessionEvent('refresh_failed', 'refresh_error', session.id);
        throw error;
      }
      this.logSessionEvent('refresh_failed', 'auth_unavailable', session.id);
      await wait(REFRESH_RETRY_DELAY_MS);
      try {
        return await this.refreshSession(session);
      } catch (retryError) {
        if (retryError instanceof AuthRejectedError) {
          return this.deleteRejectedSession(session);
        }
        if (session.accessTokenExpiresAt > Date.now()) {
          // 기존 access token 이 아직 유효 → soft-fail 로 서비스 지속
          this.logSessionEvent('refresh_failed', 'auth_unavailable_softfail', session.id);
          return session;
        }
        this.logSessionEvent('refresh_failed', 'auth_unavailable_expired', session.id);
        throw authUpstreamUnavailable('Authentication service is temporarily unavailable. Please retry.');
      }
    }
  }

  private async deleteRejectedSession(session: GamePlatformSession): Promise<never> {
    await this.db.query(`DELETE FROM app_sessions WHERE id = $1`, [session.id]);
    this.logSessionEvent('deleted', 'refresh_rejected', session.id);
    throw sessionUnauthorized('SESSION_EXPIRED', 'Game-platform session expired. Please login again');
  }

  private async markTransactionFailed(id: string, errorCode: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE login_transactions SET status = 'failed', error_code = $2, error = $3, updated_at = now() WHERE id = $1`,
      [id, errorCode, error],
    );
  }

  private normalizeReturnUri(returnUri: string | undefined): string | undefined {
    if (!returnUri) {
      return undefined;
    }
    let parsed: URL;
    try {
      parsed = new URL(returnUri);
    } catch {
      throw new BadRequestException('returnUri must be a valid URL');
    }
    if (parsed.protocol === 'gameplatform:') {
      return parsed.toString();
    }
    const allowedOrigins = new Set([
      env('GAME_PLATFORM_PUBLIC_BASE_URL', 'http://localhost:3035'),
      ...listEnv('GAME_PLATFORM_ALLOWED_RETURN_ORIGINS', 'http://localhost:3035'),
    ].map((value) => new URL(value).origin));
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && allowedOrigins.has(parsed.origin)) {
      return parsed.toString();
    }
    throw new BadRequestException('returnUri is not allowed');
  }

  private async checkDatabaseReadiness(): Promise<ReadinessProbe> {
    const startedAt = Date.now();
    try {
      await withTimeout(this.db.query('SELECT 1'), 1500, 'Database readiness check timed out');
      return {
        status: 'ok',
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: errorMessage(error, 'Database readiness check failed'),
      };
    }
  }

  private discoveryProbe(result: JsonReadinessProbe): DiscoveryReadinessProbe {
    const issuer = typeof result.body?.issuer === 'string' ? result.body.issuer : undefined;
    const jwksUri = typeof result.body?.jwks_uri === 'string' ? result.body.jwks_uri : undefined;
    return {
      status: result.status,
      latencyMs: result.latencyMs,
      url: result.url,
      httpStatus: result.httpStatus,
      error: result.error,
      issuer,
      jwksUri,
    };
  }

  private returnUriWithResult(transaction: LoginTransaction, status: 'success' | 'error', errorCode?: string, error?: string): string | undefined {
    if (!transaction.returnUri) {
      return undefined;
    }
    const url = new URL(transaction.returnUri);
    url.searchParams.set('loginTransactionId', transaction.id);
    url.searchParams.set('status', status);
    if (errorCode) {
      url.searchParams.set('errorCode', errorCode);
    }
    if (error) {
      url.searchParams.set('error', error);
    }
    return url.toString();
  }
}

export function sessionResponse(session: GamePlatformSession) {
  return {
    sessionId: session.id,
    user: session.account,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function rowToSession(row: {
  id: string;
  user_json: AuthAccount;
  access_token: string;
  refresh_token: string;
  access_token_expires_at: Date;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}): GamePlatformSession {
  return {
    id: row.id,
    account: row.user_json,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessTokenExpiresAt: row.access_token_expires_at.getTime(),
    createdAt: row.created_at.getTime(),
    lastSeenAt: row.last_seen_at.getTime(),
    expiresAt: row.expires_at.getTime(),
  };
}

function randomToken(byteLength: number): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * 인증 실패 응답 code 계약(root §1.3-(5)). 메시지 문자열은 하위호환을 위해 유지하고
 * `code` 필드만 추가한다. NestJS 는 HttpException 에 객체를 넘기면 그대로 응답 body 로 직렬화한다.
 */
export type SessionErrorCode =
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALID'
  | 'AUTH_REQUIRED'
  | 'AUTH_UPSTREAM_UNAVAILABLE';

export function sessionUnauthorized(
  code: 'SESSION_EXPIRED' | 'SESSION_INVALID' | 'AUTH_REQUIRED',
  message: string,
): UnauthorizedException {
  return new UnauthorizedException({ statusCode: 401, code, message, error: 'Unauthorized' });
}

export function authUpstreamUnavailable(message: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    code: 'AUTH_UPSTREAM_UNAVAILABLE' satisfies SessionErrorCode,
    message,
    error: 'Service Unavailable',
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

interface JsonReadinessProbe extends ReadinessProbe {
  url: string;
  body?: Record<string, unknown>;
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<JsonReadinessProbe> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseJsonObject(text);
    return {
      status: response.ok ? 'ok' : 'down',
      url,
      httpStatus: response.status,
      latencyMs: Date.now() - startedAt,
      error: response.ok ? undefined : readinessErrorMessage(body, `HTTP ${response.status}`),
      body,
    };
  } catch (error) {
    return {
      status: 'down',
      url,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error, 'Request failed'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(text) as unknown;
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function readinessErrorMessage(body: Record<string, unknown> | undefined, fallback: string): string {
  const message = body?.message ?? body?.detail ?? body?.error_description ?? body?.error;
  return typeof message === 'string' && message.trim().length > 0 ? message : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

async function responseText(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; message?: string; error_description?: string };
    return body.detail ?? body.message ?? body.error_description ?? fallback;
  } catch {
    return fallback;
  }
}
