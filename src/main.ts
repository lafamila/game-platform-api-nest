import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const origins = (process.env.GAME_PLATFORM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origins.length > 0 ? origins : true,
    credentials: true,
  });
  // 리플레이 웹 뷰만 global /api 프리픽스 밖(/replay)에서 서빙한다. 나머지는 전부 /api/*.
  app.setGlobalPrefix('api', { exclude: [{ path: 'replay', method: RequestMethod.GET }] });

  const port = Number(process.env.PORT ?? 3035);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);
}

void bootstrap();
