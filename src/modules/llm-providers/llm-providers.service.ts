import { BadGatewayException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, Db } from '../../db/db.module';
import { llmProviders, messages } from '../../db/schema';
import { decryptCredential, encryptCredential } from '../../common/crypto';
import { uuidv7 } from '../../common/uuidv7';
import { LlmService, TestResult } from '../bot/llm.service';
import { AuditActor, AuditService } from '../audit/audit.service';

/** Unsaved form values; `id` lets the form reuse the stored key when the key field is blank. */
export interface DraftInput {
  id?: string;
  baseUrl: string;
  model?: string;
  apiKey?: string;
}

export interface ProviderInput {
  name?: string;
  kind?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  priority?: number;
  enabled?: boolean;
}

@Injectable()
export class LlmProvidersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.db
      .select()
      .from(llmProviders)
      .orderBy(desc(llmProviders.priority), desc(llmProviders.createdAt));
    return rows.map((row) => this.toPublic(row));
  }

  async create(input: ProviderInput, actor: AuditActor) {
    const id = uuidv7();
    const apiKey = input.apiKey?.trim() ?? '';
    const [row] = await this.db
      .insert(llmProviders)
      .values({
        id,
        name: input.name!.trim(),
        kind: input.kind ?? 'openai_compatible',
        baseUrl: input.baseUrl!.trim().replace(/\/$/, ''),
        model: input.model!.trim(),
        apiKeyEnc: apiKey ? this.encrypt(apiKey, id) : null,
        keyId: apiKey ? this.config.getOrThrow<string>('CREDENTIAL_KEY_ID') : null,
        priority: input.priority ?? 0,
        enabled: input.enabled ?? true,
      })
      .returning();
    this.llm.invalidate();
    await this.audit.record(actor, {
      action: 'provider.created',
      workspaceId: null,
      target: { type: 'provider', id: row.id, label: row.name },
      metadata: { baseUrl: row.baseUrl, model: row.model, enabled: row.enabled, hasApiKey: Boolean(apiKey) },
    });
    return this.toPublic(row);
  }

  async update(id: string, input: ProviderInput, actor: AuditActor) {
    const existing = await this.getRow(id);
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) values.name = input.name.trim();
    if (input.kind !== undefined) values.kind = input.kind;
    if (input.baseUrl !== undefined) values.baseUrl = input.baseUrl.trim().replace(/\/$/, '');
    if (input.model !== undefined) values.model = input.model.trim();
    if (input.priority !== undefined) values.priority = input.priority;
    if (input.enabled !== undefined) values.enabled = input.enabled;
    // Empty or missing apiKey keeps the stored key.
    if (input.apiKey) {
      values.apiKeyEnc = this.encrypt(input.apiKey.trim(), existing.id);
      values.keyId = this.config.getOrThrow<string>('CREDENTIAL_KEY_ID');
    }

    const [row] = await this.db.update(llmProviders).set(values).where(eq(llmProviders.id, id)).returning();
    this.llm.invalidate();
    // Never put the key itself in the audit trail, only that it changed.
    const changed = Object.keys(values).filter((k) => k !== 'updatedAt' && k !== 'apiKeyEnc' && k !== 'keyId');
    const changes = Object.fromEntries(
      changed
        .filter((k) => String(existing[k as keyof typeof existing] ?? '') !== String(values[k] ?? ''))
        .map((k) => [k, { from: existing[k as keyof typeof existing], to: values[k] }]),
    );
    if (input.apiKey) changes.apiKey = { from: '[ẩn]', to: '[đã đổi]' };
    if (Object.keys(changes).length) {
      await this.audit.record(actor, {
        action: 'provider.updated',
        workspaceId: null,
        target: { type: 'provider', id, label: row.name },
        metadata: { changes },
      });
    }
    return this.toPublic(row);
  }

  async remove(id: string, actor: AuditActor) {
    const existing = await this.getRow(id);
    await this.db.delete(llmProviders).where(eq(llmProviders.id, id));
    this.llm.invalidate();
    await this.audit.record(actor, {
      action: 'provider.deleted',
      workspaceId: null,
      target: { type: 'provider', id, label: existing.name },
      metadata: { baseUrl: existing.baseUrl, model: existing.model },
    });
    return { ok: true };
  }

  async test(id: string) {
    const row = await this.getRow(id);
    let result: TestResult | undefined;
    let error: string | undefined;
    try {
      result = await this.llm.testConnection({
        id: row.id,
        name: row.name,
        baseUrl: row.baseUrl,
        model: row.model,
        apiKey: this.decrypt(row),
      });
    } catch (err) {
      error = describe(err);
    }
    await this.db
      .update(llmProviders)
      .set({
        lastCheckAt: new Date(),
        lastCheckOk: !error,
        lastError: error ? error.slice(0, 500) : null,
        updatedAt: new Date(),
      })
      .where(eq(llmProviders.id, id));
    return { ok: !error, detail: error ?? 'Kết nối OK', result };
  }

  /** Test values typed in the form before saving them. */
  async testDraft(input: DraftInput) {
    try {
      const result = await this.llm.testConnection({
        id: input.id ?? 'draft',
        name: 'draft',
        baseUrl: input.baseUrl,
        model: input.model ?? '',
        apiKey: await this.draftKey(input),
      });
      return { ok: true, detail: 'Kết nối OK', result };
    } catch (err) {
      return { ok: false, detail: describe(err) };
    }
  }

  async models(input: DraftInput) {
    const apiKey = await this.draftKey(input);
    try {
      return { models: await this.llm.listModels({ baseUrl: input.baseUrl, apiKey }) };
    } catch (err) {
      throw new BadGatewayException(describe(err));
    }
  }

  /** Tokens spent and answer latency per provider name, from bot answers stored in `messages.metadata`. */
  async usage() {
    const rows = await this.db
      .select({
        provider: sql<string>`${messages.metadata}->>'provider'`,
        answers: sql<number>`count(*)::int`,
        tokensIn: sql<number>`coalesce(sum((${messages.metadata}->>'tokensIn')::int), 0)::int`,
        tokensOut: sql<number>`coalesce(sum((${messages.metadata}->>'tokensOut')::int), 0)::int`,
        tokensToday: sql<number>`coalesce(sum((coalesce((${messages.metadata}->>'tokensIn')::int, 0) + coalesce((${messages.metadata}->>'tokensOut')::int, 0))) filter (where ${messages.createdAt} >= date_trunc('day', now())), 0)::int`,
        // Real answer latency over the last 7 days, so admins compare providers on actual traffic.
        latencyCount: sql<number>`(count(*) filter (where ${messages.createdAt} >= now() - interval '7 days' and ${messages.metadata} ? 'latencyMs'))::int`,
        latencyP50: sql<number | null>`(percentile_cont(0.5) within group (order by (${messages.metadata}->>'latencyMs')::int) filter (where ${messages.createdAt} >= now() - interval '7 days'))::int`,
        latencyP95: sql<number | null>`(percentile_cont(0.95) within group (order by (${messages.metadata}->>'latencyMs')::int) filter (where ${messages.createdAt} >= now() - interval '7 days'))::int`,
      })
      .from(messages)
      .where(sql`${messages.metadata}->>'source' = 'llm' and ${messages.metadata} ? 'provider'`)
      .groupBy(sql`${messages.metadata}->>'provider'`);
    return rows;
  }

  private async draftKey(input: DraftInput) {
    const typed = input.apiKey?.trim();
    if (typed) return typed;
    if (!input.id) return undefined;
    return this.decrypt(await this.getRow(input.id));
  }

  private decrypt(row: typeof llmProviders.$inferSelect) {
    return row.apiKeyEnc
      ? decryptCredential(row.apiKeyEnc, row.id, this.config.getOrThrow<string>('CREDENTIAL_KEY'))
      : undefined;
  }

  private encrypt(apiKey: string, id: string) {
    return encryptCredential(
      apiKey,
      id,
      this.config.getOrThrow<string>('CREDENTIAL_KEY'),
      this.config.getOrThrow<string>('CREDENTIAL_KEY_ID'),
    );
  }

  /** Never expose the key: only whether it exists and its last 4 characters. */
  private toPublic(row: typeof llmProviders.$inferSelect) {
    let keyHint: string | null = null;
    if (row.apiKeyEnc) {
      try {
        keyHint = decryptCredential(row.apiKeyEnc, row.id, this.config.getOrThrow<string>('CREDENTIAL_KEY')).slice(-4);
      } catch {
        keyHint = null;
      }
    }
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      baseUrl: row.baseUrl,
      model: row.model,
      priority: row.priority,
      enabled: row.enabled,
      hasKey: !!row.apiKeyEnc,
      keyHint,
      lastCheckAt: row.lastCheckAt,
      lastCheckOk: row.lastCheckOk,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async getRow(id: string) {
    const [row] = await this.db.select().from(llmProviders).where(eq(llmProviders.id, id)).limit(1);
    if (!row) throw new NotFoundException('Không tìm thấy provider');
    return row;
  }
}

/** `fetch failed` hides the real reason (DNS, TLS, refused) in `cause`. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'TimeoutError') return 'Hết thời gian chờ provider phản hồi';
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const reason = cause?.code ?? cause?.message;
  return reason && err.message === 'fetch failed' ? `Không kết nối được provider (${reason})` : err.message;
}
