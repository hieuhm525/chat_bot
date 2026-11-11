# bv-agent-msg — Kế hoạch chi tiết + biên bản phản biện

> Phiên bản: v1 · 09/11/2026 · Trạng thái: **đã triển khai; tài liệu lịch sử, code là nguồn đúng**
> Thay thế `PLAN.md`, `PROD_PLAN.md`, `LOCAL_PLAN.md` (những file đó mô tả bot FastAPI 1 Page).
> Tài liệu này là đầu vào để triển khai từng phase, không phải hợp đồng bất biến.

---

## 0. TL;DR — 10 quyết định đã chốt

| # | Quyết định |
|---|---|
| 1 | Modular monolith NestJS, **1 process** (API + worker trong cùng app), 1 repo pnpm workspace |
| 2 | **Không Redis/BullMQ ở MVP.** Outbox Postgres + 1 worker `FOR UPDATE SKIP LOCKED` |
| 3 | `workspace_id` có từ ngày 1, nhưng **không RBAC, không màn quản lý member** |
| 4 | Bot engine = **1 hàm `resolve()` 3 bước**: rule → LLM → fallback/handoff. Không Strategy interface |
| 5 | Kênh đầu tiên: **Messenger**. Thứ hai: **Zalo OA**. WhatsApp: hoãn đến khi có khách hỏi |
| 6 | Admin **5 màn hình**, session cookie server-side + argon2id, không JWT, không passport |
| 7 | `messages` là nguồn sự thật; outbox ghi **trước** khi gọi API vendor |
| 8 | Idempotency bằng unique index trên `(channel_id, provider_message_id)` và `(channel_id, provider_event_id)` |
| 9 | Human takeover = `conversations.mode`, kiểm tra **trong cùng transaction** trước khi gửi |
| 10 | Không làm: RAG/vector DB, workflow builder, billing, microservices, media pipeline, audit đầy đủ, analytics module |

Ước lượng MVP (Messenger + admin + bot rule): **10–13 ngày công**, cộng thời gian chờ Meta duyệt app.

---

## 1. Điểm xuất phát: audit code hiện có

Repo hiện tại là bot Messenger 1 Page: `app.py` (849 dòng, FastAPI + SQLite), `faq.md` (115 dòng, 5 mục), `test_app.py` (374 dòng, 5 test), chạy được local.

**Giữ lại (bê sang, không viết lại từ đầu):**

| Thứ | Vì sao |
|---|---|
| Shape webhook Messenger + verify `X-Hub-Signature-256` trên **raw body** | Đã đúng, đã có test; đây là bug hay gặp nhất khi port sang framework khác |
| Dedupe theo `mid` | Đã xử lý đúng ca webhook retry |
| Ý tưởng `faq_answer()`: so khớp từ trên tiêu đề, ngưỡng ≥2 từ và ≥60%, hoà điểm thì nhường LLM | Chống trả lời bừa; giữ ngưỡng, đổi cách cài |
| Client LLM kiểu OpenAI-compatible (`_chat_completion`) | Đổi provider không cần sửa code |
| Fallback → tạm dừng bot cho hội thoại đó | Chính là mầm của human takeover |
| Sweeper quét tin `received/answered` treo | Chính là mầm của outbox retry |
| `faq.md` | Chuyển thành seed `bot_rules` (5 rule) khi migrate |

**Bỏ (không bê kiến trúc):** SQLite + `PRAGMA user_version` migration tay, file đơn 849 dòng, `threading.RLock` theo psid (thay bằng advisory lock của Postgres), cache FAQ toàn cục trong RAM, mock UI, admin đăng nhập bằng cookie mật khẩu so sánh chuỗi.

**Bài học cần giữ nguyên hành vi:** bot hiện tại **đã** làm rule-first rồi LLM fallback. Vì vậy phương án "MVP chỉ keyword, chưa dùng AI" trong bản đề xuất ban đầu là **lùi so với hiện trạng**. Kế hoạch này giữ LLM fallback ngay từ phase 1 (nó chỉ là 1 lời gọi HTTP, không phải hạng mục kiến trúc).

---

## 2. Phạm vi MVP và tiêu chí hoàn thành

**Kịch bản nghiệm thu (đúng 11 bước, không hơn):**

1. Admin đăng nhập được bằng tên đăng nhập + mật khẩu.
2. Admin tạo/sửa/xoá rule: tên, danh sách keyword, câu trả lời, bật/tắt, độ ưu tiên.
3. Admin dán Page ID + Page Access Token, bấm "Kiểm tra" → hiện trạng thái kết nối.
4. Khách nhắn "báo giá bê tông" vào Page thật.
5. Webhook trả 200 trong < 2s, tin được lưu (`webhook_events` + `messages`).
6. Conversation được tìm hoặc tạo, gắn đúng customer theo channel.
7. Rule khớp → trả lời đúng nội dung; không khớp → LLM với toàn bộ rule làm ngữ cảnh; LLM lỗi → câu fallback.
8. Tin bot được lưu, có `provider_message_id`, trạng thái `sent`/`failed`.
9. Admin thấy hội thoại trong danh sách, mở ra thấy đủ 2 chiều.
10. Admin bấm "Tiếp quản" → bot im lặng; admin gửi tin tay được; "Trả lại bot" → bot trả lời lại.
11. Webhook gửi lại cùng `mid` 3 lần, hoặc hai tin đến cùng lúc → không có tin trả lời trùng.

**Ngoài phạm vi MVP:** ảnh/file/voice, comment Facebook, Zalo/WhatsApp, nhiều Page cùng lúc trên UI, template message, broadcast, phân quyền nhiều người, báo cáo nâng cao, đa ngôn ngữ.

---

## 3. Kiến trúc chốt

```
                    ┌──────────────────────────────┐
  Facebook ────────►│  /webhooks/messenger         │  verify sig (app secret)
  Zalo     ────────►│  /webhooks/zalo              │  verify mac (per-OA secret)
  WhatsApp ────────►│  /webhooks/whatsapp          │  verify sig (app secret)
                    └──────────────┬───────────────┘
                                   │ 1. ghi webhook_events + outbox(process)  2. trả 200
                                   ▼
        ┌──────────────────────────────────────────────────────┐
        │ NestJS (1 process)                                   │
        │                                                      │
        │  channels/   adapters + registry + capabilities      │
        │  messaging/  customers, conversations, messages,     │
        │              outbox, worker loop, admin controllers   │
        │  bot/        resolve(): rule → LLM → fallback        │
        │  auth/       session cookie, guard                   │
        └──────────────┬───────────────────────────────────────┘
                       │ Drizzle
                       ▼
              PostgreSQL (10 bảng)
                       ▲
        ┌──────────────┴───────────────┐
        │  React Router (SPA, ssr:false)│  serve tại /admin
        └───────────────────────────────┘
```

**Ba ranh giới không được vi phạm:**

1. `bot/` không import bất cứ thứ gì từ `adapters/`. Nó nhận text + ngữ cảnh, trả `{ text, source }`.
2. `adapters/` không biết rule, không biết conversation, không tự gửi. Nó chỉ: verify, parse → `NormalizedEvent`, `send(channel, to, message)`, `capabilities()`.
3. Mọi thứ đi qua `messages` + `outbox`. Không có đường tắt "gọi API vendor rồi mới lưu DB".

---

## 4. Biên bản phản biện

Bốn vai độc lập, phản biện trực tiếp bản đề xuất ban đầu (gọi tắt **P**):

- **P — Bản đề xuất gốc** (kế hoạch 13 mục: multi-tenant đầy đủ, BullMQ, Strategy Pattern, 15 bảng, 7 phase).
- **A — Kỹ sư tối giản:** dị ứng over-engineering, ưu tiên số dòng code và số thứ có thể chết lúc 2h sáng.
- **B — Kỹ sư tích hợp nền tảng:** chỉ tin tài liệu vendor, đã kiểm chứng chính sách 2026.
- **C — Reviewer bảo mật/dữ liệu:** giả định sẽ có sự cố, đòi chứng minh bằng test.

### 4.1. Bảng tranh luận và phán quyết

| # | Điểm tranh luận | P | A | B / C | **Chốt** |
|---|---|---|---|---|---|
| 1 | Queue | BullMQ + Redis ngay | Cắt Redis, outbox Postgres | C: outbox phải ghi trước khi gọi vendor | **Outbox Postgres.** Redis chỉ khi >50 msg/s bền vững hoặc >2 worker process |
| 2 | Multi-tenant | workspace + member + RBAC + RLS | Chỉ cần cột `workspace_id` | C: cần chokepoint + RLS 4 bảng + test rò rỉ | **Cột `workspace_id` + 1 lớp truy cập duy nhất + test chéo tenant trong CI. RLS bật trước khi onboard workspace thứ 2** |
| 3 | Bot engine | 3 class Strategy | 1 hàm `resolve()` | C: phải test được từng nhánh | **1 hàm 3 bước, có `source` trên mỗi tin. Interface khi >4 nguồn trả lời** |
| 4 | Kênh đầu tiên | Messenger | (không ý kiến) | B: WhatsApp dễ nhất về kỹ thuật | **Messenger** — xem 4.3 |
| 5 | Số bảng | 15 | 8 | C: thêm constraint/index, bớt bảng | **10 bảng** |
| 6 | `audit_logs` | Có ngay | Cắt | C: nếu có thì không chứa secret | **Hoãn. Dùng `created_by`/`updated_by`. Bật khi có ≥3 user nội bộ** |
| 7 | Analytics | Module + trang riêng | 1 câu SQL | — | **1 endpoint + 3 con số trên dashboard** |
| 8 | Auth admin | Session hoặc JWT | 1 guard | C: session server-side, argon2id, CSRF | **Session cookie + argon2id + kiểm Origin. Không JWT, không passport** |
| 9 | Mã hoá credential | AES-256-GCM, key trong env | Đồng ý | C: cần AAD + key version + fail-fast | **Định dạng `v1:<keyId>:<b64(nonce|ct|tag)>`, AAD = `channel_id`, fail-fast lúc boot** |
| 10 | Cửa sổ gửi tin | 24h + tag `HUMAN_AGENT` | — | B: 3 message tag đã bị khai tử | **Chỉ trả lời trong cửa sổ; ngoài cửa sổ → `blocked_by_policy`, không gửi. Không dùng tag** |
| 11 | Phạm vi admin | 8 nhóm chức năng | 5 màn hình | — | **5 màn hình** |
| 12 | Media | Có trong `NormalizedEvent` | Cắt khỏi MVP | B: URL media có TTL, phải tải ngay | **Text-only MVP. Tin media: lưu metadata, trả lời "em chưa xem được ảnh"** |

### 4.2. Bốn tranh luận đáng ghi lại

**Redis hay không Redis.** P lập luận BullMQ là chuẩn NestJS, có module chính thức. A phản biện bằng số: 500 tin/ngày là 0,006 msg/s; Postgres xử lý 10.000 msg/s; Redis không giải quyết vấn đề nào đang có, nhưng thêm một thành phần có thể chết và làm mất trạng thái. Điểm quyết định không phải hiệu năng mà là **tính nguyên tử**: cần ghi `messages` + `outbox` trong **một** transaction, rồi mới gửi. Làm việc đó với Redis nghĩa là hai nguồn sự thật và phải tự hoà giải khi lệch. **Chốt: outbox.** BullMQ vẫn là lựa chọn hợp lệ — ghi lại trong ADR để không ai phải tranh luận lại.

**Cô lập tenant.** P dựa hoàn toàn vào `WHERE workspace_id` ở service. C chỉ ra các đường vòng không đi qua service: raw SQL cho báo cáo, export, job nền, tra cứu channel từ webhook, join. A phản đối RLS vì "chỉ có 1 tenant thì RLS bảo vệ cái gì". C đúng về nguyên tắc nhưng A đúng về thứ tự: với 1 workspace, RLS không thêm bảo vệ nào, chỉ thêm 40 dòng và một lớp lỗi "quên set `app.workspace_id`". **Chốt: bắt buộc một lớp truy cập duy nhất nhận `workspaceId` không nullable + bộ test chéo tenant chạy trong CI; bật RLS trước khi ký khách thứ hai.** Đây là quyết định có điều kiện, phải ghi vào checklist go-live.

**Kênh nào trước.** B lập luận kỹ thuật rất đúng: WhatsApp Cloud dễ nhất (test number chạy được ngay, ít bất ngờ policy), Messenger trung bình nhưng policy đang biến động, Zalo khó nhất (chữ ký không phải HMAC, refresh token dùng một lần, tài liệu phân mảnh, ít sandbox). Nhưng tiêu chí chọn kênh đầu tiên là **rủi ro đã tiêu thụ hay chưa**, không phải độ khó API: Messenger đã có Page thật, app Meta, code chạy được, khách thật. WhatsApp thì phải tạo Business Portfolio, verify doanh nghiệp, trả phí theo tin, và không ai ở đây đang dùng. **Chốt: Messenger → Zalo → WhatsApp.** Bảo lưu ý kiến của B bằng một luật: nếu đến phase Zalo mà app review của Meta chưa xong, làm WhatsApp để giữ tiến độ.

**Strategy Pattern.** P muốn 3 class (`Keyword`, `AI`, `Hybrid`). A chỉ ra "hybrid" không phải chiến lược thứ ba, nó là **thứ tự fallback** của hai cái kia — mô hình hoá nó thành class là biến một `if/else` 15 dòng thành 3 file + 1 registry + 1 token DI. **Chốt: một hàm `resolve()` đọc theo thứ tự, trả `{ text, source }`, lưu `source` vào metadata tin nhắn.** Nhờ vậy vẫn đo được tỉ lệ rule/LLM/fallback — thứ thực sự cần cho báo cáo — mà không cần abstraction.

### 4.3. Những chỗ bản đề xuất gốc sai hoặc thiếu (đã kiểm chứng)

| Nội dung trong P | Thực tế | Nguồn |
|---|---|---|
| Zalo webhook ký bằng HMAC | **Sai.** `X-ZEvent-Signature` = `sha256(appId + data + timestamp + OAsecretKey)` — SHA-256 trên chuỗi nối, `data` là raw JSON body, `timestamp` lấy trong payload | [Zalo webhook docs](https://developers.zalo.me/docs/api/official-account-api/webhook/su-kien-nguoi-dung-gui-tin-nhan-post-3720) |
| Message tag `HUMAN_AGENT` dùng thoải mái ngoài 24h | `CONFIRMED_EVENT_UPDATE`, `POST_PURCHASE_UPDATE`, `ACCOUNT_UPDATE` **bị API từ chối (error 100) từ 27/04/2026**; phải dùng Utility Templates. `HUMAN_AGENT` còn nhưng chỉ cho người thật, tối đa 7 ngày, cần quyền riêng | [Messenger changelog](https://developers.facebook.com/documentation/business-messaging/messenger-platform/changelog) |
| WhatsApp System User token ~60 ngày | System User token là **long-lived**, có thể tạo **không hết hạn**. 60 ngày chỉ là một tuỳ chọn | [Access Tokens Guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/) |
| Callback URL theo từng channel | Sai với Messenger/WhatsApp: webhook đăng ký **theo app**, một URL cho mọi Page/số. Phải phân giải channel từ `entry.id` / `phone_number_id` | thiết kế |
| Chưa có `capabilities()` | Không có nó thì UI không biết kênh nào gửi được gì (nút, media, giới hạn ký tự, template) | B |
| Chưa có kiểm tra cửa sổ gửi trước khi gửi | Phải là precondition ở tầng gửi, không phải validate ở UI | B |
| Chưa xử lý **echo message** | Không lọc `is_echo` = bot tự trả lời chính mình, vòng lặp vô hạn | B |
| Refresh token Zalo dùng một lần, không có lock | Hai worker refresh song song = mất refresh token vĩnh viễn, phải OAuth tay lại | B |
| Chưa có test cô lập tenant | Đây là loại lỗi không thể phát hiện bằng review | C |

### 4.4. Cả bốn đều đồng ý (không tranh luận nữa)

Modular monolith; adapter tách khỏi bot engine; idempotency bằng unique index; outbox ghi trước khi gọi vendor; lưu raw webhook 7–14 ngày để đối soát; credential mã hoá at-rest và không bao giờ ghi log; mỗi conversation lưu đủ hai chiều; không RAG/vector ở giai đoạn này.

---

## 5. Quyết định kiến trúc (ADR ngắn)

| ID | Quyết định | Đổi khi |
|---|---|---|
| D1 | Modular monolith, 1 process, worker chạy bằng `setInterval` trong app | Cần >2 worker hoặc deploy API/worker độc lập |
| D2 | Outbox Postgres, không Redis | >50 msg/s hoặc cần delayed job phân tán |
| D3 | `workspace_id` có sẵn, RBAC hoãn | Có workspace thứ 2 hoặc ≥3 user nội bộ |
| D4 | Rule-first → LLM → fallback, 1 hàm | >4 nguồn trả lời hoặc admin chọn chiến lược qua UI |
| D5 | Session cookie server-side (bảng session trong Postgres) | Có API client bên thứ ba → thêm API key riêng, không đổi auth admin |
| D6 | 1 validation library: `class-validator` cho cả DTO và env | Không cần đổi |
| D7 | Drizzle + `drizzle-kit generate`; **không bao giờ** `push` lên production | Không |
| D8 | Messenger webhook verify bằng App Secret cấp app; Zalo verify bằng OA Secret Key cấp channel | Có nhiều Meta app |
| D9 | Mọi tin gửi đi qua `outbox`; không gọi vendor trong request webhook | Không |
| D10 | Text-only ở MVP | Khi có yêu cầu gửi ảnh/file thật |
| D11 | Admin SPA build vào `public/admin`, Nest serve tĩnh, API `/api/v1`, webhook `/webhooks` | Tách domain/CDN |
| D12 | Adapter chạy thật nhưng có thêm `FakeAdapter` cho test/e2e | Không |

---

## 6. Mô hình dữ liệu (10 bảng)

Nguyên tắc: UUIDv7 cho bảng lộ ID ra ngoài; `timestamptz` toàn bộ; enum bằng `text + check` (Postgres enum khó alter); `jsonb` chỉ để chứa dữ liệu vendor, không dùng làm nguồn truy vấn chính.

```sql
workspaces(id uuid pk, name text, timezone text default 'Asia/Ho_Chi_Minh', created_at)

users(id uuid pk, workspace_id uuid not null, username text unique,
      password_hash text, role text check in ('owner','agent'), created_at)

channels(id uuid pk, workspace_id uuid not null,
         provider text check in ('messenger','zalo','whatsapp'),
         name text, external_id text not null,            -- page id / oa id / phone_number_id
         bot_id uuid null,
         status text check in ('active','error','disabled') default 'active',
         credentials_enc text, key_id text, credential_expires_at timestamptz,
         config jsonb default '{}',                        -- token phụ, webhook info
         created_at, updated_at,
         unique(workspace_id, provider, external_id))

customers(id uuid pk, workspace_id uuid not null, channel_id uuid not null,
          external_user_id text not null, display_name text, profile jsonb,
          first_seen_at, last_seen_at,
          unique(channel_id, external_user_id))

conversations(id uuid pk, workspace_id uuid not null, channel_id uuid not null,
              customer_id uuid not null, external_thread_id text,
              mode text check in ('bot','human','off') default 'bot',
              assigned_user_id uuid null,
              fallback_count int not null default 0,
              last_message_at timestamptz, last_inbound_at timestamptz,
              created_at, updated_at,
              unique(channel_id, external_thread_id) )

messages(id uuid pk, workspace_id uuid not null, channel_id uuid not null,
         conversation_id uuid not null,
         direction text check in ('in','out'),
         sender_type text check in ('customer','bot','agent','system'),
         content_type text check in ('text','image','file','unsupported') default 'text',
         content text not null default '',
         provider_message_id text, status text check in
           ('received','queued','sent','delivered','read','failed','blocked_by_policy'),
         error_code text, metadata jsonb default '{}',
         created_at, updated_at,
         unique(channel_id, provider_message_id) )          -- partial: WHERE provider_message_id IS NOT NULL

webhook_events(id uuid pk, channel_id uuid null, provider text not null,
               provider_event_id text not null, payload jsonb not null,
               received_at, processed_at, error text,
               unique(channel_id, provider_event_id))

outbox(id bigserial pk, workspace_id uuid null, kind text check in ('process_event','send_message'),
       payload jsonb not null, status text check in ('pending','running','done','failed') default 'pending',
       attempts int default 0, next_attempt_at timestamptz default now(), locked_at timestamptz,
       last_error text, created_at)

bots(id uuid pk, workspace_id uuid not null, name text, enabled bool default true,
     greeting text, fallback_message text, handoff_message text,
     llm_enabled bool default true, llm_model text,
     pause_after_fallbacks int default 3, created_at, updated_at)

bot_rules(id uuid pk, bot_id uuid not null, name text not null,
          keywords text[] not null, match_mode text check in ('contains','exact') default 'contains',
          priority int default 0, answer text not null, enabled bool default true,
          created_by uuid null, created_at, updated_at)
```

**Index bắt buộc:**

```sql
conversations(workspace_id, last_message_at desc) where deleted_at is null   -- danh sách hội thoại
messages(conversation_id, created_at desc)                                   -- mở thread
outbox(status, next_attempt_at) where status in ('pending','running')        -- worker poll
webhook_events(received_at)                                                  -- job dọn dữ liệu cũ
bot_rules using gin(keywords)                                                -- tra keyword nếu cần
```

**Đã cắt so với bản đề xuất gốc và lý do:**

| Bảng bị cắt | Thay bằng |
|---|---|
| `workspace_members` | `users.workspace_id` + `users.role` (1 workspace) |
| `channel_credentials` | 3 cột trên `channels`; tách bảng không thêm bảo vệ nào |
| `bot_rule_keywords` | `keywords text[]` + GIN index, bớt 1 join |
| `message_delivery_attempts` | `attempts`/`last_error` trên `outbox` + `error_code` trên `messages` |
| `audit_logs` | `created_by`/`updated_by` |
| bảng analytics | `date_trunc` query trực tiếp |

**Ràng buộc dễ quên:**

- `messages.channel_id` phải khớp `conversations.channel_id` — kiểm bằng composite FK hoặc trigger; đây là chỗ dễ sinh dữ liệu rác khi copy code.
- `unique(channel_id, provider_message_id)` phải partial (`WHERE provider_message_id IS NOT NULL`), nếu không mọi tin nội bộ đều đụng unique.
- Không lưu URL media của vendor (có TTL). Nếu sau này nhận media: tải về ngay trong worker, lưu object key.
- Không đặt PII vào `jsonb metadata` (không xoá/redact được).

---

## 7. Luồng xử lý

### 7.1. Inbound (webhook → có tin trả lời)

```
POST /webhooks/:provider
 1. verify chữ ký trên raw body            (sai → 403, không log body)
 2. parse sơ bộ để tìm channel             (Messenger: entry[].id, WA: metadata.phone_number_id,
                                            Zalo: recipient.id; Zalo cần bước này TRƯỚC verify
                                            vì secret là của từng OA)
 3. insert webhook_events (unique provider_event_id) + outbox(process_event)   [1 transaction]
 4. trả 200                                  ← ngân sách: < 2 giây, không gọi vendor, không gọi LLM

worker (mỗi 1s, batch 20)
 5. claim job: UPDATE ... SET status='running' WHERE id IN (
      SELECT id FROM outbox WHERE status='pending' AND next_attempt_at<=now()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 20)
 6. parse payload → NormalizedEvent (text, vendor message id, timestamp, is_echo)
 7. lấy advisory lock theo conversation: pg_advisory_xact_lock(hashtext(conv_id))
 8. upsert customer (channel_id + external_user_id) → upsert conversation
 9. insert message(in) — unique(channel_id, provider_message_id); trùng → job done, thoát
10. nếu conversation.mode != 'bot' → done
11. resolve(rule → LLM → fallback)  →  insert message(out, sender_type='bot', status='queued')
                                    +  insert outbox(send_message)
12. cập nhật last_message_at, fallback_count, có thể đổi mode='human'
13. done
```

**Vì sao bước 11 nằm trong worker, không nằm trong request:** LLM có thể mất 10–30s. Messenger timeout webhook sau vài giây và sẽ retry — retry đó lại tạo thêm một lần gọi LLM. Trả 200 trước là bắt buộc.

### 7.2. `resolve()` — 3 bước, không Strategy

```
resolve(bot, conversation, text) -> { text, source }
  bước 1: rule enabled, khớp keyword theo priority desc, độ dài keyword desc
          khớp: trả answer, source='rule'
  bước 2: nếu bot.llm_enabled: prompt = system + toàn bộ rule enabled + 10 tin gần nhất
          trả lời, source='llm'
  bước 3: trả bot.fallback_message, source='fallback'; fallback_count += 1
          nếu fallback_count >= bot.pause_after_fallbacks → conversation.mode='human'
```

Chuẩn hoá tiếng Việt để so khớp: lowercase → NFC → bỏ dấu câu → gộp khoảng trắng → **bỏ dấu** (accent-insensitive), có kiểm tra ranh giới từ. Lý do bỏ dấu: khách Việt gõ không dấu rất thường. Bù rủi ro bằng: keyword phải ≥3 ký tự, `contains` chỉ khớp theo ranh giới từ, hoà điểm thì nhường LLM. Mỗi keyword là một cách hỏi thay thế (khớp 1 keyword ≥2 từ là đủ, keyword dài hơn được ưu tiên); ngưỡng ≥60% số keyword của code cũ đã bỏ vì nó buộc rule chỉ có 1 keyword, không phủ được từ đồng nghĩa/cách viết khác.

### 7.3. Outbound + trạng thái

```
worker (cùng loop, kind='send_message')
 1. đọc message(status='queued') + channel
 2. kiểm tra lại mode trong transaction  ← chống bot chen ngang lúc agent đang chat
 3. canSend(channel, customer, category): cửa sổ 24h (Messenger/WA) / 48h (Zalo)
    ngoài cửa sổ → status='blocked_by_policy', done, không retry
 4. adapter.send(...) → { providerMessageId }
 5. status='sent', lưu provider_message_id
 6. lỗi: 429/5xx/timeout → retry backoff (5s, 30s, 2m, 10m, 1h; tối đa 5 lần)
         4xx/policy → status='failed', không retry
         auth (token chết) → status='failed' + đánh dấu channel status='error'
```

State machine một chiều: `queued → sent → delivered → read`; `failed` và `blocked_by_policy` là trạng thái cuối. Callback `read` đến trước `delivered` không được lùi trạng thái (so sánh bằng bậc, không set mù).

### 7.4. Human takeover

`conversations.mode`: `bot` | `human` | `off`.

- Agent bấm "Tiếp quản" → `mode='human'`, `assigned_user_id=me`.
- Worker bước 10 bỏ qua mọi tin inbound mới (vẫn lưu để agent đọc).
- Agent gửi tin → cùng đường outbound, `sender_type='agent'`.
- "Trả lại bot" → `mode='bot'`, `fallback_count=0`.
- Kiểm tra `mode` phải nằm **trong** transaction của bước gửi, không phải đọc trước đó 200ms.

### 7.5. Token

- Messenger: Page token long-lived, không có refresh. `credential_expires_at` null. Kiểm tra sức khoẻ bằng `GET /me?access_token=...` (hoặc gọi `/{page-id}?fields=name`) mỗi ngày.
- WhatsApp: System User token long-lived/không hết hạn → cùng cơ chế.
- Zalo: access token 25h, refresh 3 tháng, **refresh token chỉ dùng một lần**. Bắt buộc `pg_advisory_xact_lock('zalo_refresh:'||channel_id)` trước khi refresh; refresh lỗi → `channels.status='error'` + log mức error (không log token). Job refresh chạy khi còn < 2h.

---

## 8. Kết nối từng nền tảng

### 8.1. Phân cấp thông tin (đây là chỗ hay thiết kế sai)

| Cấp | Ý nghĩa | Ví dụ |
|---|---|---|
| **Cấp app** (env, 1 lần) | Định danh ứng dụng, dùng cho mọi channel | Meta App ID/Secret, Zalo App ID/Secret Key, webhook verify token |
| **Cấp channel** (DB, mỗi Page/OA/số) | Định danh điểm kết nối + credential | Page ID + Page token, OA ID + access/refresh token, WABA ID + Phone Number ID |
| **Cấp hạ tầng** | Domain HTTPS công khai | `https://<domain>/webhooks/messenger` |

Admin **không được nhập tay** access token Zalo — phải qua OAuth, nếu không `expires_at` sẽ sai và token chết âm thầm.

### 8.2. Facebook Messenger

| Cần gì | Ghi chú |
|---|---|
| Meta App ID / App Secret | App Secret dùng verify `X-Hub-Signature-256` (HMAC-SHA256 trên raw body) |
| Page ID + Page Access Token | Token long-lived, lấy qua flow đăng nhập; dán tay được ở MVP |
| Webhook Verify Token | Chuỗi tự đặt, dùng cho `GET /webhooks/messenger` |
| Quyền | `pages_messaging`, `pages_manage_metadata`, `pages_show_list`, `pages_read_engagement` |
| Subscribe field | `messages`, `messaging_postbacks` |
| Cửa sổ | 24h kể từ tin cuối của khách (một số entry point quảng cáo dài hơn) |
| Ngoài cửa sổ | **Không gửi.** 3 message tag cũ đã bị API từ chối từ 27/04/2026; `HUMAN_AGENT` chỉ dùng khi người thật trả lời, tối đa 7 ngày, cần quyền riêng |
| Duyệt | App Review + Advanced Access cho quyền messaging, thực tế 1–4 tuần; business verification 2–5 ngày |

### 8.3. Zalo OA

| Cần gì | Ghi chú |
|---|---|
| Zalo App ID / Secret Key | Cấp app |
| OA ID | Cấp channel, lấy sau OAuth |
| Access token / Refresh token | Chỉ lấy qua OAuth + PKCE; AT ~25h, RT ~3 tháng, **RT dùng 1 lần** |
| Redirect URI, webhook URL | Cấp app |
| Verify webhook | `mac = sha256(appId + rawBody + timestamp + OAsecretKey)`, header `X-ZEvent-Signature`. **Không phải HMAC** |
| Cửa sổ | Zalo có chính sách cửa sổ tư vấn riêng (báo cáo là 48h, có tính phí ngoài cửa sổ) — **cần xác nhận lại trước khi code** |
| Khác biệt | OA OpenAPI ≠ ZNS/ZBS template messaging. Đừng giả định mọi loại tin có cùng điều kiện gửi |
| Rate limit | ~4.000 request/phút/OA (lỗi `-32`) |

### 8.4. WhatsApp Cloud

| Cần gì | Ghi chú |
|---|---|
| Meta App ID / Secret, Verify Token | Cấp app |
| Business Portfolio ID, WABA ID, Phone Number ID | Cấp channel |
| System User Access Token | **Long-lived, có thể tạo không hết hạn**; gắn quyền vào cả WABA và app |
| Quyền | `whatsapp_business_management`, `whatsapp_business_messaging` |
| Cửa sổ | 24h; ngoài cửa sổ phải dùng template đã duyệt + opt-in |
| Chi phí | Tính tiền theo tin (thay đổi từ 07/2025) — cần xác nhận bảng giá hiện hành trước khi báo giá khách |
| Test | Số test chỉ nhắn được tới 5 số đã verify; không phải sandbox thật |

### 8.5. So sánh và thứ tự

| Kênh | Độ khó | Ngày công ước tính | Chờ duyệt | Thứ tự |
|---|---|---|---|---|
| Messenger | Trung bình | 4–6 | 1–4 tuần (app review) | **1** |
| Zalo OA | Cao (token 1 lần, chữ ký lạ, doc phân mảnh) | 6–8 | OA verification + app duyệt | **2** |
| WhatsApp Cloud | Trung bình | 6–8 | Business verification 2–5 ngày | **3** |

---

## 9. Hợp đồng adapter (MVP)

```ts
type Provider = 'messenger' | 'zalo' | 'whatsapp';

interface ChannelAdapter {
  readonly provider: Provider;
  capabilities(): { text: true; media: false; quickReply: false; template: boolean; maxTextLength: number };
  verify(req: { rawBody: Buffer; headers: Record<string, string>; channel?: Channel }): boolean;
  parse(raw: unknown, channel: Channel): NormalizedEvent[];   // text + delivery/read + ignore echo
  send(channel: Channel, to: string, msg: OutgoingText): Promise<{ providerMessageId: string }>;
  canSend(channel: Channel, conv: Conversation, at: Date): { ok: true } | { ok: false; reason: string };
  refresh?(channel: Channel): Promise<void>;                   // chỉ Zalo
  healthCheck(channel: Channel): Promise<{ ok: boolean; detail?: string }>;
}
```

`NormalizedEvent` tối thiểu: `kind: 'message' | 'status' | 'ignored'`, `providerEventId`, `externalUserId`, `externalThreadId`, `providerMessageId?`, `text?`, `occurredAt`, `raw`.

**Không đưa vào interface ở MVP:** upload media, reaction, postback/menu, template, typing indicator, mark-seen. Khi thêm kênh thứ hai mà phải sửa `messaging/` → nghĩa là ranh giới đã sai, dừng lại sửa trước khi thêm kênh thứ ba.

---

## 10. API và màn hình admin

| Method | Path | Việc |
|---|---|---|
| POST | `/api/v1/auth/login` | username + password → session cookie |
| POST | `/api/v1/auth/logout` | huỷ session |
| GET | `/api/v1/auth/me` | user hiện tại |
| GET | `/api/v1/conversations` | cursor pagination, lọc `mode`, tìm theo tên |
| GET | `/api/v1/conversations/:id` | chi tiết + 50 tin gần nhất |
| GET | `/api/v1/conversations/:id/messages?before=` | tải thêm tin cũ |
| POST | `/api/v1/conversations/:id/takeover` | `mode='human'` |
| POST | `/api/v1/conversations/:id/release` | `mode='bot'` |
| POST | `/api/v1/conversations/:id/messages` | agent gửi tin tay |
| GET/POST/PATCH/DELETE | `/api/v1/channels` | CRUD kênh |
| POST | `/api/v1/channels/:id/test` | gọi `healthCheck` |
| GET/PATCH | `/api/v1/bot` | cấu hình bot |
| GET/POST/PATCH/DELETE | `/api/v1/bot/rules` | CRUD rule |
| GET | `/api/v1/stats/summary` | 3–4 con số cho dashboard |
| GET | `/health` | DB + outbox lag |

Tất cả dưới `AuthGuard` trừ auth/login và `/webhooks/*`, `/health`.

**5 màn hình:** Login · Dashboard (4 số) · Conversations (list + thread + takeover + gửi tay) · Channels (danh sách, form token, nút test, trạng thái) · Bot (cấu hình + bảng rule).

Không làm: trang analytics riêng, trang audit, quản lý member, hồ sơ khách riêng, bot builder kéo thả, dark mode, i18n.

---

## 11. Cấu trúc thư mục

```
bv-agent-msg/
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── docker-compose.yml           # chỉ postgres (MVP)
├── drizzle.config.ts
├── .env.example
├── src/
│   ├── main.ts                  # rawBody: true, global prefix api/v1 (exclude webhooks)
│   ├── app.module.ts
│   ├── config/env.ts            # validateEnv() bằng class-validator, fail-fast
│   ├── db/
│   │   ├── db.module.ts / db.provider.ts
│   │   ├── schema.ts
│   │   └── migrations/
│   ├── common/                  # guard, exception filter, crypto, normalize-text, uuidv7
│   └── modules/
│       ├── auth/                # login, session, guard
│       ├── channels/            # registry, controller, adapters/{messenger,zalo,whatsapp}
│       ├── messaging/           # webhook controller, worker, outbox, conversations controllers
│       └── bot/                 # resolve(), rules controller
├── admin/                       # React Router v7, framework mode + ssr:false
│   └── app/routes/{login,dashboard,conversations,channels,bot}
├── test/                        # e2e + fixtures webhook thật
└── docs/
```

**Chuẩn NestJS áp dụng:** `@nestjs/config` + validate env fail-fast; `ValidationPipe({whitelist:true, transform:true})`; `@nestjs/swagger` (CLI plugin); `@nestjs/terminus` cho health; `@nestjs/throttler` cho login; exception filter chuẩn hoá lỗi; `nestjs-pino` với `redact` cho token/content; `@nestjs/serve-static` cho admin.

**Không dùng:** TypeORM (đã chốt Drizzle), passport (một chiến lược local không cần), Redis, BullMQ, Zod (một lib validation là đủ).

---

## 12. Kế hoạch triển khai

### P0 — Chốt và dựng khung (0,5 ngày)

- Tạo repo `bv-agent-msg`, pnpm workspace, `docker-compose.yml` postgres.
- `.env.example` đầy đủ; `validateEnv()` fail-fast.
- Nest khởi động, `/health` trả 200, Swagger mở.
- **Demo:** `pnpm dev` chạy, `/health` xanh, Swagger có trang.

### P1 — Dữ liệu, auth, admin shell (3 ngày)

- Drizzle schema 10 bảng + migration đầu tiên + seed workspace/user/bot 5 rule từ `faq.md`.
- `drizzle-kit generate` + `migrate`; test migration chạy lại nhiều lần không lỗi.
- Auth: login/logout/me, argon2id, session Postgres, Origin check, rate limit.
- Admin: Vite + React Router (`ssr:false`), build vào `public/admin`, route login + layout + 3 trang rỗng.
- **Demo:** đăng nhập bằng trình duyệt, refresh vẫn còn phiên, gọi API sai session nhận 401.

### P2 — Kênh Messenger end-to-end (3 ngày)

- `ChannelAdapter` + `MessengerAdapter` (verify, parse text, echo ignore, send, canSend 24h).
- `POST/GET /webhooks/messenger`, lưu `webhook_events`, trả 200 < 2s.
- Worker: claim outbox, advisory lock, upsert customer/conversation, insert message idempotent.
- Outbound: gửi thật, lưu `provider_message_id`, retry backoff, phân loại lỗi.
- `FakeAdapter` + fixture webhook thật để test không cần mạng.
- **Demo:** nhắn vào Page thật → nhận trả lời; gửi lại webhook 3 lần → 1 tin.

### P3 — Bot engine + quản trị hội thoại (2 ngày)

- `resolve()` 3 bước, lưu `source`; chuẩn hoá tiếng Việt + so khớp có test.
- CRUD bot + rule; bật/tắt; đổi priority; sửa là có hiệu lực ngay (cache invalidate theo `updated_at`).
- Màn Conversations: list, thread, takeover/release, gửi tay.
- **Demo:** sửa rule trên admin → tin tiếp theo trả lời theo nội dung mới; takeover → bot im.

### P4 — Làm cứng để cho khách thật (2 ngày)

- Test: signature sai/rỗng/cắt ngắn; duplicate webhook; 2 tin đồng thời; retry outbox; cross-tenant; blocked_by_policy.
- Log redaction, không log token/nội dung; `created_by` trên rule/channel.
- Backup + restore drill; alert khi token sắp hết hạn, webhook fail, outbox lag > 100.
- Dockerfile + compose production, Caddy/nginx TLS, healthcheck.
- **Demo:** chạy trên VPS, khách thật nhắn, admin xem được, log không lộ token.

### P5 — Zalo OA (6–8 ngày, gồm chờ duyệt)

- OAuth + PKCE, lưu token, job refresh có advisory lock.
- Verify `sha256(appId+body+timestamp+OAsecret)`; resolve channel từ `recipient.id` **trước** khi verify.
- Adapter thứ hai. **Điều kiện dừng:** nếu phải sửa `messaging/` để Zalo chạy → dừng, sửa ranh giới, rồi mới tiếp.
- **Demo:** cùng một bot rule trả lời trên cả Page và OA.

### P6 — WhatsApp (6–8 ngày) — chỉ khi có nhu cầu thật

Template message, opt-in, media upload, kiểm tra chi phí theo tin trước khi cam kết với khách.

**Tổng MVP (P0–P4): 10,5 ngày công + buffer 20% ≈ 13 ngày.**

---

## 13. Chiến lược test

| Loại | Nội dung | Công cụ |
|---|---|---|
| Unit | `normalize-text`, matcher (dấu/không dấu, ranh giới từ, hoà điểm), `canSend` theo cửa sổ, mã hoá credential | Jest |
| Integration | webhook verify, idempotency, outbox retry, advisory lock, state machine | Jest + Postgres thật (docker compose) + supertest |
| E2E | login → cấu hình kênh → webhook → rule trả lời → admin đọc → takeover | supertest + `FakeAdapter` |
| Bảo mật | 2 tenant, gọi mọi endpoint bằng ID của tenant kia → 404; login sai 20 lần → 429; audit log không chứa token | Jest |
| Migration | chạy `migrate` trên DB trống và trên DB có dữ liệu | CI script |

Không dùng mock DB. Test chống rò rỉ tenant là test bắt buộc trong CI, không phải "nice to have".

---

## 14. Checklist trước khi cho khách thật dùng

1. Verify chữ ký trên raw body, constant-time, không có nhánh bỏ qua khi thiếu secret.
2. Unique idempotency ở cả `webhook_events` và `messages`, có test gửi trùng.
3. Outbox ghi trước khi gọi vendor; retry có backoff; lỗi policy không retry.
4. Credential mã hoá có AAD + key id; fail-fast nếu thiếu key; không xuất hiện trong log.
5. Session cookie `__Host-`, HttpOnly, Secure, SameSite=Lax + kiểm Origin; argon2id; rate limit.
6. Test cô lập tenant chạy trong CI.
7. Backup tự động + đã diễn tập restore; alert token hết hạn / outbox lag / webhook lỗi.
8. `conversations.mode` được kiểm trong transaction trước khi gửi.
9. Không gửi ngoài cửa sổ; lưu `blocked_by_policy` thay vì nuốt lỗi.

---

## 15. Rủi ro và câu hỏi còn mở

| Rủi ro | Mức | Cách xử lý |
|---|---|---|
| App Review Messenger bị từ chối / kéo dài | Cao | Nộp sớm từ P2; screencast mô tả rõ use case CSKH; có kênh dự phòng |
| Chính sách Meta/Zalo thay đổi (tag, cửa sổ, giá) | Cao | Cô lập trong `canSend()` + `capabilities()`; kiểm tra changelog mỗi tháng |
| Zalo refresh token mất do refresh song song | Cao | Advisory lock bắt buộc, test 2 job đồng thời |
| Rò rỉ dữ liệu chéo tenant | Cao | 1 lớp truy cập + test CI; RLS trước workspace thứ 2 |
| Khách thứ 2 đến sớm → RBAC gấp 5–7 ngày | Trung bình | Chấp nhận; đã có cột `workspace_id` sẵn |
| LLM trả lời sai/ảo giác | Trung bình | Rule-first, ngưỡng khớp chặt, fallback + handoff sau 3 lần |
| Chi phí WhatsApp theo tin | Trung bình | Chưa làm WhatsApp; nếu làm, tính giá trước |
| Số liệu ngày công lệch ±30% | Trung bình | Buffer 20%, phase nào cũng có demo |

**Cần chú Nam quyết trước P1:**

1. Thị trường chính: Messenger hay Zalo? (ảnh hưởng thứ tự P5/P6)
2. Một workspace cho một doanh nghiệp, hay sớm bán cho nhiều doanh nghiệp?
3. Ai vận hành admin hàng ngày, có cần nhiều tài khoản không?
4. Nhà cung cấp LLM đã được duyệt chưa (dữ liệu khách hàng có được gửi ra ngoài không)?
5. Domain + VPS/cloud đã có chưa?

---

## 16. Những thứ không làm (và điều kiện để làm lại)

| Hoãn | Làm khi |
|---|---|
| Redis/BullMQ | >50 msg/s bền vững, >2 worker, hoặc cần cron phân tán |
| RBAC + màn quản lý member | Workspace thứ 2 hoặc ≥3 user nội bộ |
| RLS toàn bộ DB | Trước khi onboarding workspace thứ 2 |
| `audit_logs` đầy đủ | Khách yêu cầu truy vết hoặc ≥3 user |
| Media (ảnh/file/voice) | Khách thật gửi ảnh và cần bot xử lý |
| RAG/vector DB | Rule > 300 mục hoặc FAQ > 100KB |
| Template message / broadcast | Có nhu cầu gửi ngoài cửa sổ 24h |
| Microservices | Cần scale worker độc lập hoặc deploy riêng |
| Billing, workflow builder, CRM | Có mô hình kinh doanh và khách trả tiền cho nó |
| Ảnh hoá dashboard/báo cáo | Có người dùng thật hỏi "tôi tìm X ở đâu" |

---

## 17. Ghi chú về độ tin cậy của tài liệu

- Đã kiểm chứng tháng 11/2026: công thức chữ ký webhook Zalo; 3 message tag Messenger bị khai tử 27/04/2026 và `HUMAN_AGENT` còn hiệu lực; WhatsApp System User token long-lived; React Router v7 SPA dùng `ssr: false`.
- **Chưa kiểm chứng:** cửa sổ tư vấn 48h của Zalo, bảng giá WhatsApp theo từng thị trường, thời hạn review thực tế của Meta/Zalo, giới hạn rate limit Messenger. Xác nhận lại trước khi code phần tương ứng.
- Ước lượng ngày công dựa trên một dev đã quen NestJS; nếu vừa học vừa làm, cộng 40–60%.
