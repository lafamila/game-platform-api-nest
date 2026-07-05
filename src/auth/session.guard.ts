import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';
import { env } from '../config/env';
import { RequestWithAuth } from './auth.types';
import { GamePlatformSessionService, sessionUnauthorized } from './session.service';

@Injectable()
export class GamePlatformSessionGuard implements CanActivate {
  constructor(private readonly sessions: GamePlatformSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & Partial<RequestWithAuth>>();
    const session = await this.sessions.requireTokenOrSession({
      bearerToken: this.extractBearerToken(request),
      sessionId: this.extractSessionId(request),
    });
    request.authAccount = session.account;
    request.gameSession = session;
    return true;
  }

  extractSessionId(request: Request): string | undefined {
    const header = request.headers['x-game-platform-session'];
    if (typeof header === 'string' && header.trim()) {
      return header.trim();
    }
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) {
      return undefined;
    }
    const cookieName = env('GAME_PLATFORM_SESSION_COOKIE_NAME', 'game_platform_session');
    const cookie = cookieHeader
      .split(';')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(`${cookieName}=`));
    return cookie ? decodeURIComponent(cookie.split('=', 2)[1] ?? '') : undefined;
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

export function setSessionCookie(response: Response, value: string, maxAgeSeconds: number): void {
  response.cookie(env('GAME_PLATFORM_SESSION_COOKIE_NAME', 'game_platform_session'), value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: maxAgeSeconds * 1000,
    path: '/',
  });
}
