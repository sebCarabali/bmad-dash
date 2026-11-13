import { NestExpressApplication } from '@nestjs/platform-express';

/** Configuración común para el servidor local y la función serverless de Vercel. */
export function configureApp(app: NestExpressApplication) {
  app.setGlobalPrefix('api');
  // El navegador envía el contenido de los archivos BMAD (historias, épicas, sprint-status)
  app.useBodyParser('json', { limit: '4mb' });
  app.disable('x-powered-by');
  return app;
}

/** Modo local: el servidor puede leer el disco (no disponible en Vercel). */
export function isLocalMode(): boolean {
  if (process.env.LOCAL_FS === 'true') return true;
  if (process.env.LOCAL_FS === 'false') return false;
  return !process.env.VERCEL;
}
