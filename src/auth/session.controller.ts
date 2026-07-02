import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { env, intEnv } from '../config/env';
import { CurrentUser } from './current-user';
import { AuthAccount, RequestWithAuth } from './auth.types';
import { GamePlatformSessionGuard, setSessionCookie } from './session.guard';
import { GamePlatformSessionService, sessionResponse } from './session.service';

@Controller('session')
export class SessionController {
  constructor(private readonly sessions: GamePlatformSessionService) {}

  @Post('oidc/start')
  startOidcLogin(@Body() body: { returnUri?: string }) {
    return this.sessions.startOidcLogin(body);
  }

  @Get('oidc/callback')
  async oidcCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() response: Response,
  ) {
    const result = await this.sessions.completeOidcCallback({ code, state, error, errorDescription });
    if (result.session) {
      setSessionCookie(response, result.session.id, intEnv('GAME_PLATFORM_SESSION_MAX_AGE_SECONDS', 604800));
    }
    if (result.redirectUri) {
      if (result.redirectUri.startsWith('gameplatform:')) {
        response.type('html').send(appRedirectHtml(result.redirectUri, result));
        return;
      }
      response.redirect(result.redirectUri);
      return;
    }
    response.type('html').send(callbackHtml(result));
  }

  @Post('oidc/complete')
  async completeOidcLogin(@Body() body: { loginTransactionId: string }, @Res({ passthrough: true }) response: Response) {
    const session = await this.sessions.completeOidcLogin(body.loginTransactionId);
    setSessionCookie(response, session.id, intEnv('GAME_PLATFORM_SESSION_MAX_AGE_SECONDS', 604800));
    return sessionResponse(session);
  }

  @UseGuards(GamePlatformSessionGuard)
  @Get('me')
  me(@CurrentUser() account: AuthAccount) {
    return account;
  }

  @UseGuards(GamePlatformSessionGuard)
  @Post('refresh')
  async refresh(
    @Req() request: Request & Partial<RequestWithAuth>,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.sessions.refreshSessionNow(request.gameSession);
    setSessionCookie(response, session.id, intEnv('GAME_PLATFORM_SESSION_MAX_AGE_SECONDS', 604800));
    return sessionResponse(session);
  }

  @Post('logout')
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const guard = new GamePlatformSessionGuard(this.sessions);
    await this.sessions.logout(guard.extractSessionId(request));
    response.clearCookie(env('GAME_PLATFORM_SESSION_COOKIE_NAME', 'game_platform_session'), { path: '/' });
    return { ok: true };
  }
}

function callbackHtml(input: { loginTransactionId?: string; session?: unknown; errorCode?: string; error?: string }): string {
  const title = input.session ? 'game-platform login complete' : 'game-platform login failed';
  const transaction = escapeHtml(input.loginTransactionId ?? '');
  const error = escapeHtml(input.error ?? '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f4ef; color: #1d2521; }
    main { width: min(420px, calc(100vw - 32px)); display: grid; gap: 12px; }
    code { display: block; padding: 10px; background: #fff; border: 1px solid #ddd; border-radius: 8px; overflow-wrap: anywhere; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    ${input.session ? '<p>Return to the app and complete login.</p>' : `<p class="error">${error}</p>`}
    ${transaction ? `<p>Login transaction</p><code>${transaction}</code>` : ''}
  </main>
</body>
</html>`;
}

function appRedirectHtml(
  redirectUri: string,
  input: { loginTransactionId?: string; session?: unknown; errorCode?: string; error?: string },
): string {
  const success = Boolean(input.session);
  const title = success ? 'game-platform login complete' : 'game-platform login failed';
  const returnLinks = buildReturnLinks(redirectUri);
  const escapedCurrentPlatformUri = escapeHtml(returnLinks.customUri);
  const escapedIosUri = escapeHtml(returnLinks.customUri);
  const escapedMacosUri = escapeHtml(returnLinks.customUri);
  const escapedAndroidUri = escapeHtml(returnLinks.androidIntentUri);
  const authLogoutUrl = new URL('/logout', env('AUTH_API_BASE_URL', 'http://localhost:3032')).toString();
  const escapedError = escapeHtml(input.error ?? input.errorCode ?? '');
  const message = success ? '앱으로 자동 복귀를 시도하고 있습니다.' : '로그인에 실패했습니다.';
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f7f4ef; color: #1d2521; }
    main { width: min(440px, calc(100vw - 32px)); display: grid; gap: 14px; text-align: center; }
    .actions { display: grid; gap: 8px; }
    a, button { appearance: none; border: 0; cursor: pointer; box-sizing: border-box; display: inline-flex; justify-content: center; align-items: center; min-height: 44px; padding: 0 16px; border-radius: 8px; background: #2f6f5e; color: #fff; text-decoration: none; font: inherit; font-weight: 700; }
    .secondary { background: #ffffff; color: #1d2521; border: 1px solid #d5d0c6; }
    .danger { background: #fff; color: #b42318; border: 1px solid #f0b8b2; }
    .muted { color: #66736d; font-size: 0.9rem; }
    p { margin: 0; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <main>
    <h1>${success ? '로그인 완료' : '로그인 실패'}</h1>
    <p id="status">${message}</p>
    ${escapedError ? `<p class="error">${escapedError}</p>` : ''}
    <div class="actions">
      <a id="current-platform-link" href="${escapedCurrentPlatformUri}">현재 기기로 돌아가기</a>
      <a id="ios-link" class="secondary" href="${escapedIosUri}">iOS 앱으로 돌아가기</a>
      <a id="macos-link" class="secondary" href="${escapedMacosUri}">macOS 앱으로 돌아가기</a>
      <a id="android-link" class="secondary" href="${escapedAndroidUri}">Android 앱으로 돌아가기</a>
      <button id="logout-button" class="danger" type="button">로그아웃</button>
    </div>
    <p class="muted">자동 복귀가 되지 않으면 현재 사용 중인 플랫폼 버튼을 눌러주세요.</p>
    <noscript>
      <form method="post" action="../logout">
        <button class="danger" type="submit">게임 세션 로그아웃</button>
      </form>
      <a class="secondary" href="${escapeHtml(authLogoutUrl)}">Auth 로그아웃</a>
    </noscript>
  </main>
  <script>
    var customReturnUri = ${JSON.stringify(returnLinks.customUri)};
    var androidReturnUri = ${JSON.stringify(returnLinks.androidIntentUri)};
    var authLogoutUrl = ${JSON.stringify(authLogoutUrl)};
    var statusNode = document.getElementById('status');
    var currentPlatformLink = document.getElementById('current-platform-link');
    var logoutButton = document.getElementById('logout-button');

    function platform() {
      var ua = navigator.userAgent || '';
      if (/android/i.test(ua)) return 'android';
      if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
      if (/macintosh|mac os x/i.test(ua)) return 'macos';
      return 'unknown';
    }

    function preferredReturnUri() {
      return platform() === 'android' ? androidReturnUri : customReturnUri;
    }

    currentPlatformLink.href = preferredReturnUri();
    currentPlatformLink.textContent = platform() === 'android'
      ? 'Android 앱으로 돌아가기'
      : platform() === 'macos'
        ? 'macOS 앱으로 돌아가기'
        : platform() === 'ios'
          ? 'iOS 앱으로 돌아가기'
          : '앱으로 돌아가기';

    function openApp() {
      statusNode.textContent = '앱으로 자동 복귀를 시도하고 있습니다.';
      window.location.href = preferredReturnUri();
      setTimeout(function () {
        statusNode.textContent = '자동 복귀가 되지 않으면 아래 버튼을 눌러주세요.';
      }, 1600);
    }

    logoutButton.addEventListener('click', async function () {
      logoutButton.disabled = true;
      statusNode.textContent = '로그아웃 중입니다.';
      try {
        await fetch('../logout', { method: 'POST', credentials: 'include' });
      } catch (_) {}
      window.location.href = authLogoutUrl;
    });

    if (${JSON.stringify(success)}) {
      setTimeout(openApp, 350);
    }
  </script>
</body>
</html>`;
}

function buildReturnLinks(redirectUri: string): { customUri: string; androidIntentUri: string } {
  const parsed = new URL(redirectUri);
  const androidIntentPath = `${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  return {
    customUri: redirectUri,
    androidIntentUri: `intent://${androidIntentPath}#Intent;scheme=${parsed.protocol.replace(':', '')};package=com.example.game_platform_app_flutter;end`,
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
