import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { hasSuperadminAccess } from './roles';
import { RequestWithAuth } from './auth.types';
import { sessionUnauthorized } from './session.service';

/**
 * superadmin 전용 가드 (D1). GamePlatformSessionGuard 가 먼저 실행되어 request.authAccount 를
 * 세팅한 뒤 동작한다 — @UseGuards(GamePlatformSessionGuard, SuperadminGuard) 순서 전제.
 * 미로그인/세션무효는 세션 가드가 401(code AUTH_REQUIRED/SESSION_* 등)로 처리하고,
 * 로그인했지만 superadmin 이 아니면 여기서 403 FORBIDDEN 을 던진다 (기존 code 계약 스타일).
 */
@Injectable()
export class SuperadminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & Partial<RequestWithAuth>>();
    const account = request.authAccount;
    if (!account) {
      throw sessionUnauthorized('AUTH_REQUIRED', 'Game-platform session is required');
    }
    if (!hasSuperadminAccess(account)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'FORBIDDEN',
        message: 'superadmin permission is required',
        error: 'Forbidden',
      });
    }
    return true;
  }
}
