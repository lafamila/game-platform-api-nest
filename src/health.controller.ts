import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return {
      status: 'ok',
      service: 'game-platform-api-nest',
      timeZone: 'Asia/Seoul',
      now: new Date().toISOString(),
    };
  }
}
