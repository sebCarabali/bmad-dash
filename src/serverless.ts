import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { IncomingMessage, ServerResponse } from 'http';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

/**
 * Punto de entrada para Vercel: la app Nest se crea una vez por instancia
 * y se reutiliza entre invocaciones.
 */
let cached: Promise<express.Express> | null = null;

async function createServer(): Promise<express.Express> {
  const server = express();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(server), { logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  return server;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!cached) cached = createServer();
  const server = await cached;
  server(req as any, res as any);
}
