import { Controller, Req, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { RequestWithAuth } from '../auth/auth.types';
import { GamePlatformSessionGuard } from '../auth/session.guard';
import { RealtimeService } from './realtime.service';
import { MessageEvent } from '@nestjs/common';

@UseGuards(GamePlatformSessionGuard)
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Sse('events')
  events(@Req() request: Request & Partial<RequestWithAuth>): Observable<MessageEvent> {
    return this.realtime.streamForAccount(request.authAccount!.accountId, request.gameSession?.id);
  }
}
