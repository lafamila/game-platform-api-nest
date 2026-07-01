import 'reflect-metadata';
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
  app.setGlobalPrefix('api');

  const port = Number(process.env.PORT ?? 3035);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);
}

void bootstrap();
