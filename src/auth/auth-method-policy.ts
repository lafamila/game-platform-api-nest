import { UnauthorizedException } from '@nestjs/common';
import { AuthAccount } from './auth.types';

export const AUTH_METHOD_CLAIM = 'https://lafamila.xyz/claims/authentication_method';
export const SERVICE_CATEGORY_CLAIM = 'https://lafamila.xyz/claims/service_category';
export const AUTH_METHOD_DENIED = 'AUTHENTICATION_METHOD_NOT_ALLOWED';
export const AUTH_METHOD_REAUTH = 'AUTHENTICATION_METHOD_REAUTHENTICATION_REQUIRED';
export const SESSION_AUTH_METHOD_DENIED = 'SESSION_AUTH_METHOD_DENIED';
export const KAKAO_GAME_MESSAGE = '카카오로 로그인한 경우 정책상 게임서비스는 이용할 수 없습니다. 다른 방식으로 로그인해주세요.';
export const AUTH_METHOD_REAUTH_MESSAGE = '로그인 방식을 확인할 수 없습니다. 다시 로그인해주세요.';

export interface AuthMethodFailure {
  bodyCode: typeof AUTH_METHOD_DENIED | typeof AUTH_METHOD_REAUTH;
  message: string;
}

export class AuthMethodPolicyError extends UnauthorizedException {
  constructor(readonly failure: AuthMethodFailure, readonly sessionId?: string, readonly sessionInvalidated = true) {
    super({ statusCode: 401, code: SESSION_AUTH_METHOD_DENIED, ...failure, sessionInvalidated });
  }
}

export function authMethodFailure(account: AuthAccount): AuthMethodFailure | undefined {
  const category = account.claims[SERVICE_CATEGORY_CLAIM];
  const method = account.claims[AUTH_METHOD_CLAIM];
  if (typeof category === 'string' && category.length > 0 && category !== 'game') return undefined;
  if (category === 'game' && method === 'kakao') return { bodyCode: AUTH_METHOD_DENIED, message: KAKAO_GAME_MESSAGE };
  if (category === 'game' && typeof method === 'string' && ['local', 'google', 'naver'].includes(method)) return undefined;
  return { bodyCode: AUTH_METHOD_REAUTH, message: AUTH_METHOD_REAUTH_MESSAGE };
}

export function upstreamAuthMethodFailure(code: unknown, description: unknown): AuthMethodFailure | undefined {
  if (code !== AUTH_METHOD_DENIED && code !== AUTH_METHOD_REAUTH) return undefined;
  return {
    bodyCode: code,
    message: typeof description === 'string' && description.length > 0
      ? description
      : code === AUTH_METHOD_DENIED ? KAKAO_GAME_MESSAGE : AUTH_METHOD_REAUTH_MESSAGE,
  };
}

export function isAuthMethodPolicyError(error: unknown): error is AuthMethodPolicyError {
  return error instanceof AuthMethodPolicyError;
}
