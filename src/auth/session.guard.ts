import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';
import { env } from '../config/env';
import { RequestWithAuth } from './auth.types';
import { GamePlatformSessionService, sessionUnauthorized } from './session.service';
import { isAuthMethodPolicyError, SESSION_AUTH_METHOD_DENIED } from './auth-method-policy';

@Injectable()
export class GamePlatformSessionGuard implements CanActivate {
  constructor(private readonly sessions: GamePlatformSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & Partial<RequestWithAuth>>();
    let session;
    try {
      session = await this.sessions.requireTokenOrSession({
        bearerToken: this.extractBearerToken(request),
        sessionId: this.extractSessionId(request),
      });
    } catch (error) {
      const response = (error as { getResponse?: () => unknown })?.getResponse?.();
      if (isAuthMethodPolicyError(error) || (typeof response === 'object' && response !== null && (response as { code?: unknown }).code === SESSION_AUTH_METHOD_DENIED)) {
        clearRejectedSessionCookie(context.switchToHttp().getResponse<Response>(), request, this.extractSessionId(request));
      }
      throw error;
    }
    request.authAccount = session.account;
    request.gameSession = session;
    return true;
  }

  extractSessionId(request: Request): string | undefined {
    const header = request.headers['x-game-platform-session'];
    if (typeof header === 'string' && header.trim()) {
      return header.trim();
    }
    return extractSessionCookie(request);
  }

  private extractBearerToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) {
      return undefined;
    }
    const [scheme, token] = header.split(' ', 2);
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw sessionUnauthorized('SESSION_INVALID', 'Invalid authorization header');
    }
    return token.trim();
  }
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(env('GAME_PLATFORM_SESSION_COOKIE_NAME', 'game_platform_session'), { path: '/' });
}

export function clearRejectedSessionCookie(response: Response, request: Request, rejectedId?: string): void {
  if (rejectedId && extractSessionCookie(request) === rejectedId) clearSessionCookie(response);
}

function extractSessionCookie(request: Request): string | undefined {
  const prefix = `${env('GAME_PLATFORM_SESSION_COOKIE_NAME', 'game_platform_session')}=`;
  const cookie = request.headers.cookie?.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : undefined;
}

export function oidcStateCookieName(): string {
  return `${env('GAME_PLATFORM_SESSION_COOKIE_NAME', 'game_platform_session')}_oidc_state`;
}

export function extractOidcState(request: Request): string | undefined {
  const prefix = `${oidcStateCookieName()}=`;
  const cookie = request.headers.cookie?.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : undefined;
}

export function setSessionCookie(response: Response, value: string, maxAgeSeconds: number): void {
  response.cookie(env('GAME_PLATFORM_SESSION_COOKIE_NAME', 'game_platform_session'), value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: maxAgeSeconds * 1000,
    path: '/',
  });
}
