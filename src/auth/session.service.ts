import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
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

@Injectable()
export class GamePlatformSessionService {
  private readonly refreshLocks = new Map<string, Promise<GamePlatformSession>>();

  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
  ) {}

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
    const response = await fetch(`${env('AUTH_API_BASE_URL', 'http://localhost:3032')}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clean),
    });
    if (!response.ok) {
      throw new UnauthorizedException(await responseText(response, 'Token exchange failed'));
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
      throw new UnauthorizedException('Invalid refresh token response');
    }
    const account = await this.auth.verifyBearerToken(token.access_token);
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
    const refresh = this.refreshSession(session).catch(async (error: unknown) => {
      if (error instanceof UnauthorizedException) {
        await this.db.query(`DELETE FROM app_sessions WHERE id = $1`, [session.id]);
        throw new UnauthorizedException('Game-platform session expired. Please login again');
      }
      throw error;
    }).finally(() => {
      this.refreshLocks.delete(session.id);
    });
    this.refreshLocks.set(session.id, refresh);
    return refresh;
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

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function responseText(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; message?: string; error_description?: string };
    return body.detail ?? body.message ?? body.error_description ?? fallback;
  } catch {
    return fallback;
  }
}
