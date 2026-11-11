import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { static as expressStatic } from 'express';
import { setDefaultResultOrder } from 'node:dns';
import { existsSync } from 'node:fs';
import { setDefaultAutoSelectFamily } from 'node:net';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { AppModule } from './app.module';
import { DRIZZLE, Db } from './db/db.module';

// Networks that advertise IPv6 without routing it make fetch() to LLM/Meta APIs
// time out. Node's happy-eyeballs gives each address only 250 ms, so a slow IPv4
// handshake gets abandoned for the dead IPv6 route; connect to IPv4 directly.
setDefaultResultOrder('ipv4first');
setDefaultAutoSelectFamily(false);

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  await migrate(app.get<Db>(DRIZZLE), { migrationsFolder: join(__dirname, 'db', 'migrations') });
  logger.log('Database migrations applied');

  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'webhooks/{*path}'] });
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const swagger = new DocumentBuilder()
    .setTitle('bv-agent-msg')
    .setDescription('API quản trị bot CSKH đa kênh')
    .setVersion('0.1')
    .addCookieAuth('bv_session')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));

  const adminDir = join(process.cwd(), 'public', 'admin');
  if (existsSync(adminDir)) {
    for (const mount of ['/admin', '/app']) {
      app.use(mount, expressStatic(adminDir));
      app.use(mount, (req: any, res: any, next: any) => {
        if (req.method !== 'GET' || req.path.includes('.')) return next();
        res.sendFile(join(adminDir, 'index.html'));
      });
    }
  }

  await app.listen(config.getOrThrow<number>('PORT'), '0.0.0.0');
}

bootstrap();
