import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] });
  configureApp(app);
  app.useStaticAssets(join(__dirname, '..', 'public'));

  const port = Number(process.env.PORT ?? 3737);
  // En local solo escucha en 127.0.0.1: el modo local lee archivos de tu disco.
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  Logger.log(`BMAD Dashboard listo en http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`, 'Bootstrap');
}

bootstrap();
