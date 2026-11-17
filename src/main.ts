import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './shared/filters/http-exception.filter.js';

async function bootstrap() {
  // On SIGTERM/SIGINT the shutdown hooks run (onModuleDestroy, onApplicationShutdown): Prisma and
  // Redis close their connections and the prepared downloads delete their temporary files. Open
  // connections are cut instead of waited for, so a long download or upload cannot hold the
  // process (or a watch-mode restart) once the database is already disconnected.
  const app = await NestFactory.create(AppModule, {
    forceCloseConnections: true,
  });
  app.enableShutdownHooks();
  // Content-Disposition expuesto para que el front pueda leer el nombre de
  // archivo de las descargas hechas por XHR (exportaciones del armonizador).
  app.enableCors({ exposedHeaders: ['Content-Disposition'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
