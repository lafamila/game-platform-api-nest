import { Controller, Get, Header } from '@nestjs/common';
import { REPLAY_VIEW_HTML } from './replay-view.page';

/**
 * `/replay` 웹 뷰 셸을 서빙한다. global `/api` 프리픽스 밖 경로 (main.ts 의 setGlobalPrefix exclude).
 * 가드를 두지 않는다 — 페이지 JS 가 superadmin 전용 API 응답(401/403/200)으로 로그인/권한 상태를 분기한다.
 */
@Controller('replay')
export class ReplayViewController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    return REPLAY_VIEW_HTML;
  }
}
