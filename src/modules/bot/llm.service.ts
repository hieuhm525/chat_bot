import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { llmProviders } from '../../db/schema';
import { decryptCredential, encryptCredential } from '../../common/crypto';
import { uuidv7 } from '../../common/uuidv7';

export interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs: number;
}

const CACHE_MS = 30_000;

/**
 * Providers live in `llm_providers` (admin-managed). LLM_PROVIDERS is only a
 * one-time seed for an empty table; after that it is ignored.
 */
@Injectable()
export class LlmService implements OnModuleInit {
  private readonly logger = new Logger(LlmService.name);
  private cache?: { at: number; providers: LlmProvider[] };
  private seeded = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: ConfigService,
  ) {}

  /** Seed from env at startup so /admin sees providers before the first message. */
  async onModuleInit() {
    await this.seedFromEnv();
  }

  /** Called after an admin edits a provider. */
  invalidate() {
    this.cache = undefined;
  }

  /** Enabled providers, highest priority first. */
  async list(): Promise<LlmProvider[]> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.providers;
    await this.seedFromEnv();
    const rows = await this.db
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.enabled, true))
      .orderBy(desc(llmProviders.priority), desc(llmProviders.createdAt));

    const key = this.config.getOrThrow<string>('CREDENTIAL_KEY');
    const providers: LlmProvider[] = [];
    for (const row of rows) {
      let apiKey: string | undefined;
      if (row.apiKeyEnc) {
        try {
          apiKey = decryptCredential(row.apiKeyEnc, row.id, key);
        } catch {
          this.logger.error(`Không giải mã được API key của provider ${row.id}`);
          continue;
        }
      }
      providers.push({ id: row.id, name: row.name, baseUrl: row.baseUrl, model: row.model, apiKey });
    }

    this.cache = { at: Date.now(), providers };
    return providers;
  }

  async complete(messages: ChatMessage[]): Promise<LlmResult> {
    let lastError: unknown;
    for (const provider of await this.list()) {
      if (!provider.apiKey && !isLocal(provider.baseUrl)) {
        lastError = new Error(`Provider ${provider.name} chưa có API key`);
        continue;
      }
      const startedAt = Date.now();
      try {
        const result = await this.call(provider, messages);
        if (result.text.trim()) return { ...result, text: result.text.trim(), latencyMs: Date.now() - startedAt };
      } catch (err) {
        lastError = err;
        this.logger.warn(`LLM ${provider.name} lỗi: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw lastError ?? new Error('Không có LLM provider khả dụng');
  }

  /** One short completion against a single provider, for the admin test button. */
  async testConnection(provider: LlmProvider): Promise<string> {
    if (!provider.apiKey && !isLocal(provider.baseUrl)) throw new Error('Provider chưa có API key');
    const result = await this.call(provider, [{ role: 'user', content: 'Trả lời đúng một từ: ok' }]);
    return result.text;
  }

  private async call(provider: LlmProvider, messages: ChatMessage[]): Promise<Omit<LlmResult, 'latencyMs'>> {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: 0.3,
        max_tokens: this.config.getOrThrow<number>('LLM_MAX_TOKENS'),
      }),
      signal: AbortSignal.timeout(this.config.getOrThrow<number>('LLM_TIMEOUT_MS')),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as any;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Phản hồi LLM không hợp lệ');
    return {
      text: content,
      provider: provider.name,
      model: typeof body?.model === 'string' ? body.model : provider.model,
      tokensIn: body?.usage?.prompt_tokens,
      tokensOut: body?.usage?.completion_tokens,
    };
  }

  private async seedFromEnv() {
    if (this.seeded) return;
    this.seeded = true;

    const [{ count }] = await this.db.select({ count: sql<number>`count(*)::int` }).from(llmProviders);
    if (count > 0) return;

    let entries: any[];
    try {
      entries = JSON.parse(this.config.getOrThrow<string>('LLM_PROVIDERS'));
    } catch {
      return;
    }
    if (!Array.isArray(entries) || !entries.length) return;

    const key = this.config.getOrThrow<string>('CREDENTIAL_KEY');
    const keyId = this.config.getOrThrow<string>('CREDENTIAL_KEY_ID');
    const values = entries
      .filter((entry) => entry?.baseUrl && entry?.model)
      .map((entry, index) => {
        const id = uuidv7();
        const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey : '';
        return {
          id,
          name: String(entry.name ?? `provider-${index + 1}`),
          baseUrl: String(entry.baseUrl),
          model: String(entry.model),
          apiKeyEnc: apiKey ? encryptCredential(apiKey, id, key, keyId) : null,
          keyId: apiKey ? keyId : null,
          priority: entries.length - index,
        };
      });
    if (values.length) await this.db.insert(llmProviders).values(values);
  }
}

function isLocal(baseUrl: string) {
  return /localhost|127\.0\.0\.1/.test(baseUrl);
}
