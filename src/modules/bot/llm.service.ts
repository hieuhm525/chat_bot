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

/** Per-minute limits some providers (Groq, OpenAI) send as `x-ratelimit-*` headers. */
export interface RateLimit {
  limitTokens?: number;
  remainingTokens?: number;
  limitRequests?: number;
  remainingRequests?: number;
}

export interface TestResult {
  reply: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs: number;
  rateLimit?: RateLimit;
  /** OpenRouter only, in USD. `limit`/`remaining` are null for keys without a cap. */
  credits?: { usage: number | null; limit: number | null; remaining: number | null };
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
  async testConnection(provider: LlmProvider): Promise<TestResult> {
    if (!provider.apiKey && !isLocal(provider.baseUrl)) throw new Error('Provider chưa có API key');
    const startedAt = Date.now();
    const result = await this.call(provider, [{ role: 'user', content: 'Trả lời đúng một từ: ok' }]);
    return {
      reply: result.text,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: Date.now() - startedAt,
      rateLimit: result.rateLimit,
      credits: await this.credits(provider),
    };
  }

  /** Model ids from the OpenAI-compatible `GET /models` (Gemini prefixes ids with `models/`). */
  async listModels(provider: Pick<LlmProvider, 'baseUrl' | 'apiKey'>): Promise<string[]> {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/models`, {
      headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
      signal: AbortSignal.timeout(this.config.getOrThrow<number>('LLM_TIMEOUT_MS')),
    });
    if (!res.ok) throw new Error(await httpError(res));
    const body = (await res.json()) as any;
    const ids: string[] = (Array.isArray(body?.data) ? body.data : [])
      .map((m: any) => (typeof m?.id === 'string' ? m.id.replace(/^models\//, '') : ''))
      .filter(Boolean);
    return [...new Set(ids)].sort();
  }

  /** OpenRouter is the only common provider that reports remaining credit for a key. */
  private async credits(provider: LlmProvider): Promise<TestResult['credits']> {
    if (!/openrouter\.ai/.test(provider.baseUrl) || !provider.apiKey) return undefined;
    try {
      const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/key`, {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return undefined;
      const data = ((await res.json()) as any)?.data ?? {};
      return { usage: data.usage ?? null, limit: data.limit ?? null, remaining: data.limit_remaining ?? null };
    } catch {
      return undefined;
    }
  }

  private async call(
    provider: LlmProvider,
    messages: ChatMessage[],
  ): Promise<Omit<LlmResult, 'latencyMs'> & { rateLimit?: RateLimit }> {
    const maxTokens = this.config.getOrThrow<number>('LLM_MAX_TOKENS');
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
        max_tokens: maxTokens,
        // Gemini 3 always thinks and the thoughts count against max_tokens; keep them short.
        ...(/generativelanguage\.googleapis\.com/.test(provider.baseUrl) ? { reasoning_effort: 'low' } : {}),
      }),
      signal: AbortSignal.timeout(this.config.getOrThrow<number>('LLM_TIMEOUT_MS')),
    });
    if (!res.ok) throw new Error(await httpError(res));
    const body = (await res.json()) as any;
    const choice = body?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string') throw new Error('Phản hồi LLM không hợp lệ');
    // A cut-off answer (often half a draft) must never reach the customer.
    if (choice?.finish_reason === 'length') {
      throw new Error(`Câu trả lời bị cắt vì vượt giới hạn ${maxTokens} token`);
    }
    return {
      text: content,
      provider: provider.name,
      model: typeof body?.model === 'string' ? body.model : provider.model,
      tokensIn: body?.usage?.prompt_tokens,
      tokensOut: body?.usage?.completion_tokens,
      rateLimit: readRateLimit(res.headers),
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

/** `HTTP 400: API key not valid…` — providers put the reason in `error.message`. */
async function httpError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as any;
  const raw = Array.isArray(body) ? body[0] : body;
  const message = raw?.error?.message ?? raw?.message;
  return typeof message === 'string' ? `HTTP ${res.status}: ${message.slice(0, 500)}` : `HTTP ${res.status}`;
}

function readRateLimit(headers: Headers): RateLimit | undefined {
  const num = (name: string) => {
    const value = Number(headers.get(name));
    return headers.has(name) && Number.isFinite(value) ? value : undefined;
  };
  const rateLimit: RateLimit = {
    limitTokens: num('x-ratelimit-limit-tokens'),
    remainingTokens: num('x-ratelimit-remaining-tokens'),
    limitRequests: num('x-ratelimit-limit-requests'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
  };
  return Object.values(rateLimit).some((v) => v !== undefined) ? rateLimit : undefined;
}

function isLocal(baseUrl: string) {
  return /localhost|127\.0\.0\.1/.test(baseUrl);
}
