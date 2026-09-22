import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { GamesController } from './games/games.controller';
import { GamesService } from './games/games.service';
import { DatabaseService } from './database/database.service';
import { AuthService } from './auth/auth.service';
import { GamePlatformSessionService } from './auth/session.service';
import { GamePlatformSessionGuard } from './auth/session.guard';
import { SessionController } from './auth/session.controller';
import { RealtimeController } from './realtime/realtime.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { RealtimeService } from './realtime/realtime.service';
import { PresenceService } from './realtime/presence.service';
import { SocialController } from './social/social.controller';
import { SocialService } from './social/social.service';
import { DiagnosticsController } from './diagnostics/diagnostics.controller';
import { DiagnosticsService } from './diagnostics/diagnostics.service';
import { AppVersionController } from './app-version.controller';
import { SuperadminGuard } from './auth/superadmin.guard';
import { ReplayController } from './replay/replay.controller';
import { ReplayViewController } from './replay/replay-view.controller';
import { ReplayService } from './replay/replay.service';
import { AuthWebhookController } from './auth/auth-webhook.controller';
import { AuthWebhookService } from './auth/auth-webhook.service';
import { ChatBridgeController } from './chat/chat-bridge.controller';
import { ChatBridgeService } from './chat/chat-bridge.service';

@Module({
  controllers: [
    HealthController,
    AppVersionController,
    SessionController,
    GamesController,
    SocialController,
    DiagnosticsController,
    RealtimeController,
    ReplayController,
    ReplayViewController,
    AuthWebhookController,
    ChatBridgeController,
  ],
  providers: [
    DatabaseService,
    AuthService,
    GamePlatformSessionService,
    GamePlatformSessionGuard,
    SuperadminGuard,
    GamesService,
    SocialService,
    DiagnosticsService,
    RealtimeService,
    RealtimeGateway,
    PresenceService,
    ReplayService,
    AuthWebhookService,
    ChatBridgeService,
  ],
})
export class AppModule {}
