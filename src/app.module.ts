import { Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env';
import { DbModule } from './db/db.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthGuard } from './common/auth.guard';
import { RolesGuard } from './common/roles.guard';
import { ChannelsModule } from './modules/channels/channels.module';
import { BotModule } from './modules/bot/bot.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { SetupModule } from './modules/setup/setup.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { LlmProvidersModule } from './modules/llm-providers/llm-providers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-hub-signature-256"]',
            'req.headers["x-zevent-signature"]',
            'res.headers["set-cookie"]',
            '*.credentials',
            '*.credentialsEnc',
            '*.accessToken',
            '*.refreshToken',
          ],
          censor: '[redacted]',
        },
      },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DbModule,
    AuthModule,
    ChannelsModule,
    BotModule,
    MessagingModule,
    SetupModule,
    TenantsModule,
    LlmProvidersModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    },
  ],
})
export class AppModule {}
