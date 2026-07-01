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
import { RealtimeService } from './realtime/realtime.service';
import { SocialController } from './social/social.controller';
import { SocialService } from './social/social.service';

@Module({
  controllers: [HealthController, SessionController, GamesController, SocialController, RealtimeController],
  providers: [
    DatabaseService,
    AuthService,
    GamePlatformSessionService,
    GamePlatformSessionGuard,
    GamesService,
    SocialService,
    RealtimeService,
  ],
})
export class AppModule {}
