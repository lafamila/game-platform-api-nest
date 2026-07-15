import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { GamePlatformSessionGuard } from '../auth/session.guard';
import { SuperadminGuard } from '../auth/superadmin.guard';
import { SocialService } from '../social/social.service';
import { ReplayService } from './replay.service';

/**
 * 리플레이 API — 전부 superadmin 전용 (D1). 세션 가드로 브라우저 쿠키/헤더 세션을 검증한 뒤
 * superadmin 가드로 권한을 확인한다. 미로그인 → 401(login-start 유도), 비superadmin → 403 FORBIDDEN.
 */
@UseGuards(GamePlatformSessionGuard, SuperadminGuard)
@Controller('replays')
export class ReplayController {
  constructor(
    private readonly replays: ReplayService,
    private readonly social: SocialService,
  ) {}

  @Get()
  list(
    @Query('game') game?: string,
    @Query('accountId') accountId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.replays.listReplays({
      game: game?.trim() || undefined,
      accountId: accountId?.trim() || undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  // 기존 account search 경로 재사용 (account.search 서비스 credential). :sessionId 보다 먼저 선언.
  @Get('accounts/search')
  searchAccounts(@Query('q') q?: string) {
    return this.social.searchAccounts(q ?? '');
  }

  @Get(':sessionId')
  detail(@Param('sessionId') sessionId: string) {
    return this.replays.getReplay(sessionId);
  }
}
