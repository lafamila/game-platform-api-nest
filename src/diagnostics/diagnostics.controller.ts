import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthAccount } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user';
import { GamePlatformSessionGuard } from '../auth/session.guard';
import { DiagnosticsService } from './diagnostics.service';

@UseGuards(GamePlatformSessionGuard)
@Controller()
export class DiagnosticsController {
  constructor(private readonly diagnostics: DiagnosticsService) {}

  @Post('client-errors')
  saveClientErrors(@CurrentUser() user: AuthAccount, @Body() body: { errors?: unknown[] }) {
    return this.diagnostics.saveClientErrors(user, body);
  }
}
