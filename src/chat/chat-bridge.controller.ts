import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { RequestWithAuth } from '../auth/auth.types';
import { GamePlatformSessionGuard } from '../auth/session.guard';
import { sessionUnauthorized } from '../auth/session.service';
import { ChatBridgeService } from './chat-bridge.service';

@Controller('chat')
export class ChatBridgeController {
  constructor(private readonly chat: ChatBridgeService) {}

  @UseGuards(GamePlatformSessionGuard)
  @Post('session')
  exchange(@Req() request: Request & Partial<RequestWithAuth>) {
    const session = request.gameSession;
    if (!session || session.id.startsWith('bearer:') || !session.refreshToken) {
      throw sessionUnauthorized('SESSION_INVALID', 'Game-platform session is required for chat exchange');
    }
    return this.chat.exchange(session);
  }
}
