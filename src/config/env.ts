import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  validateSync,
} from 'class-validator';

export class Env {
  @IsIn(['local', 'test', 'production'])
  NODE_ENV: 'local' | 'test' | 'production' = 'local';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  PORT = 3000;

  @IsString()
  APP_URL = 'http://localhost:3000';

  @IsString()
  DATABASE_URL!: string;

  /** base64-encoded 32-byte AES key. */
  @IsString()
  @Length(44, 44)
  CREDENTIAL_KEY!: string;

  @IsString()
  CREDENTIAL_KEY_ID = 'v1';

  @IsOptional()
  @IsString()
  LLM_PROVIDERS = '[]';

  @Type(() => Number)
  @IsInt()
  LLM_TIMEOUT_MS = 20000;

  @Type(() => Number)
  @IsInt()
  LLM_MAX_TOKENS = 1024;

  @IsOptional()
  @IsString()
  META_APP_SECRET = '';

  @IsOptional()
  @IsString()
  META_VERIFY_TOKEN = '';

  @IsOptional()
  @IsString()
  ZALO_APP_ID = '';

  /** One-time bootstrap token for the first admin. Empty = local-only setup. */
  @IsOptional()
  @IsString()
  SETUP_TOKEN = '';

  /** Public self-service tenant sign-up at /app/register. Keep off unless you want open registration. */
  @IsOptional()
  @IsIn(['true', 'false'])
  ALLOW_SIGNUP = 'false';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  SIGNUP_TRIAL_DAYS = 14;

  @IsOptional()
  @IsString()
  LOG_LEVEL = 'info';

  @IsOptional()
  @IsIn(['true', 'false'])
  WORKER_ENABLED = 'true';

  get isProduction(): boolean {
    return this.NODE_ENV === 'production';
  }
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw, { enableImplicitConversion: false });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length) {
    const detail = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  if (env.NODE_ENV === 'production' && !env.META_APP_SECRET) {
    throw new Error('Invalid environment: META_APP_SECRET is required in production');
  }
  try {
    const parsed = JSON.parse(env.LLM_PROVIDERS);
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch {
    throw new Error('Invalid environment: LLM_PROVIDERS must be a JSON array');
  }
  return env;
}
