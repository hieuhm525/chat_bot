import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { createHmac } from 'node:crypto';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { eq, inArray, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DRIZZLE, PG_POOL } from '../src/db/db.module';
import { Db } from '../src/db/db.module';
import { auditLogs, botRules, bots, channels, sessions, conversations, customers, llmProviders, messages, outbox, users, webhookEvents, workspaces } from '../src/db/schema';
import { OutboxWorker } from '../src/modules/messaging/outbox.worker';
import { decryptCredential, randomToken, sha256Hex } from '../src/common/crypto';
import { DEFAULT_SYSTEM_PROMPT } from '../src/common/bot-defaults';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/postgres';
const TEST_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/bv_agent_msg_test';

function payload(text: string, mid: string, sender = 'psid-1', pageId = 'PAGE1') {
  return {
    object: 'page',
    entry: [
      {
        id: pageId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: sender },
            recipient: { id: pageId },
            timestamp: Date.now(),
            message: { mid, text },
          },
        ],
      },
    ],
  };
}

function echoPayload(text: string, mid: string, customer = 'psid-1') {
  return {
    object: 'page',
    entry: [
      {
        id: 'PAGE1',
        time: Date.now(),
        messaging: [
          {
            sender: { id: 'PAGE1' },
            recipient: { id: customer },
            timestamp: Date.now(),
            message: { is_echo: true, mid, text },
          },
        ],
      },
    ],
  };
}

function imagePayload(mid: string, url: string, sender = 'psid-1') {
  return {
    object: 'page',
    entry: [
      {
        id: 'PAGE1',
        time: Date.now(),
        messaging: [
          {
            sender: { id: sender },
            recipient: { id: 'PAGE1' },
            timestamp: Date.now(),
            message: { mid, attachments: [{ type: 'image', payload: { url } }] },
          },
        ],
      },
    ],
  };
}

function sign(body: string) {
  return 'sha256=' + createHmac('sha256', 'testsecret').update(body).digest('hex');
}

describe('bv-agent-msg e2e', () => {
  let app: INestApplication;
  let db: Db;
  let worker: OutboxWorker;
  let agent: ReturnType<typeof request.agent>;
  let adminAgent: ReturnType<typeof request.agent>;
  let workspaceId: string;
  let botId: string;
  let conversationId: string;
  let ownerUserId: string;
  const llmCalls: string[] = [];
  const llmBodies: string[] = [];

  const graphCalls: Array<{ url: string; body: any }> = [];

  /**
   * Replies are scheduled a "typing time" ahead; skip that wait for jobs never tried yet.
   * Retry backoff (attempts > 0) is left alone so retry tests still see it.
   */
  const drain = async () => {
    for (let i = 0; i < 3; i++) {
      await db.execute(sql`update outbox set next_attempt_at = now() where status = 'pending' and attempts = 0`);
      await worker.tick();
    }
  };

  const conversationByThread = async (thread: string) => {
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalThreadId, thread))
      .limit(1);
    return row;
  };

  const postWebhook = async (body: unknown) => {
    const raw = JSON.stringify(body);
    await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(raw))
      .send(raw)
      .expect(201);
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query('DROP DATABASE IF EXISTS bv_agent_msg_test WITH (FORCE)');
      await admin.query('CREATE DATABASE bv_agent_msg_test');
    } finally {
      await admin.end();
    }

    const pool = new Pool({ connectionString: TEST_URL });
    await migrate(drizzle(pool), { migrationsFolder: 'src/db/migrations' });
    await pool.end();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'webhooks/{*path}'] });
    await app.init();

    db = app.get(DRIZZLE);
    worker = app.get(OutboxWorker);

    const status = await request(app.getHttpServer()).get('/api/v1/setup/status').expect(200);
    expect(status.body).toMatchObject({ needsSetup: true, tokenRequired: true });

    const setupBody = {
      username: 'admin',
      password: 'password12345',
      confirmPassword: 'password12345',
      setupToken: 'setup-token',
    };
    await request(app.getHttpServer())
      .post('/api/v1/setup')
      .send({ ...setupBody, setupToken: 'wrong-token' })
      .expect(403);
    const setup = await request(app.getHttpServer()).post('/api/v1/setup').send(setupBody).expect(201);
    expect(setup.body.user.role).toBe('admin');

    adminAgent = request.agent(app.getHttpServer());
    await adminAgent
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'password12345' })
      .expect(201);

    const created = await adminAgent
      .post('/api/v1/tenants')
      .send({ name: 'Shop 1', username: 'owner', password: 'password12345', maxBots: 10, maxChannels: 10 })
      .expect(201);
    workspaceId = created.body.id;

    const [user] = await db.select().from(users).where(eq(users.username, 'owner'));
    ownerUserId = user.id;
    const [bot] = await db.select().from(bots).where(eq(bots.workspaceId, workspaceId));
    botId = bot.id;
    await db.insert(botRules).values({
      botId: bot.id,
      name: 'Giờ mở cửa',
      keywords: ['giờ mở cửa', 'mở cửa'],
      answer: 'Dạ shop mở 8h-20h ạ.',
      priority: 10,
      createdBy: user.id,
    });

    let outboundSeq = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('/chat/completions')) {
        llmCalls.push(url);
        llmBodies.push(String(init?.body ?? ''));
        if (url.includes('bad.example')) {
          return new Response(JSON.stringify({ error: 'nope' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { content: 'LLM trả lời ạ.' } }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('graph.facebook.com')) {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        graphCalls.push({ url, body });
        if (body?.sender_action) {
          return new Response(JSON.stringify({ recipient_id: body.recipient.id }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('?fields=first_name')) {
          return new Response(JSON.stringify({ first_name: 'Khách', last_name: 'Test' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/messenger_profile')) {
          return new Response(JSON.stringify({ result: 'success' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      if (url.includes('/subscribed_apps')) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ message_id: `provider-out-${++outboundSeq}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ username: 'owner', password: 'password12345' })
      .expect(201);
    await agent
      .post('/api/v1/channels')
      .send({
        provider: 'messenger',
        name: 'Test Page',
        externalId: 'PAGE1',
        botId,
        credentials: { accessToken: 'fake' },
      })
      .expect(201);
  });

  afterAll(async () => {
    if (!app) return;
    const pool = app.get<Pool>(PG_POOL);
    jest.restoreAllMocks();
    await app.close();
    await pool.end();
  });

  it('serves health and the webhook challenge', async () => {
    const health = await request(app.getHttpServer()).get('/health').expect(200);
    expect(health.body.status).toBe('ok');
    const challenge = await request(app.getHttpServer())
      .get('/webhooks/messenger?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=abc123')
      .expect(200);
    expect(challenge.text).toBe('abc123');
  });

  it('rejects a bad signature without storing an event', async () => {
    const body = JSON.stringify(payload('giờ mở cửa', 'bad-sig'));
    const res = await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .send(body)
      .expect(201);
    expect(res.body.ok).toBe(false);
  });

  it('verifies Meta with the channel verify token and signs with the channel app secret', async () => {
    const list = await agent.get('/api/v1/channels').expect(200);
    const page = list.body.items.find((c: any) => c.externalId === 'PAGE1');
    const verifyToken = 'tenant-verify-token-0123456789';
    await agent
      .patch(`/api/v1/channels/${page.id}`)
      .send({ config: { verifyToken }, credentials: { accessToken: 'fake', appSecret: 'tenantsecret' } })
      .expect(200);
    try {
      const ok = await request(app.getHttpServer())
        .get(`/webhooks/messenger?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=c1`)
        .expect(200);
      expect(ok.text).toBe('c1');
      await request(app.getHttpServer())
        .get('/webhooks/messenger?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=c2')
        .expect(403);

      const raw = JSON.stringify(payload('xin chào', 'tenant-secret-mid'));
      const tenantSig = 'sha256=' + createHmac('sha256', 'tenantsecret').update(raw).digest('hex');
      const signed = await request(app.getHttpServer())
        .post('/webhooks/messenger')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', tenantSig)
        .send(raw)
        .expect(201);
      expect(signed.body.ok).toBe(true);
      // The platform-wide secret no longer verifies a channel that has its own.
      const platformSigned = await request(app.getHttpServer())
        .post('/webhooks/messenger')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', sign(raw))
        .send(raw)
        .expect(201);
      expect(platformSigned.body.ok).toBe(false);
    } finally {
      await agent
        .patch(`/api/v1/channels/${page.id}`)
        .send({ config: {}, credentials: { accessToken: 'fake' } })
        .expect(200);
      // Drop the event stored above so later tests start from an empty conversation list.
      const events = await db.select({ id: webhookEvents.id }).from(webhookEvents).where(eq(webhookEvents.channelId, page.id));
      for (const { id } of events) {
        await db.delete(outbox).where(sql`${outbox.payload}->>'webhookEventId' = ${id}`);
      }
      await db.delete(webhookEvents).where(eq(webhookEvents.channelId, page.id));
    }
  });

  it('stores a webhook, answers by rule, and dedupes retries', async () => {
    const body = JSON.stringify(payload('giờ mở cửa', 'mid-1'));
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/webhooks/messenger')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', sign(body))
        .send(body)
        .expect(201);
    }
    await drain();

    const list = await agent.get('/api/v1/conversations').expect(200);
    expect(list.body.items).toHaveLength(1);
    conversationId = list.body.items[0].id;

    const detail = await agent.get(`/api/v1/conversations/${conversationId}`).expect(200);
    expect(detail.body.messages).toHaveLength(2);
    expect(detail.body.messages[0].direction).toBe('in');
    expect(detail.body.messages[1].content).toContain('8h-20h');
    expect(detail.body.messages[1].status).toBe('sent');
    expect(detail.body.messages[1].metadata).toMatchObject({ source: 'rule', kind: 'answer' });
    expect(detail.body.messages[1].metadata.ruleId).toBeTruthy();
    expect(detail.body.messages[1].botId).toBeTruthy();
    expect(detail.body.botId).toBe(detail.body.messages[1].botId);
    expect(detail.body.messageCount).toBe(2);
    expect(detail.body.messages[1].providerMessageId).toBe('provider-out-1');
  });

  it('keeps the bot silent after takeover', async () => {
    await agent.post(`/api/v1/conversations/${conversationId}/takeover`).expect(201);
    const body = JSON.stringify(payload('giờ mở cửa', 'mid-2'));
    await request(app.getHttpServer())
      .post('/webhooks/messenger')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', sign(body))
      .send(body)
      .expect(201);
    await drain();

    const detail = await agent.get(`/api/v1/conversations/${conversationId}`).expect(200);
    expect(detail.body.mode).toBe('human');
    expect(detail.body.messages).toHaveLength(4);
    expect(detail.body.messages[2]).toMatchObject({
      senderType: 'system',
      direction: 'out',
      status: 'sent',
      metadata: { kind: 'takeover', userId: ownerUserId },
    });

    await agent.post(`/api/v1/conversations/${conversationId}/release`).expect(201);
    const released = await agent.get(`/api/v1/conversations/${conversationId}`).expect(200);
    expect(released.body.mode).toBe('bot');
    expect(released.body.messages.at(-1)).toMatchObject({
      senderType: 'system',
      status: 'sent',
      metadata: { kind: 'release', userId: ownerUserId },
    });
  });

  it('sends an agent message through the outbox', async () => {
    await agent
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .send({ content: 'Dạ em chào anh/chị ạ.' })
      .expect(201);
    await drain();
    const detail = await agent.get(`/api/v1/conversations/${conversationId}`).expect(200);
    const last = detail.body.messages.at(-1);
    expect(last.senderType).toBe('agent');
    expect(last.senderUserId).toBe(ownerUserId);
    expect(last.metadata.source).toBe('agent');
    expect(last.status).toBe('sent');
  });

  it('stores the greeting and the rule answer as separate bot messages', async () => {
    await agent.patch(`/api/v1/bots/${botId}`).send({ greeting: 'Dạ em chào anh/chị ạ.' }).expect(200);
    await postWebhook(payload('giờ mở cửa', 'mid-greeting', 'psid-4'));
    await drain();

    const conversation = await conversationByThread('psid-4');
    expect(conversation).toBeTruthy();
    const detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    expect(detail.body.messageCount).toBe(3);
    expect(detail.body.botId).toBeTruthy();
    expect(detail.body.messages.map((m: any) => m.senderType)).toEqual(['customer', 'bot', 'bot']);
    expect(detail.body.messages[1]).toMatchObject({ content: 'Dạ em chào anh/chị ạ.', metadata: { kind: 'greeting' }, status: 'sent' });
    expect(detail.body.messages[2].metadata).toMatchObject({ kind: 'answer', source: 'rule' });
    expect(detail.body.messages[2].metadata.ruleId).toBeTruthy();
    expect(detail.body.messages[2].botId).toBe(detail.body.botId);
  });

  it('keeps the attachment url and still answers that media is unsupported', async () => {
    await postWebhook(imagePayload('mid-image-1', 'https://cdn.example.com/a.jpg', 'psid-5'));
    await drain();

    const conversation = await conversationByThread('psid-5');
    const detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    const inbound = detail.body.messages[0];
    expect(inbound.contentType).toBe('image');
    expect(inbound.metadata.attachments).toEqual([{ type: 'image', url: 'https://cdn.example.com/a.jpg' }]);
    expect(detail.body.messages.at(-1).content).toContain('chưa xem được ảnh/file');
  });

  it('auto-handoffs after fallbacks, sends the notice and records a system event', async () => {
    await agent.patch(`/api/v1/bots/${botId}`).send({ pauseAfterFallbacks: 1 }).expect(200);
    await postWebhook(payload('câu hỏi không có trong rule', 'mid-handoff-1', 'psid-6'));
    await drain();

    const conversation = await conversationByThread('psid-6');
    const detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    expect(detail.body.mode).toBe('human');
    const kinds = detail.body.messages.map((m: any) => m.metadata.kind ?? m.senderType);
    expect(kinds).toEqual(['customer', 'greeting', 'answer', 'handoff', 'auto_handoff']);
    const handoff = detail.body.messages.find((m: any) => m.metadata.kind === 'handoff');
    expect(handoff).toMatchObject({ senderType: 'bot', status: 'sent', metadata: { afterFallbacks: 1 } });
    const system = detail.body.messages.find((m: any) => m.metadata.kind === 'auto_handoff');
    expect(system).toMatchObject({ senderType: 'system', direction: 'out', status: 'sent', metadata: { fallbackCount: 1 } });

    await agent.post(`/api/v1/conversations/${conversation.id}/release`).expect(201);
  });

  it('walks one conversation through rule, fallback, handoff, agent and release to bot', async () => {
    await agent.patch(`/api/v1/bots/${botId}`).send({ pauseAfterFallbacks: 2 }).expect(200);
    const thread = 'psid-7';
    await postWebhook(payload('giờ mở cửa', 'mid-flow-1', thread));
    await drain();
    await postWebhook(payload('câu hỏi lần một', 'mid-flow-2', thread));
    await drain();
    await postWebhook(payload('câu hỏi lần hai', 'mid-flow-3', thread));
    await drain();

    const conversation = await conversationByThread(thread);
    let detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    expect(detail.body.mode).toBe('human');
    expect(detail.body.fallbackCount).toBe(2);

    await agent
      .post(`/api/v1/conversations/${conversation.id}/messages`)
      .send({ content: 'Dạ em là nhân viên đây ạ.' })
      .expect(201);
    await drain();
    await agent.post(`/api/v1/conversations/${conversation.id}/release`).expect(201);

    await postWebhook(payload('giờ mở cửa', 'mid-flow-4', thread));
    await drain();

    detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    expect(detail.body.mode).toBe('bot');
    expect(detail.body.messages.map((m: any) => m.metadata.kind ?? m.senderType)).toEqual([
      'customer',
      'greeting',
      'answer',
      'customer',
      'answer',
      'customer',
      'answer',
      'handoff',
      'auto_handoff',
      'agent',
      'release',
      'customer',
      'answer',
    ]);
    expect(detail.body.messages.filter((m: any) => m.status === 'failed')).toHaveLength(0);
  });

  it('admin manages LLM providers without leaking keys and the chain skips disabled/failing ones', async () => {
    await agent.get('/api/v1/llm-providers').expect(403);
    await agent
      .post('/api/v1/llm-providers')
      .send({ name: 'x', baseUrl: 'https://x.example/v1', model: 'm' })
      .expect(403);

    const good = await adminAgent
      .post('/api/v1/llm-providers')
      .send({
        name: 'good-priority',
        baseUrl: 'https://good.example/v1',
        model: 'good-model',
        apiKey: 'sk-good-secret-5678',
        priority: 10,
      })
      .expect(201);
    expect(good.body).toMatchObject({ name: 'good-priority', hasKey: true, keyHint: '5678' });
    expect(JSON.stringify(good.body)).not.toContain('sk-good-secret');

    const bad = await adminAgent
      .post('/api/v1/llm-providers')
      .send({
        name: 'bad-priority',
        baseUrl: 'https://bad.example/v1',
        model: 'bad-model',
        apiKey: 'sk-bad-secret-1234',
        priority: 100,
        enabled: false,
      })
      .expect(201);

    const [stored] = await db.select().from(llmProviders).where(eq(llmProviders.id, good.body.id));
    expect(stored.apiKeyEnc).not.toContain('sk-good-secret');
    expect(decryptCredential(stored.apiKeyEnc!, stored.id, Buffer.alloc(32, 3).toString('base64'))).toBe(
      'sk-good-secret-5678',
    );

    // PATCH without apiKey keeps the stored key.
    await adminAgent.patch(`/api/v1/llm-providers/${good.body.id}`).send({ priority: 20 }).expect(200);
    const [afterPatch] = await db.select().from(llmProviders).where(eq(llmProviders.id, good.body.id));
    expect(afterPatch.apiKeyEnc).toBe(stored.apiKeyEnc);

    // Disabled provider is not called; the enabled one answers with usage metadata.
    llmCalls.length = 0;
    await postWebhook(payload('câu hỏi cho AI', 'mid-llm-1', 'psid-8'));
    await drain();
    const conversation = await conversationByThread('psid-8');
    let detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    const answer = detail.body.messages.at(-1);
    expect(answer.content).toBe('LLM trả lời ạ.');
    expect(answer.metadata).toMatchObject({
      source: 'llm',
      provider: 'good-priority',
      model: 'test-model',
      tokensIn: 5,
      tokensOut: 3,
    });
    expect(answer.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    expect(llmCalls.some((url) => url.includes('bad.example'))).toBe(false);

    // Enabled first provider fails: the request falls through to the next one.
    await adminAgent.patch(`/api/v1/llm-providers/${bad.body.id}`).send({ enabled: true }).expect(200);
    llmCalls.length = 0;
    await postWebhook(payload('câu hỏi lần hai', 'mid-llm-2', 'psid-8'));
    await drain();
    detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    expect(detail.body.messages.at(-1).content).toBe('LLM trả lời ạ.');
    expect(llmCalls.some((url) => url.includes('bad.example'))).toBe(true);
    expect(llmCalls.some((url) => url.includes('good.example'))).toBe(true);

    const badTest = await adminAgent.post(`/api/v1/llm-providers/${bad.body.id}/test`).expect(201);
    expect(badTest.body.ok).toBe(false);
    const goodTest = await adminAgent.post(`/api/v1/llm-providers/${good.body.id}/test`).expect(201);
    expect(goodTest.body).toMatchObject({ ok: true, detail: 'Kết nối OK', result: { tokensIn: 5, tokensOut: 3 } });

    const listed = await adminAgent.get('/api/v1/llm-providers').expect(200);
    expect(listed.body).toHaveLength(2);
    expect(JSON.stringify(listed.body)).not.toContain('sk-good-secret');
    expect(JSON.stringify(listed.body)).not.toContain('sk-bad-secret');

    // Cleanup so the remaining tests stay rule-only.
    await adminAgent.delete(`/api/v1/llm-providers/${good.body.id}`).expect(200);
    await adminAgent.delete(`/api/v1/llm-providers/${bad.body.id}`).expect(200);
  });

  it('stores Page Inbox echo once and ignores mids already sent by the bot', async () => {
    await postWebhook(echoPayload('bản sao tin bot', 'provider-out-1'));
    await drain();
    const afterDuplicateEcho = await conversationByThread('psid-1');
    const before = afterDuplicateEcho.messageCount;

    await postWebhook(echoPayload('Dạ em trả lời từ Page Inbox', 'mid-echo-1'));
    await drain();
    const afterEcho = await conversationByThread('psid-1');
    expect(afterEcho.messageCount).toBe(before + 1);

    const detail = await agent.get(`/api/v1/conversations/${conversationId}`).expect(200);
    const echo = detail.body.messages.at(-1);
    expect(echo).toMatchObject({
      direction: 'out',
      senderType: 'agent',
      senderUserId: null,
      status: 'sent',
      content: 'Dạ em trả lời từ Page Inbox',
      metadata: { via: 'page_inbox' },
    });

    await postWebhook(echoPayload('Dạ em trả lời từ Page Inbox', 'mid-echo-1'));
    await drain();
    const afterRepeat = await conversationByThread('psid-1');
    expect(afterRepeat.messageCount).toBe(afterEcho.messageCount);
  });

  it('paginates by (created_at, id) and rejects a bad before cursor', async () => {
    const conversation = await conversationByThread('psid-1');
    const sameInstant = new Date();
    const inserted = await db
      .insert(messages)
      .values(
        Array.from({ length: 60 }, (_, i) => ({
          workspaceId,
          channelId: conversation.channelId,
          conversationId: conversation.id,
          direction: 'out' as const,
          senderType: 'system',
          content: `tie-${i}`,
          status: 'sent',
          createdAt: sameInstant,
        })),
      )
      .returning({ id: messages.id });

    const all = await db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, conversation.id));
    expect(all.length).toBeGreaterThan(50);

    const first = await agent.get(`/api/v1/conversations/${conversation.id}/messages`).expect(200);
    expect(first.body).toHaveLength(50);
    const second = await agent
      .get(`/api/v1/conversations/${conversation.id}/messages?before=${first.body[0].id}`)
      .expect(200);

    const seen = [...second.body, ...first.body].map((m: any) => m.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(all.map((m) => m.id)));
    for (const row of inserted) expect(seen).toContain(row.id);

    await agent.get(`/api/v1/conversations/${conversation.id}/messages?before=not-a-uuid`).expect(400);
    await agent
      .get(`/api/v1/conversations/${conversation.id}/messages?before=00000000-0000-7000-8000-000000000000`)
      .expect(400);
  });

  it('returns 404 for another tenant', async () => {
    const [other] = await db.insert(workspaces).values({ name: 'Tenant 2' }).returning();
    await db.insert(users).values({
      workspaceId: other.id,
      username: 'other',
      passwordHash: await argon2.hash('password123', { type: argon2.argon2id }),
    });
    const [otherBot] = await db.insert(bots).values({ workspaceId: other.id, name: 'Bot Tenant 2' }).returning();
    const otherAgent = request.agent(app.getHttpServer());
    await otherAgent
      .post('/api/v1/auth/login')
      .send({ username: 'other', password: 'password123' })
      .expect(201);

    await otherAgent.get(`/api/v1/conversations/${conversationId}`).expect(404);
    await otherAgent.get('/api/v1/bots').expect(200).expect((res) => {
      expect(res.body.items.map((b: { id: string }) => b.id)).toEqual([otherBot.id]);
    });
    // Cross-tenant bot and rule access is a 404, never a 403 leak.
    await otherAgent.get(`/api/v1/bots/${botId}`).expect(404);
    await otherAgent.patch(`/api/v1/bots/${botId}`).send({ name: 'hacked' }).expect(404);
    await otherAgent.get(`/api/v1/bots/${botId}/rules`).expect(404);
    await otherAgent.post(`/api/v1/bots/${botId}/rules`).send({ name: 'x', keywords: ['a b'], answer: 'y' }).expect(404);
    await otherAgent.delete(`/api/v1/bots/${botId}`).expect(404);
    // The last bot of a tenant cannot be deleted.
    await otherAgent.delete(`/api/v1/bots/${otherBot.id}`).expect(409);
    await otherAgent.get('/api/v1/conversations').expect(200).expect({ items: [], nextCursor: null });
  });

  it('enforces @Roles on every route', async () => {
    type Role = 'admin' | 'owner';
    const roleMap: Record<string, 'public' | Role[]> = {
      '/api/v1/auth/login': 'public',
      '/api/v1/auth/logout': ['admin', 'owner'],
      '/api/v1/auth/me': ['admin', 'owner'],
      '/api/v1/auth/change-password': ['admin', 'owner'],
      '/api/v1/auth/logout-others': ['admin', 'owner'],
      '/api/v1/audit-logs': ['admin'],
      '/api/v1/setup/status': 'public',
      '/api/v1/setup': 'public',
      '/api/v1/signup/status': 'public',
      '/api/v1/signup': 'public',
      '/api/v1/tenants': ['admin'],
      '/api/v1/tenants/:id': ['admin'],
      '/api/v1/tenants/:id/suspend': ['admin'],
      '/api/v1/tenants/:id/resume': ['admin'],
      '/api/v1/tenants/:id/reset-owner-password': ['admin'],
      '/api/v1/llm-providers': ['admin'],
      '/api/v1/llm-providers/:id': ['admin'],
      '/api/v1/llm-providers/:id/test': ['admin'],
      '/api/v1/llm-providers/usage': ['admin'],
      '/api/v1/llm-providers/models': ['admin'],
      '/api/v1/llm-providers/test': ['admin'],
      '/api/v1/bots': ['owner'],
      '/api/v1/bots/:botId': ['owner'],
      '/api/v1/bots/:botId/rules': ['owner'],
      '/api/v1/bots/:botId/rules/generate': ['owner'],
      '/api/v1/bots/:botId/rules/bulk': ['owner'],
      '/api/v1/bots/:botId/rules/bulk-update': ['owner'],
      '/api/v1/bots/:botId/rules/bulk-delete': ['owner'],
      '/api/v1/bots/:botId/rules/:id': ['owner'],
      '/api/v1/channels': ['owner'],
      '/api/v1/channels/:id': ['owner'],
      '/api/v1/channels/:id/test': ['owner'],
      '/api/v1/conversations': ['owner'],
      '/api/v1/conversations/options': ['owner'],
      '/api/v1/conversations/:id': ['owner'],
      '/api/v1/conversations/:id/messages': ['owner'],
      '/api/v1/conversations/:id/takeover': ['owner'],
      '/api/v1/conversations/:id/release': ['owner'],
      '/api/v1/stats/summary': ['owner'],
      '/webhooks/:provider': 'public',
      '/health': 'public',
    };

    const server: any = app.getHttpAdapter().getInstance();
    const stack = server.router?.stack ?? server._router?.stack ?? [];
    const methods = ['get', 'post', 'patch', 'delete'];
    const routes: Array<{ method: string; path: string }> = [];
    for (const layer of stack) {
      if (!layer.route) continue;
      const path = String(layer.route.path);
      if (path.includes('*') || path.includes('{') || path === '/api/v1/customers') continue;
      if (!path.startsWith('/api/v1/') && path !== '/health' && !path.startsWith('/webhooks/')) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (methods.includes(method)) routes.push({ method, path });
      }
    }
    expect(routes.length).toBeGreaterThan(25);

    const actualPaths = new Set(routes.map((r) => r.path));
    // A new endpoint must be added here with its expected roles...
    for (const route of routes) expect(Object.keys(roleMap)).toContain(route.path);
    // ...and stale entries are removed.
    for (const path of Object.keys(roleMap)) expect(actualPaths).toContain(path);

    const fakeId = '00000000-0000-7000-8000-000000000000';
    const actors: Array<[Role, ReturnType<typeof request.agent>]> = [
      ['admin', adminAgent],
      ['owner', agent],
    ];

    for (const route of routes) {
      // Executing logout would end the sessions the remaining tests still need.
      if (route.path === '/api/v1/auth/logout' || route.path === '/api/v1/auth/logout-others') continue;
      const expected = roleMap[route.path];
      if (expected === 'public') continue;
      const url = route.path.replace(':botId', fakeId).replace(':id', fakeId);
      const label = `${route.method.toUpperCase()} ${route.path}`;

      const anon = await (request(app.getHttpServer()) as any)[route.method](url);
      expect({ route: label, role: 'anon', status: anon.status }).toEqual({ route: label, role: 'anon', status: 401 });

      for (const [role, roleAgent] of actors) {
        const res = await (roleAgent as any)[route.method](url);
        if (expected.includes(role)) {
          expect({ route: label, role, status: res.status }).not.toMatchObject({ status: 403 });
        } else {
          expect({ route: label, role, status: res.status }).toMatchObject({ status: 403 });
        }
      }
    }
  });

  it('lists tenants once and redirects the old /customers route', async () => {
    const [extraBot] = await db.insert(bots).values({ workspaceId, name: 'Bot 2' }).returning();
    const list = await adminAgent.get('/api/v1/tenants?pageSize=100').expect(200);
    const matches = list.body.items.filter((t: { id: string }) => t.id === workspaceId);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ name: 'Shop 1', username: 'owner', status: 'trial', plan: 'trial', bots: 2 });
    expect(list.body).toMatchObject({ page: 1, pageSize: 100, total: list.body.items.length });
    const [platform] = await db.select().from(workspaces).where(eq(workspaces.isPlatform, true));
    expect(list.body.items.some((t: { id: string }) => t.id === platform.id)).toBe(false);

    // Search matches the owner username, status filters, and pages are bounded.
    const byOwner = await adminAgent.get('/api/v1/tenants?q=OWNER').expect(200);
    expect(byOwner.body.items.map((t: { id: string }) => t.id)).toContain(workspaceId);
    const none = await adminAgent.get('/api/v1/tenants?q=khong-ton-tai-%25').expect(200);
    expect(none.body).toMatchObject({ items: [], total: 0 });
    const suspended = await adminAgent.get('/api/v1/tenants?status=suspended').expect(200);
    expect(suspended.body.items.some((t: { id: string }) => t.id === workspaceId)).toBe(false);
    const paged = await adminAgent.get('/api/v1/tenants?pageSize=1&page=1').expect(200);
    expect(paged.body.items).toHaveLength(1);
    await adminAgent.get('/api/v1/tenants?status=bogus').expect(400);
    await adminAgent.get('/api/v1/tenants?pageSize=500').expect(400);

    const redirect = await request(app.getHttpServer()).get('/api/v1/customers').expect(308);
    expect(redirect.headers.location).toBe('/api/v1/tenants');
    const childRedirect = await request(app.getHttpServer()).get('/api/v1/customers/some-id').expect(308);
    expect(childRedirect.headers.location).toBe('/api/v1/tenants/some-id');

    await db.delete(bots).where(eq(bots.id, extraBot.id));
  });

  it('suspends a tenant: no login, and webhooks are stored but the bot stays silent', async () => {
    await adminAgent.post(`/api/v1/tenants/${workspaceId}/suspend`).expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'owner', password: 'password12345' })
      .expect(403);
    await agent.get('/api/v1/conversations').expect(401);
    await adminAgent.get('/api/v1/tenants').expect(200);

    await postWebhook(payload('giờ mở cửa', 'mid-suspended', 'psid-locked'));
    await drain();
    const conversation = await conversationByThread('psid-locked');
    expect(conversation).toMatchObject({ messageCount: 1, mode: 'bot' });

    const stored = await db.select().from(messages).where(eq(messages.conversationId, conversation.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ direction: 'in', senderType: 'customer', content: 'giờ mở cửa' });

    // A bot reply queued before the suspension must not reach the customer.
    const [bot] = await db.select().from(bots).where(eq(bots.workspaceId, workspaceId)).limit(1);
    const [queued] = await db
      .insert(messages)
      .values({
        workspaceId,
        channelId: conversation.channelId,
        conversationId: conversation.id,
        direction: 'out',
        senderType: 'bot',
        botId: bot.id,
        content: 'Tin đã xếp hàng từ trước',
        status: 'queued',
        metadata: {},
      })
      .returning();
    await db.insert(outbox).values({ workspaceId, kind: 'send_message', payload: { messageId: queued.id } });
    await drain();
    const [afterSend] = await db.select().from(messages).where(eq(messages.id, queued.id));
    expect(afterSend).toMatchObject({ status: 'failed', errorCode: 'tenant_blocked' });

    await adminAgent.post(`/api/v1/tenants/${workspaceId}/resume`).expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'owner', password: 'password12345' })
      .expect(201);
  });

  it('blocks a tenant past expires_at and lets admin recover it', async () => {
    await adminAgent
      .patch(`/api/v1/tenants/${workspaceId}`)
      .send({ expiresAt: '2020-01-01T00:00:00.000Z' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'owner', password: 'password12345' })
      .expect(403);
    await agent.get('/api/v1/conversations').expect(401);

    await postWebhook(payload('giờ mở cửa', 'mid-expired', 'psid-expired'));
    await drain();
    const conversation = await conversationByThread('psid-expired');
    expect(conversation).toMatchObject({ messageCount: 1, mode: 'bot' });

    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ expiresAt: null }).expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username: 'owner', password: 'password12345' })
      .expect(201);
  });

  it('keeps workspace users out of the tenant API', async () => {
    await agent.get('/api/v1/tenants').expect(403);
    await agent
      .post('/api/v1/tenants')
      .send({ name: 'X', username: 'newshop', password: 'password123' })
      .expect(403);
  });

  it('toggles and deletes many rules at once, only within the bot', async () => {
    const created = await agent
      .post(`/api/v1/bots/${botId}/rules/bulk`)
      .send({
        items: [
          { name: 'Hàng loạt 1', keywords: ['hang loat mot'], answer: '1' },
          { name: 'Hàng loạt 2', keywords: ['hang loat hai'], answer: '2' },
        ],
      })
      .expect(201);
    expect(created.body.created).toBe(2);
    const list = await agent.get(`/api/v1/bots/${botId}/rules`).expect(200);
    const ids = list.body
      .filter((r: { name: string }) => r.name.startsWith('Hàng loạt'))
      .map((r: { id: string }) => r.id);
    const missing = '00000000-0000-4000-8000-000000000000';

    await agent
      .post(`/api/v1/bots/${botId}/rules/bulk-update`)
      .send({ ids: [...ids, missing], enabled: false })
      .expect(201)
      .expect({ updated: 2 });
    const toggled = await agent.get(`/api/v1/bots/${botId}/rules`).expect(200);
    for (const id of ids) expect(toggled.body.find((r: { id: string }) => r.id === id).enabled).toBe(false);

    await agent.post(`/api/v1/bots/${botId}/rules/bulk-update`).send({ ids: ['khong-phai-uuid'], enabled: true }).expect(400);
    await agent.post(`/api/v1/bots/${botId}/rules/bulk-delete`).send({ ids: [] }).expect(400);

    await agent
      .post(`/api/v1/bots/${botId}/rules/bulk-delete`)
      .send({ ids: [...ids, missing] })
      .expect(201)
      .expect({ deleted: 2 });
    const after = await agent.get(`/api/v1/bots/${botId}/rules`).expect(200);
    expect(after.body.some((r: { id: string }) => ids.includes(r.id))).toBe(false);
  });

  it('imports many rules at once and rejects a bad row without partial writes', async () => {
    const before = await agent.get(`/api/v1/bots/${botId}/rules`).expect(200);
    await agent
      .post(`/api/v1/bots/${botId}/rules/bulk`)
      .send({
        items: [
          { name: 'Bulk A', keywords: ['bulk a1', 'bulk a2'], answer: 'A' },
          { name: 'Bulk B', keywords: ['bulk b1'], answer: 'B', priority: 5 },
        ],
      })
      .expect(201)
      .expect({ created: 2, updated: 0 });
    await agent
      .post(`/api/v1/bots/${botId}/rules/bulk`)
      .send({ items: [{ name: 'Bulk C', keywords: ['bulk c'], answer: 'C' }, { name: 'Thiếu answer', keywords: ['x y'] }] })
      .expect(400);
    await agent.post(`/api/v1/bots/${botId}/rules/bulk`).send({ items: [] }).expect(400);

    const after = await agent.get(`/api/v1/bots/${botId}/rules`).expect(200);
    expect(after.body.length).toBe(before.body.length + 2);
    const bulkB = after.body.find((r: { name: string }) => r.name === 'Bulk B');
    expect(bulkB).toMatchObject({ priority: 5, enabled: true });

    // Overwriting an existing rule happens in the same transaction as the inserts.
    await agent
      .post(`/api/v1/bots/${botId}/rules/bulk`)
      .send({
        items: [
          { replaceId: bulkB.id, name: 'Bulk B mới', keywords: ['bulk b2'], answer: 'B2', priority: 5 },
          { name: 'Bulk D', keywords: ['bulk d'], answer: 'D' },
        ],
      })
      .expect(201)
      .expect({ created: 1, updated: 1 });
    // A replaceId from another bot rolls back the whole batch.
    const foreign = await agent.post('/api/v1/bots').send({ name: 'Bot tạm' }).expect(201);
    const foreignRule = await agent
      .post(`/api/v1/bots/${foreign.body.id}/rules`)
      .send({ name: 'Ngoài', keywords: ['ngoai bot'], answer: 'x' })
      .expect(201);
    await agent
      .post(`/api/v1/bots/${botId}/rules/bulk`)
      .send({
        items: [
          { name: 'Bulk E', keywords: ['bulk e'], answer: 'E' },
          { replaceId: foreignRule.body.id, name: 'hack', keywords: ['hack it'], answer: 'x' },
        ],
      })
      .expect(404);
    await agent.delete(`/api/v1/bots/${foreign.body.id}`).expect(200);

    const final = await agent.get(`/api/v1/bots/${botId}/rules`).expect(200);
    const names = final.body.map((r: { name: string }) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Bulk A', 'Bulk B mới', 'Bulk D']));
    expect(names).not.toContain('Bulk B');
    expect(names).not.toContain('Bulk E');
    expect(final.body.find((r: { id: string }) => r.id === bulkB.id)).toMatchObject({ answer: 'B2' });
    for (const r of final.body.filter((r: { name: string }) => r.name.startsWith('Bulk'))) {
      await agent.delete(`/api/v1/bots/${botId}/rules/${r.id}`).expect(200);
    }
  });

  it('routes each channel to its own AI agent', async () => {
    const created = await agent.post('/api/v1/bots').send({ name: 'Bot bán hàng' }).expect(201);
    const secondBotId = created.body.id;
    await agent
      .post(`/api/v1/bots/${secondBotId}/rules`)
      .send({ name: 'Phí ship', keywords: ['phí ship', 'ship'], answer: 'Dạ ship 30k ạ.', priority: 10 })
      .expect(201);

    const listed = await agent.get('/api/v1/bots').expect(200);
    expect(listed.body.maxBots).toBeGreaterThanOrEqual(2);
    const second = listed.body.items.find((b: { id: string }) => b.id === secondBotId);
    expect(second).toMatchObject({ ruleCount: 1, channelCount: 0 });
    expect(listed.body.items.find((b: { id: string }) => b.id === botId).ruleCount).toBeGreaterThanOrEqual(1);

    const page2 = await agent
      .post('/api/v1/channels')
      .send({ provider: 'messenger', name: 'Page 2', externalId: 'PAGE2', botId, credentials: { accessToken: 'fake' } })
      .expect(201);
    const page3 = await agent
      .post('/api/v1/channels')
      .send({
        provider: 'messenger',
        name: 'Page 3',
        externalId: 'PAGE3',
        botId: secondBotId,
        credentials: { accessToken: 'fake' },
      })
      .expect(201);

    await postWebhook(payload('giờ mở cửa', 'mid-multi-1', 'psid-multi-1', 'PAGE2'));
    await postWebhook(payload('phí ship bao nhiêu', 'mid-multi-2', 'psid-multi-2', 'PAGE3'));
    await drain();

    const firstConversation = await conversationByThread('psid-multi-1');
    const firstDetail = await agent.get(`/api/v1/conversations/${firstConversation.id}`).expect(200);
    expect(firstDetail.body.messages.at(-1)).toMatchObject({ content: 'Dạ shop mở 8h-20h ạ.', botId });

    const secondConversation = await conversationByThread('psid-multi-2');
    const secondDetail = await agent.get(`/api/v1/conversations/${secondConversation.id}`).expect(200);
    expect(secondDetail.body.messages.at(-1)).toMatchObject({ content: 'Dạ ship 30k ạ.', botId: secondBotId });
    expect(secondDetail.body.botId).toBe(secondBotId);

    for (const channelId of [page2.body.id, page3.body.id]) {
      await db.delete(webhookEvents).where(eq(webhookEvents.channelId, channelId));
      await db.delete(messages).where(eq(messages.channelId, channelId));
      await db.delete(conversations).where(eq(conversations.channelId, channelId));
      await db.delete(customers).where(eq(customers.channelId, channelId));
      await db.delete(channels).where(eq(channels.id, channelId));
    }
    await db.delete(botRules).where(eq(botRules.botId, secondBotId));
    await db.delete(bots).where(eq(bots.id, secondBotId));
  });

  it('enforces plan limits, concurrent creates and protects agents in use', async () => {
    // A bot still attached to a channel cannot be deleted.
    await agent.delete(`/api/v1/bots/${botId}`).expect(409);

    // One free slot: two concurrent creates must not both pass.
    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ maxBots: 2 }).expect(200);
    const [first, second] = await Promise.all([
      agent.post('/api/v1/bots').send({ name: 'Song song 1' }),
      agent.post('/api/v1/bots').send({ name: 'Song song 2' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 403]);
    const createdBotId = (first.status === 201 ? first : second).body.id;

    await agent.post('/api/v1/bots').send({ name: 'Vượt gói' }).expect(403);

    // A bot with messages is soft deleted so the message history keeps its bot_id.
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
    await db.insert(messages).values({
      workspaceId,
      channelId: conversation.channelId,
      conversationId,
      direction: 'out',
      senderType: 'bot',
      botId: createdBotId,
      content: 'Tin cũ của bot',
      status: 'sent',
      metadata: {},
    });
    await agent.delete(`/api/v1/bots/${createdBotId}`).expect(200);
    const afterDelete = await agent.get('/api/v1/bots').expect(200);
    expect(afterDelete.body.items.some((b: { id: string }) => b.id === createdBotId)).toBe(false);
    const [softDeleted] = await db.select().from(bots).where(eq(bots.id, createdBotId));
    expect(softDeleted.deletedAt).toBeTruthy();

    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ maxBots: 1 }).expect(200);

    const channelsNow = await agent.get('/api/v1/channels').expect(200);
    const used = channelsNow.body.items.filter((c: { status: string }) => c.status !== 'disabled').length;
    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ maxChannels: used + 1 }).expect(200);
    const allowedChannel = await agent
      .post('/api/v1/channels')
      .send({
        provider: 'messenger',
        name: 'Page giới hạn',
        externalId: 'PAGE-LIMIT-1',
        botId,
        credentials: { accessToken: 'fake' },
      })
      .expect(201);
    await agent
      .post('/api/v1/channels')
      .send({
        provider: 'messenger',
        name: 'Page vượt',
        externalId: 'PAGE-LIMIT-2',
        botId,
        credentials: { accessToken: 'fake' },
      })
      .expect(403);

    await db.delete(channels).where(eq(channels.id, allowedChannel.body.id));
    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ maxChannels: 10 }).expect(200);
  });

  it('disables a used channel instead of deleting its history', async () => {
    const channel = await agent
      .post('/api/v1/channels')
      .send({
        provider: 'messenger',
        name: 'Page xoá',
        externalId: 'PAGE-DEL',
        botId,
        credentials: { accessToken: 'fake' },
      })
      .expect(201);

    await postWebhook(payload('giờ mở cửa', 'mid-del-1', 'psid-del', 'PAGE-DEL'));
    await drain();
    const conversation = await conversationByThread('psid-del');
    const before = await db.select().from(messages).where(eq(messages.conversationId, conversation.id));
    expect(before.length).toBeGreaterThan(1);

    const removed = await agent.delete(`/api/v1/channels/${channel.body.id}`).expect(200);
    expect(removed.body).toMatchObject({ disabled: true, status: 'disabled' });
    const [storedChannel] = await db.select().from(channels).where(eq(channels.id, channel.body.id));
    expect(storedChannel.status).toBe('disabled');
    const after = await db.select().from(messages).where(eq(messages.conversationId, conversation.id));
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));

    // A disabled channel still stores inbound messages but never answers.
    await postWebhook(payload('giờ mở cửa', 'mid-del-2', 'psid-del-2', 'PAGE-DEL'));
    await drain();
    const silent = await conversationByThread('psid-del-2');
    const stored = await db.select().from(messages).where(eq(messages.conversationId, silent.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ direction: 'in', senderType: 'customer' });
  });

  it('enforces the channel limit when re-activating and never re-enables a disabled channel', async () => {
    const list = await agent.get('/api/v1/channels').expect(200);
    const page1 = list.body.items.find((c: { externalId: string }) => c.externalId === 'PAGE1');
    const disabled = list.body.items.find((c: { externalId: string }) => c.externalId === 'PAGE-DEL');
    expect(page1).toBeTruthy();
    expect(disabled.status).toBe('disabled');

    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ maxChannels: 1 }).expect(200);
    await agent.patch(`/api/v1/channels/${page1.id}`).send({ status: 'disabled' }).expect(200);

    const fresh = await agent
      .post('/api/v1/channels')
      .send({
        provider: 'messenger',
        name: 'Page bật lại',
        externalId: 'PAGE-REACT-B',
        botId,
        credentials: { accessToken: 'fake' },
      })
      .expect(201);

    // Both disabled channels would exceed the single slot when turned back on.
    await agent.patch(`/api/v1/channels/${page1.id}`).send({ status: 'active' }).expect(403);
    await agent.patch(`/api/v1/channels/${disabled.id}`).send({ status: 'active' }).expect(403);

    // A health check must not silently re-enable a channel the tenant disabled.
    const checked = await agent.post(`/api/v1/channels/${page1.id}/test`).expect(201);
    expect(checked.body.ok).toBe(true);
    const [stillDisabled] = await db.select().from(channels).where(eq(channels.id, page1.id));
    expect(stillDisabled.status).toBe('disabled');

    await db.delete(channels).where(eq(channels.id, fresh.body.id));
    await agent.patch(`/api/v1/channels/${page1.id}`).send({ status: 'active' }).expect(200);
    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ maxChannels: 10 }).expect(200);
  });

  it('rejects a live Page ID used by another tenant and keeps its webhook in the owner workspace', async () => {
    const tenant = await adminAgent
      .post('/api/v1/tenants')
      .send({ name: 'Shop 2', username: 'owner2', password: 'password12345', maxBots: 10, maxChannels: 10 })
      .expect(201);
    const otherAgent = request.agent(app.getHttpServer());
    await otherAgent
      .post('/api/v1/auth/login')
      .send({ username: 'owner2', password: 'password12345' })
      .expect(201);
    const [otherBot] = await db.select().from(bots).where(eq(bots.workspaceId, tenant.body.id));

    await otherAgent
      .post('/api/v1/channels')
      .send({
        provider: 'messenger',
        name: 'Page trùng',
        externalId: 'PAGE1',
        botId: otherBot.id,
        credentials: { accessToken: 'fake' },
      })
      .expect(409);

    // A disabled Page is released, so tenant B may claim it; tenant A can no longer re-enable it.
    await otherAgent
      .post('/api/v1/channels')
      .send({
        provider: 'messenger',
        name: 'Page cũ',
        externalId: 'PAGE-DEL',
        botId: otherBot.id,
        credentials: { accessToken: 'fake' },
      })
      .expect(201);
    const listA = await agent.get('/api/v1/channels').expect(200);
    const oldPage = listA.body.items.find((c: { externalId: string }) => c.externalId === 'PAGE-DEL');
    await agent.patch(`/api/v1/channels/${oldPage.id}`).send({ status: 'active' }).expect(409);

    // The real Page still resolves to tenant A, never to the would-be duplicate.
    await postWebhook(payload('giờ mở cửa', 'mid-secure-1', 'psid-secure', 'PAGE1'));
    await drain();
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.externalThreadId, 'psid-secure'));
    expect(conversation.workspaceId).toBe(workspaceId);
    const detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    expect(detail.body.messages.at(-1)).toMatchObject({ content: 'Dạ shop mở 8h-20h ạ.', botId });

    await db.delete(channels).where(eq(channels.workspaceId, tenant.body.id));
    await db.delete(bots).where(eq(bots.workspaceId, tenant.body.id));
    await db.delete(users).where(eq(users.workspaceId, tenant.body.id));
    await db.delete(workspaces).where(eq(workspaces.id, tenant.body.id));
  });

  it('gives a new bot the default tone persona', async () => {
    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ maxBots: 2 }).expect(200);
    const created = await agent.post('/api/v1/bots').send({ name: 'Bot mặc định' }).expect(201);
    expect(created.body.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    await agent.delete(`/api/v1/bots/${created.body.id}`).expect(200);
    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ maxBots: 1 }).expect(200);
  });

  it('sends the tenant persona before the platform rules', async () => {
    const provider = await adminAgent
      .post('/api/v1/llm-providers')
      .send({
        name: 'persona-provider',
        baseUrl: 'https://good.example/v1',
        model: 'persona-model',
        apiKey: 'sk-persona-1234',
        priority: 50,
      })
      .expect(201);

    await agent
      .patch(`/api/v1/bots/${botId}`)
      .send({ systemPrompt: 'Bạn là nhân viên tư vấn của shop Hoa Sen.' })
      .expect(200);

    llmCalls.length = 0;
    llmBodies.length = 0;
    await postWebhook(payload('một câu hỏi tự do', 'mid-persona-1', 'psid-persona'));
    await drain();

    const conversation = await conversationByThread('psid-persona');
    const detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    expect(detail.body.messages.at(-1).metadata.source).toBe('llm');
    expect(llmBodies.length).toBeGreaterThan(0);

    const body = JSON.parse(llmBodies.at(-1) as string);
    const system = body.messages.find((m: { role: string }) => m.role === 'system').content as string;
    const personaAt = system.indexOf('shop Hoa Sen');
    const platformAt = system.indexOf('Các luật bắt buộc của nền tảng');
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(platformAt).toBeGreaterThan(personaAt);

    await agent.patch(`/api/v1/bots/${botId}`).send({ systemPrompt: '' }).expect(200);
    await adminAgent.delete(`/api/v1/llm-providers/${provider.body.id}`).expect(200);
  });

  it('rejects a system prompt longer than 4000 characters', async () => {
    await agent
      .patch(`/api/v1/bots/${botId}`)
      .send({ systemPrompt: 'a'.repeat(4001) })
      .expect(400);
  });

  it('paces a rule answer, attaches its quick replies and shows typing first', async () => {
    await agent
      .post(`/api/v1/bots/${botId}/rules`)
      .send({ name: 'QR quá dài', keywords: ['abc xyz'], answer: 'x', quickReplies: ['a'.repeat(21)] })
      .expect(400);
    await agent
      .post(`/api/v1/bots/${botId}/rules`)
      .send({
        name: 'Khuyến mãi',
        keywords: ['khuyến mãi tháng'],
        answer: 'Dạ tháng này giảm giá mười phần trăm ạ.',
        quickReplies: [' Phí ship ', 'Gặp nhân viên', 'Phí ship'],
      })
      .expect(201);

    graphCalls.length = 0;
    await postWebhook(payload('khuyến mãi tháng này', 'mid-qr-1', 'psid-qr'));
    const before = Date.now();
    await worker.tick(); // processes the event only; replies are scheduled ahead

    const conversation = await conversationByThread('psid-qr');
    const queued = await db
      .select({ nextAttemptAt: outbox.nextAttemptAt })
      .from(outbox)
      .innerJoin(messages, sql`${outbox.payload}->>'messageId' = ${messages.id}::text`)
      .where(eq(messages.conversationId, conversation.id));
    expect(queued.length).toBeGreaterThan(0);
    for (const job of queued) expect(job.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 700);

    await drain();
    const actions = graphCalls.filter((c) => c.body?.sender_action).map((c) => c.body.sender_action);
    expect(actions.slice(0, 2)).toEqual(['mark_seen', 'typing_on']);
    const sends = graphCalls.filter((c) => c.body?.message);
    expect(sends.at(-1)?.body.message).toEqual({
      text: 'Dạ tháng này giảm giá mười phần trăm ạ.',
      quick_replies: [
        { content_type: 'text', title: 'Phí ship', payload: 'Phí ship' },
        { content_type: 'text', title: 'Gặp nhân viên', payload: 'Gặp nhân viên' },
      ],
    });
    // The greeting before it carries no buttons: Messenger drops them as soon as the next message arrives.
    expect(sends.at(-2)?.body.message.quick_replies).toBeUndefined();
  });

  it('splits a long answer into several messages sent in order', async () => {
    const first = 'Phần một. ' + 'a'.repeat(290);
    const second = 'Phần hai. ' + 'b'.repeat(290);
    await agent
      .post(`/api/v1/bots/${botId}/rules`)
      .send({ name: 'Bảo hành', keywords: ['chính sách bảo hành'], answer: `${first}\n\n${second}` })
      .expect(201);

    graphCalls.length = 0;
    await postWebhook(payload('chính sách bảo hành thế nào', 'mid-split-1', 'psid-split'));
    await drain();

    const conversation = await conversationByThread('psid-split');
    const detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    const answers = detail.body.messages.filter((m: any) => m.metadata.kind === 'answer');
    expect(answers.map((m: any) => m.content)).toEqual([first, second]);
    expect(answers.map((m: any) => m.status)).toEqual(['sent', 'sent']);
    expect(answers[0].metadata).toMatchObject({ source: 'rule', part: 1, parts: 2 });
    expect(answers[1].metadata).toMatchObject({ source: 'rule', part: 2, parts: 2 });
    const texts = graphCalls.filter((c) => c.body?.message).map((c) => c.body.message.text);
    expect(texts.slice(-2)).toEqual([first, second]);
    // Typing comes back on between the two parts.
    const secondSend = graphCalls.findIndex((c) => c.body?.message?.text === second);
    expect(graphCalls[secondSend - 1].body).toMatchObject({ sender_action: 'typing_on' });
  });

  it('answers Get Started with the greeting and its buttons without counting a fallback', async () => {
    await agent
      .patch(`/api/v1/bots/${botId}`)
      .send({ greeting: 'Dạ em chào anh/chị ạ.', greetingQuickReplies: ['Giờ mở cửa', 'Khuyến mãi'] })
      .expect(200);
    await postWebhook({
      object: 'page',
      entry: [
        {
          id: 'PAGE1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'psid-start' },
              recipient: { id: 'PAGE1' },
              timestamp: Date.now(),
              postback: { mid: 'mid-start-1', title: 'Bắt đầu', payload: 'GET_STARTED' },
            },
          ],
        },
      ],
    });
    await drain();

    const conversation = await conversationByThread('psid-start');
    const detail = await agent.get(`/api/v1/conversations/${conversation.id}`).expect(200);
    expect(detail.body.messages.map((m: any) => [m.senderType, m.content])).toEqual([
      ['customer', 'Bắt đầu'],
      ['bot', 'Dạ em chào anh/chị ạ.'],
    ]);
    expect(detail.body.messages[1].metadata).toMatchObject({ kind: 'greeting', quickReplies: ['Giờ mở cửa', 'Khuyến mãi'] });
    expect(detail.body.messages[1].status).toBe('sent');
    expect(conversation.fallbackCount).toBe(0);

    await agent.patch(`/api/v1/bots/${botId}`).send({ greetingQuickReplies: [] }).expect(200);
  });

  it('pushes Get Started and the menu to Meta and keeps them on later channel edits', async () => {
    const list = await agent.get('/api/v1/channels').expect(200);
    const page = list.body.items.find((c: any) => c.externalId === 'PAGE1');

    const bad = await agent
      .put(`/api/v1/channels/${page.id}/messenger-profile`)
      .send({ getStarted: true, persistentMenu: [{ title: 'x'.repeat(31) }, { title: 'Web', url: 'http://insecure.example' }] })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('30 ký tự');
    expect(JSON.stringify(bad.body)).toContain('https');

    graphCalls.length = 0;
    const menu = [{ title: 'Giờ mở cửa' }, { title: 'Website', url: 'https://shop.example' }];
    const saved = await agent
      .put(`/api/v1/channels/${page.id}/messenger-profile`)
      .send({ getStarted: false, persistentMenu: menu })
      .expect(200);
    expect(saved.body.config.messengerProfile).toEqual({ getStarted: false, persistentMenu: menu });
    const call = graphCalls.find((c) => c.url.includes('/messenger_profile'));
    expect(call?.body.get_started).toEqual({ payload: 'GET_STARTED' });
    expect(call?.body.persistent_menu[0].call_to_actions).toHaveLength(2);

    await agent.patch(`/api/v1/channels/${page.id}`).send({ config: {} }).expect(200);
    const after = await agent.get('/api/v1/channels').expect(200);
    expect(after.body.items.find((c: any) => c.id === page.id).config.messengerProfile).toEqual({
      getStarted: false,
      persistentMenu: menu,
    });

    await agent
      .put(`/api/v1/channels/${page.id}/messenger-profile`)
      .send({ getStarted: false, persistentMenu: [] })
      .expect(200);
  });

  it('changes the password, keeps the current session and ends the others', async () => {
    // Login is rate limited per IP across the whole suite, so extra sessions are inserted directly.
    const [pwUser] = await db
      .insert(users)
      .values({ workspaceId, username: 'pwuser', passwordHash: await argon2.hash('oldpass123', { type: argon2.argon2id }) })
      .returning();
    const extraSession = async () => {
      const token = randomToken();
      await db.insert(sessions).values({ userId: pwUser.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 3600_000) });
      return (path: string) => request(app.getHttpServer()).get(path).set('Cookie', `bv_session=${token}`);
    };
    const main = request.agent(app.getHttpServer());
    await main.post('/api/v1/auth/login').send({ username: 'pwuser', password: 'oldpass123' }).expect(201);
    const other = await extraSession();

    const wrong = await main
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'nope12345', newPassword: 'newpass123' })
      .expect(400);
    expect(wrong.body.message).toBe('Mật khẩu hiện tại không đúng');
    await main.post('/api/v1/auth/change-password').send({ currentPassword: 'oldpass123', newPassword: 'short1' }).expect(400);
    await main.post('/api/v1/auth/change-password').send({ currentPassword: 'oldpass123', newPassword: 'oldpass123' }).expect(400);

    const ok = await main
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'oldpass123', newPassword: 'newpass123' })
      .expect(201);
    expect(ok.body).toEqual({ ok: true, revokedSessions: 1 });
    await main.get('/api/v1/auth/me').expect(200);
    await other('/api/v1/auth/me').expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ username: 'pwuser', password: 'oldpass123' }).expect(401);
    const [stored] = await db.select().from(users).where(eq(users.id, pwUser.id));
    expect(await argon2.verify(stored.passwordHash, 'newpass123')).toBe(true);

    const third = await extraSession();
    const revoked = await main.post('/api/v1/auth/logout-others').expect(201);
    expect(revoked.body).toEqual({ ok: true, revokedSessions: 1 });
    await third('/api/v1/auth/me').expect(401);
    await main.get('/api/v1/auth/me').expect(200);

    const logs = await adminAgent.get('/api/v1/audit-logs?q=pwuser&pageSize=100').expect(200);
    const actions = logs.body.items.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.password_changed', 'auth.sessions_revoked', 'auth.login', 'auth.login_failed']));
    await db.delete(users).where(eq(users.id, pwUser.id));
  });

  it('records admin actions in the audit log without secrets', async () => {
    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ plan: 'pro-audit' }).expect(200);
    const created = await adminAgent
      .post('/api/v1/llm-providers')
      .send({ name: 'audit-provider', baseUrl: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'sk-secret-audit' })
      .expect(201);
    await adminAgent.delete(`/api/v1/llm-providers/${created.body.id}`).expect(200);

    const res = await adminAgent.get('/api/v1/audit-logs?pageSize=100').expect(200);
    const updated = res.body.items.find((l: { action: string; targetId: string }) => l.action === 'tenant.updated' && l.targetId === workspaceId);
    expect(updated).toMatchObject({ actorUsername: 'admin', targetLabel: 'Shop 1', targetType: 'tenant' });
    expect(updated.metadata.changes.plan.to).toBe('pro-audit');
    const providerLogs = res.body.items.filter((l: { targetId: string }) => l.targetId === created.body.id);
    expect(providerLogs.map((l: { action: string }) => l.action).sort()).toEqual(['provider.created', 'provider.deleted']);
    expect(JSON.stringify(res.body)).not.toContain('sk-secret-audit');

    const filtered = await adminAgent.get('/api/v1/audit-logs?action=provider.deleted').expect(200);
    expect(filtered.body.items.every((l: { action: string }) => l.action === 'provider.deleted')).toBe(true);
    await adminAgent.get('/api/v1/audit-logs?action=bogus').expect(400);
    await agent.get('/api/v1/audit-logs').expect(403);

    await adminAgent.patch(`/api/v1/tenants/${workspaceId}`).send({ plan: 'trial' }).expect(200);
    await db.delete(auditLogs);
  });

  it('disables setup once an admin exists', async () => {
    const status = await request(app.getHttpServer()).get('/api/v1/setup/status').expect(200);
    expect(status.body.needsSetup).toBe(false);
    await request(app.getHttpServer())
      .post('/api/v1/setup')
      .send({
        username: 'late',
        password: 'password12345',
        confirmPassword: 'password12345',
        setupToken: 'setup-token',
      })
      .expect(403);
  });

  it('rejects an unauthenticated admin call', async () => {
    await request(app.getHttpServer()).get('/api/v1/conversations').expect(401);
  });

  describe('conversation screen (step 5)', () => {
    let channelId = '';
    let otherChannelId = '';
    let otherConversationId = '';
    let extraBotId = '';
    let ids: Record<'a' | 'b' | 'c' | 'd', string>;

    const sorted = (...values: string[]) => [...values].sort();

    const list = async (query: string) => (await agent.get(`/api/v1/conversations?${query}`).expect(200)).body;
    const listIds = async (query: string) => (await list(query)).items.map((item: { id: string }) => item.id).sort();
    const searchIds = (text: string) => listIds(`search=${encodeURIComponent(text)}`);

    const makeConversation = async (
      key: string,
      values: { mode: string; botId?: string | null; assignedUserId?: string | null; displayName: string; last: string },
    ) => {
      const [customer] = await db
        .insert(customers)
        .values({
          workspaceId,
          channelId,
          externalUserId: `step5-${key}`,
          displayName: values.displayName,
        })
        .returning();
      const [conversation] = await db
        .insert(conversations)
        .values({
          workspaceId,
          channelId,
          customerId: customer.id,
          externalThreadId: `psid-step5-${key}`,
          mode: values.mode,
          botId: values.botId,
          assignedUserId: values.assignedUserId,
          lastMessageAt: new Date(values.last),
        })
        .returning();
      return conversation.id;
    };

    beforeAll(async () => {
      const [extraBot] = await db.insert(bots).values({ workspaceId, name: 'Bot phụ' }).returning();
      extraBotId = extraBot.id;
      const [channel] = await db
        .insert(channels)
        .values({ workspaceId, provider: 'messenger', name: 'Kênh phụ', externalId: 'PAGE-STEP5', botId: extraBot.id })
        .returning();
      channelId = channel.id;

      ids = {
        a: await makeConversation('a', {
          mode: 'bot',
          botId,
          displayName: 'Khách Bước Năm',
          last: '2026-01-10T10:00:00Z',
        }),
        b: await makeConversation('b', {
          mode: 'human',
          botId: extraBot.id,
          assignedUserId: ownerUserId,
          displayName: 'Khách B',
          last: '2026-01-11T10:00:00Z',
        }),
        c: await makeConversation('c', { mode: 'off', displayName: 'Khách C', last: '2026-01-12T10:00:00Z' }),
        d: await makeConversation('d', { mode: 'off', displayName: 'Khách D', last: '2026-01-12T10:00:00Z' }),
      };

      // Another tenant with the same message content must never leak into search results.
      const [otherWorkspace] = await db.insert(workspaces).values({ name: 'Tenant bước 5' }).returning();
      const [otherChannel] = await db
        .insert(channels)
        .values({
          workspaceId: otherWorkspace.id,
          provider: 'messenger',
          name: 'Kênh tenant khác',
          externalId: 'PAGE-OTHER-STEP5',
        })
        .returning();
      otherChannelId = otherChannel.id;
      const [otherCustomer] = await db
        .insert(customers)
        .values({
          workspaceId: otherWorkspace.id,
          channelId: otherChannel.id,
          externalUserId: 'other-step5',
          displayName: 'Khách tenant khác',
        })
        .returning();
      const [otherConversation] = await db
        .insert(conversations)
        .values({
          workspaceId: otherWorkspace.id,
          channelId: otherChannel.id,
          customerId: otherCustomer.id,
          externalThreadId: 'psid-other-step5',
          lastMessageAt: new Date('2026-01-12T10:00:00Z'),
        })
        .returning();
      otherConversationId = otherConversation.id;
      await db.insert(messages).values({
        workspaceId: otherWorkspace.id,
        channelId: otherChannel.id,
        conversationId: otherConversation.id,
        direction: 'in',
        senderType: 'customer',
        content: 'mã giảm giá XYZ123',
        status: 'received',
      });

      const at = (value: string) => new Date(value);
      await db.insert(messages).values([
        {
          workspaceId,
          channelId,
          conversationId: ids.b,
          direction: 'in' as const,
          senderType: 'customer',
          content: 'khách hỏi',
          status: 'received',
          createdAt: at('2026-01-11T09:00:01Z'),
        },
        {
          workspaceId,
          channelId,
          conversationId: ids.b,
          direction: 'out' as const,
          senderType: 'bot',
          botId: extraBot.id,
          content: 'bot trả lời',
          status: 'sent',
          createdAt: at('2026-01-11T09:00:02Z'),
        },
        {
          workspaceId,
          channelId,
          conversationId: ids.b,
          direction: 'out' as const,
          senderType: 'agent',
          senderUserId: ownerUserId,
          content: 'nhân viên trả lời',
          status: 'sent',
          createdAt: at('2026-01-11T09:00:03Z'),
        },
        {
          workspaceId,
          channelId,
          conversationId: ids.b,
          direction: 'out' as const,
          senderType: 'system',
          content: 'hệ thống ghi nhận',
          status: 'sent',
          createdAt: at('2026-01-11T09:00:04Z'),
        },
        {
          workspaceId,
          channelId,
          conversationId: ids.b,
          direction: 'out' as const,
          senderType: 'agent',
          senderUserId: null,
          content: 'page inbox trả lời',
          status: 'sent',
          metadata: { via: 'page_inbox' },
          createdAt: at('2026-01-11T09:00:05Z'),
        },
        {
          workspaceId,
          channelId,
          conversationId: ids.b,
          direction: 'in' as const,
          senderType: 'customer',
          content: 'mã giảm giá XYZ123',
          status: 'received',
          createdAt: at('2026-01-11T09:00:20Z'),
        },
        {
          workspaceId,
          channelId,
          conversationId: ids.a,
          direction: 'in' as const,
          senderType: 'customer',
          content: 'giảm 50% hôm nay',
          status: 'received',
          createdAt: at('2026-01-10T09:00:00Z'),
        },
      ]);
    });

    it('filters, searches and paginates without losing tied rows', async () => {
      expect(await listIds(`channelId=${channelId}`)).toEqual(sorted(ids.a, ids.b, ids.c, ids.d));
      expect(await listIds(`channelId=${channelId}&botId=${extraBotId}`)).toEqual(sorted(ids.b));
      expect(await listIds(`channelId=${channelId}&mode=human`)).toEqual(sorted(ids.b));
      expect(await listIds(`channelId=${channelId}&mode=off`)).toEqual(sorted(ids.c, ids.d));
      expect(await listIds(`channelId=${channelId}&assignedUserId=${ownerUserId}`)).toEqual(sorted(ids.b));
      expect(await listIds(`channelId=${channelId}&from=2026-01-11&to=2026-01-11`)).toEqual(sorted(ids.b));
      expect(await listIds(`channelId=${channelId}&from=2026-01-12`)).toEqual(sorted(ids.c, ids.d));

      // Ids outside the session workspace return an empty page, not a 500.
      expect(await list(`channelId=${otherChannelId}`)).toMatchObject({ items: [], nextCursor: null });
      expect(await list('botId=00000000-0000-7000-8000-000000000000')).toMatchObject({
        items: [],
        nextCursor: null,
      });
      expect(await list('assignedUserId=00000000-0000-7000-8000-000000000000')).toMatchObject({
        items: [],
        nextCursor: null,
      });

      // Search covers customer name, external id and message content, scoped to the workspace.
      expect(await searchIds('Khách Bước Năm')).toEqual(sorted(ids.a));
      expect(await searchIds('step5-a')).toEqual(sorted(ids.a));
      expect(await searchIds('XYZ123')).toEqual(sorted(ids.b));
      expect(await searchIds('XYZ123')).not.toContain(otherConversationId);
      // User input is literal: % and _ must not act as wildcards.
      expect(await searchIds('50%')).toEqual(sorted(ids.a));
      expect(await searchIds('%')).toEqual(sorted(ids.a));

      const rowB = (await list(`channelId=${channelId}&botId=${extraBotId}`)).items[0];
      expect(rowB).toMatchObject({
        channelName: 'Kênh phụ',
        botName: 'Bot phụ',
        assignedUserName: 'owner',
        lastMessage: 'mã giảm giá XYZ123',
      });

      const page1 = await list(`channelId=${channelId}&limit=2`);
      expect(page1.items).toHaveLength(2);
      expect(page1.items.map((item: { id: string }) => item.id).sort()).toEqual(sorted(ids.c, ids.d));
      expect(page1.nextCursor).toBeTruthy();
      const page2 = await list(`channelId=${channelId}&limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`);
      const seen = [...page1.items, ...page2.items].map((item: { id: string }) => item.id);
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
      expect(new Set(seen)).toEqual(new Set([ids.a, ids.b, ids.c, ids.d]));
      expect(page2.nextCursor).toBeNull();

      await agent.get('/api/v1/conversations?cursor=garbage').expect(400);
      const badCursor = Buffer.from(JSON.stringify({ at: '2026-01-01T00:00:00.000Z', id: 'nope' })).toString(
        'base64url',
      );
      await agent.get(`/api/v1/conversations?cursor=${badCursor}`).expect(400);

      await adminAgent.get('/api/v1/conversations/options').expect(403);
    });

    it('names every message sender and returns failure details', async () => {
      const res = await agent.get(`/api/v1/conversations/${ids.b}/messages`).expect(200);
      const byContent = Object.fromEntries(res.body.map((m: { content: string; senderName: string }) => [m.content, m.senderName]));
      expect(byContent).toMatchObject({
        'khách hỏi': 'Khách',
        'bot trả lời': 'Bot phụ',
        'nhân viên trả lời': 'owner',
        'hệ thống ghi nhận': 'Hệ thống',
        'page inbox trả lời': 'Page Inbox',
      });
      expect(res.body.find((m: { content: string }) => m.content === 'page inbox trả lời')).toMatchObject({
        senderType: 'agent',
        status: 'sent',
        errorCode: null,
        metadata: { via: 'page_inbox' },
      });
    });

    it('ignores a webhook when two disabled channels share the page id', async () => {
      const [wsA] = await db.insert(workspaces).values({ name: 'Tenant disabled A' }).returning();
      const [wsB] = await db.insert(workspaces).values({ name: 'Tenant disabled B' }).returning();
      await db.insert(channels).values([
        {
          workspaceId: wsA.id,
          provider: 'messenger',
          name: 'Kênh tắt A',
          externalId: 'PAGE-DUP-OFF',
          status: 'disabled',
        },
        {
          workspaceId: wsB.id,
          provider: 'messenger',
          name: 'Kênh tắt B',
          externalId: 'PAGE-DUP-OFF',
          status: 'disabled',
        },
      ]);

      const body = JSON.stringify(payload('tin trùng', 'mid-dup-off', 'psid-dup-off', 'PAGE-DUP-OFF'));
      const res = await request(app.getHttpServer())
        .post('/webhooks/messenger')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', sign(body))
        .send(body)
        .expect(201);
      expect(res.body).toMatchObject({ ok: true, ignored: true });
      await drain();

      const rows = await db
        .select()
        .from(conversations)
        .where(inArray(conversations.workspaceId, [wsA.id, wsB.id]));
      expect(rows).toHaveLength(0);
    });

    it('treats from/to days as workspace-local days', async () => {
      const [channel] = await db
        .insert(channels)
        .values({ workspaceId, provider: 'messenger', name: 'Kênh giờ VN', externalId: 'PAGE-TZ', botId })
        .returning();
      const [customer] = await db
        .insert(customers)
        .values({ workspaceId, channelId: channel.id, externalUserId: 'step5-tz', displayName: 'Khách TZ' })
        .returning();
      // 06:00 on 11/01 in Vietnam, still 10/01 in UTC.
      const [conversation] = await db
        .insert(conversations)
        .values({
          workspaceId,
          channelId: channel.id,
          customerId: customer.id,
          externalThreadId: 'psid-step5-tz',
          lastMessageAt: new Date('2026-01-10T23:00:00Z'),
        })
        .returning();

      expect(await listIds(`channelId=${channel.id}&from=2026-01-11&to=2026-01-11`)).toEqual([conversation.id]);
      expect(await listIds(`channelId=${channel.id}&from=2026-01-10&to=2026-01-10`)).toEqual([]);
      expect(await listIds(`channelId=${channel.id}&to=2026-01-10`)).toEqual([]);
    });
  });

  describe('tenant isolation and admin visibility (step 6)', () => {
    const SECRET_TENANT_CONTENT = 'BÍ-MẬT-NỘI-DUNG-TIN';
    const SECRET_CUSTOMER = 'BÍ-MẬT-TÊN-KHÁCH';
    const SECRET_PROMPT = 'BÍ-MẬT-SYSTEM-PROMPT';
    const SECRET_KEY_PART = 'LEAK-ME';

    let workspaceB = '';
    let botBId = '';
    let ruleBId = '';
    let channelBId = '';
    let conversationBId = '';

    beforeAll(async () => {
      const tenant = await adminAgent
        .post('/api/v1/tenants')
        .send({ name: 'Shop B', username: 'ownerb', password: 'password12345', maxBots: 10, maxChannels: 10 })
        .expect(201);
      workspaceB = tenant.body.id;

      const [userB] = await db.select().from(users).where(eq(users.username, 'ownerb'));
      const [botB] = await db.select().from(bots).where(eq(bots.workspaceId, workspaceB));
      botBId = botB.id;
      await db.update(bots).set({ systemPrompt: SECRET_PROMPT }).where(eq(bots.id, botB.id));

      const [ruleB] = await db
        .insert(botRules)
        .values({ botId: botB.id, name: 'Rule B', keywords: ['riêng tư'], answer: 'b', createdBy: userB.id })
        .returning();
      ruleBId = ruleB.id;

      const [channelB] = await db
        .insert(channels)
        .values({
          workspaceId: workspaceB,
          provider: 'messenger',
          name: 'Kênh B',
          externalId: 'PAGE-B',
          botId: botB.id,
        })
        .returning();
      channelBId = channelB.id;

      const [customerB] = await db
        .insert(customers)
        .values({
          workspaceId: workspaceB,
          channelId: channelB.id,
          externalUserId: 'cust-b',
          displayName: SECRET_CUSTOMER,
        })
        .returning();
      const [conversationB] = await db
        .insert(conversations)
        .values({
          workspaceId: workspaceB,
          channelId: channelB.id,
          customerId: customerB.id,
          externalThreadId: 'thread-b',
          botId: botB.id,
        })
        .returning();
      conversationBId = conversationB.id;
      await db.insert(messages).values({
        workspaceId: workspaceB,
        channelId: channelB.id,
        conversationId: conversationB.id,
        direction: 'in',
        senderType: 'customer',
        content: SECRET_TENANT_CONTENT,
        status: 'received',
      });
    });

    // A new tenant route with an id parameter must get a sample here, so nobody forgets isolation.
    const tenantPathWithB = (path: string): string | undefined => {
      const samples: Record<string, string> = {
        '/api/v1/bots/:botId': `/api/v1/bots/${botBId}`,
        '/api/v1/bots/:botId/rules': `/api/v1/bots/${botBId}/rules`,
        '/api/v1/bots/:botId/rules/generate': `/api/v1/bots/${botBId}/rules/generate`,
        '/api/v1/bots/:botId/rules/bulk': `/api/v1/bots/${botBId}/rules/bulk`,
        '/api/v1/bots/:botId/rules/bulk-update': `/api/v1/bots/${botBId}/rules/bulk-update`,
        '/api/v1/bots/:botId/rules/bulk-delete': `/api/v1/bots/${botBId}/rules/bulk-delete`,
        '/api/v1/bots/:botId/rules/:id': `/api/v1/bots/${botBId}/rules/${ruleBId}`,
        '/api/v1/channels/:id': `/api/v1/channels/${channelBId}`,
        '/api/v1/channels/:id/test': `/api/v1/channels/${channelBId}/test`,
        '/api/v1/conversations/:id': `/api/v1/conversations/${conversationBId}`,
        '/api/v1/conversations/:id/messages': `/api/v1/conversations/${conversationBId}/messages`,
        '/api/v1/conversations/:id/takeover': `/api/v1/conversations/${conversationBId}/takeover`,
        '/api/v1/conversations/:id/release': `/api/v1/conversations/${conversationBId}/release`,
      };
      return samples[path];
    };

    const bodyFor = (path: string) => {
      if (path.endsWith('/messages')) return { content: 'xin chào' };
      if (path.endsWith('/rules')) return { name: 'Rule mới', keywords: ['a b'], answer: 'a' };
      if (path.endsWith('/rules/generate')) return { text: 'Giờ mở cửa: 8h-20h' };
      if (path.endsWith('/rules/bulk')) return { items: [{ name: 'Rule mới', keywords: ['a b'], answer: 'a' }] };
      // A valid body, so the 404 proves the bot check and not the validation pipe.
      if (path.endsWith('/rules/bulk-update')) return { ids: [ruleBId], enabled: false };
      if (path.endsWith('/rules/bulk-delete')) return { ids: [ruleBId] };
      return {};
    };

    it('returns 404 for another tenant on every id route', async () => {
      const server: any = app.getHttpAdapter().getInstance();
      const stack = server.router?.stack ?? server._router?.stack ?? [];
      const methods = ['get', 'post', 'patch', 'delete'];
      const routes: Array<{ method: string; path: string }> = [];
      for (const layer of stack) {
        if (!layer.route) continue;
        const path = String(layer.route.path);
        if (path.includes('*') || path.includes('{')) continue;
        if (!path.startsWith('/api/v1/')) continue;
        if (
          path.startsWith('/api/v1/tenants') ||
          path.startsWith('/api/v1/llm-providers') ||
          path.startsWith('/api/v1/audit-logs') ||
          path.startsWith('/api/v1/auth') ||
          path.startsWith('/api/v1/setup') ||
          path.startsWith('/api/v1/signup') ||
          path === '/api/v1/customers'
        ) {
          continue;
        }
        for (const method of Object.keys(layer.route.methods)) {
          if (methods.includes(method)) routes.push({ method, path });
        }
      }
      expect(routes.length).toBeGreaterThan(10);

      for (const route of routes) {
        const label = `${route.method.toUpperCase()} ${route.path}`;
        const url = route.path.includes(':') ? tenantPathWithB(route.path) : route.path;
        // Missing sample data fails loudly instead of silently skipping a new route.
        expect({ route: label, hasSample: Boolean(url) }).toEqual({ route: label, hasSample: true });
        if (!url) continue;

        const denied = await (adminAgent as any)[route.method](url);
        expect({ route: label, adminStatus: denied.status }).toEqual({ route: label, adminStatus: 403 });

        if (!route.path.includes(':')) continue;
        const res = await (agent as any)[route.method](url).send(bodyFor(route.path));
        expect({ route: label, ownerStatus: res.status }).toEqual({ route: label, ownerStatus: 404 });
      }

      // Tenant A's lists never contain anything from tenant B.
      const botsA = await agent.get('/api/v1/bots').expect(200);
      expect(botsA.body.items.map((b: { id: string }) => b.id)).not.toContain(botBId);
      const channelsA = await agent.get('/api/v1/channels').expect(200);
      expect(channelsA.body.items.map((c: { id: string }) => c.id)).not.toContain(channelBId);
      const conversationsA = await agent.get('/api/v1/conversations?limit=100').expect(200);
      expect(conversationsA.body.items.map((c: { id: string }) => c.id)).not.toContain(conversationBId);
      const rulesA = await agent.get(`/api/v1/bots/${botId}/rules`).expect(200);
      expect(rulesA.body.map((r: { id: string }) => r.id)).not.toContain(ruleBId);
    });

    it('never exposes tenant content or provider keys through admin APIs', async () => {
      const provider = await adminAgent
        .post('/api/v1/llm-providers')
        .send({
          name: 'leak-check',
          baseUrl: 'https://leak.example/v1',
          model: 'leak-model',
          apiKey: `sk-admin-${SECRET_KEY_PART}-9999`,
          priority: 1,
        })
        .expect(201);
      const adminResponses = [
        await adminAgent.get('/api/v1/tenants').expect(200),
        await adminAgent.get('/api/v1/llm-providers').expect(200),
        await adminAgent.patch(`/api/v1/llm-providers/${provider.body.id}`).send({ name: 'leak-check-2' }).expect(200),
      ];
      for (const res of adminResponses) {
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(SECRET_TENANT_CONTENT);
        expect(text).not.toContain(SECRET_CUSTOMER);
        expect(text).not.toContain(SECRET_PROMPT);
        expect(text).not.toContain(SECRET_KEY_PART);
      }
      await adminAgent.delete(`/api/v1/llm-providers/${provider.body.id}`).expect(200);
    });
  });
});
