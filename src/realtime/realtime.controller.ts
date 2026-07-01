import { Controller, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import { CurrentUser } from '../auth/current-user';
import { AuthAccount } from '../auth/auth.types';
import { GamePlatformSessionGuard } from '../auth/session.guard';
import { RealtimeService } from './realtime.service';
import { MessageEvent } from '@nestjs/common';

@UseGuards(GamePlatformSessionGuard)
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Sse('events')
  events(@CurrentUser() user: AuthAccount): Observable<MessageEvent> {
    return this.realtime.streamForAccount(user.accountId);
  }
}
