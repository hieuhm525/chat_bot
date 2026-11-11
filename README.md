# bv-agent-msg

Bot CSKH đa kênh (Messenger trước, Zalo OA/WhatsApp sau) — NestJS + PostgreSQL + Drizzle.
Kế hoạch chi tiết: [`docs/PLAN-bv-agent-msg.md`](docs/PLAN-bv-agent-msg.md).
Luồng một tin nhắn (vào/ra, trạng thái): [`docs/architecture.md`](docs/architecture.md).

## Thuật ngữ

- `workspace` (DB, cột `workspace_id`) = `tenant` (module `src/modules/tenants`, màn Tenants) = một shop thuê dịch vụ. Cùng một khái niệm.
- Role `admin`: quản trị hệ thống, dùng khu vực `/admin` (`admin/app/routes/admin/`).
- Role `owner`: chủ shop, dùng khu vực `/app` (`admin/app/routes/app/`).
- Folder `admin/` là SPA chung cho cả hai khu vực (tên lịch sử).
- `channel` = một kết nối Messenger/WhatsApp/Zalo; `conversation` = một luồng chat với một khách; `rule` = câu trả lời theo từ khoá; `outbox` = hàng đợi gửi tin.

## Cấu trúc thư mục

```
src/
  config/       validate env lúc khởi động
  db/           Drizzle schema, module DB, migrations, seed
  shared/       hàm thuần dùng chung backend + admin SPA (bundle vào trình duyệt)
  common/       hạ tầng dùng chung backend: auth guard, decorator, crypto, uuid, tenant-status, bot-defaults
  modules/
    auth/           đăng nhập/đăng xuất, session cookie
    setup/          tạo admin đầu tiên khi DB chưa có user
    tenants/        quản lý tenant/workspace (chỉ admin)
    llm-providers/  cấu hình provider LLM và kiểm tra key (chỉ admin)
    bot/            AI agent, rule, resolve() rule → LLM → fallback
    channels/       kênh + adapter từng provider (messenger, zalo, whatsapp)
    messaging/      webhook, worker outbox, xử lý tin vào/ra, hội thoại, stats, health
admin/app/
  api.ts        fetch wrapper gọi /api/v1, dịch lỗi sang tiếng Việt
  App.tsx       chọn khu vực /admin hay /app theo URL, khai báo route
  components/   component dùng chung + shadcn/ui
  lib/          tiện ích nhỏ (utils, quick-replies)
  routes/admin/ màn quản trị hệ thống
  routes/app/   màn chủ shop
  routes/auth/  đăng nhập, đăng ký, setup
```

## Stack

- NestJS 11 (1 process: API + worker outbox), TypeScript
- PostgreSQL 18 + Drizzle ORM (migration sinh bằng `drizzle-kit`)
- Admin SPA: React 19 + React Router 7 (Vite, `ssr: false`), build vào `public/admin`
- Auth: session cookie server-side + argon2id, đăng nhập bằng tên đăng nhập (không cần email), không JWT/passport
- LLM: chuỗi provider OpenAI-compatible, ưu tiên model free (OpenRouter/Groq/Gemini/Ollama)
- Không Redis/BullMQ: outbox Postgres + worker `FOR UPDATE SKIP LOCKED`

## Chạy local

```bash
pnpm install
docker compose up -d                 # postgres ở 127.0.0.1:5433
cp .env.example .env
# Bắt buộc: thay CREDENTIAL_KEY bằng key thật
openssl rand -base64 32              # dán vào CREDENTIAL_KEY

pnpm db:seed                      # workspace + bot + 5 rule mẫu (không tạo tài khoản)
pnpm start:dev                    # build admin rồi chạy backend ở chế độ watch, tự áp dụng migration
```

`pnpm start:dev` build lại admin mỗi lần chạy (backend tự build lại khi sửa code). Sửa code admin trong lúc đang chạy thì chạy lại lệnh, hoặc dùng `pnpm admin:dev` (http://localhost:5173/admin) để có hot reload. `pnpm start` build cả backend lẫn admin rồi chạy bản build.

- Admin (quản lý tenant): http://localhost:3000/admin — lần đầu mở sẽ tự chuyển tới `/admin/setup` để tạo tài khoản đầu tiên
- Khu workspace của khách hàng: http://localhost:3000/app — chủ shop đăng nhập bằng tài khoản được cấp
- Swagger: http://localhost:3000/api/docs
- Health: http://localhost:3000/health

Migration được áp dụng tự động mỗi lần server khởi động (kể cả `pnpm start`); `pnpm db:migrate` chỉ còn để chạy tay khi cần.

Trang setup chỉ hoạt động khi DB chưa có user. Khi deploy, đặt `SETUP_TOKEN` trong `.env` trước khi chạy rồi nhập token đó ở `/admin/setup`; nếu để trống, chỉ máy local (127.0.0.1) mới tạo được admin. Tên đăng nhập 3–32 ký tự (chữ, số, `.`, `_`, `-`), mật khẩu từ 6 ký tự.

Tài khoản đầu tiên là **admin** (`admin`): chỉ quản lý danh sách tenant (doanh nghiệp thuê), không thấy hội thoại. Mỗi tenant tạo từ `/admin` sẽ có workspace + bot + một tài khoản `owner`; chủ shop đăng nhập tại `/app` để xem dashboard, hội thoại, kênh và cấu hình bot. Admin đặt được gói, giới hạn bot/kênh, ngày hết hạn, khóa/mở lại tenant và đặt lại mật khẩu owner. Tenant `suspended`/`expired` hoặc quá `expires_at` không đăng nhập được; webhook vẫn lưu tin đến nhưng bot không trả lời.

Tạo admin bằng CLI (tùy chọn, hoặc dùng biến `ADMIN_USERNAME` / `ADMIN_PASSWORD`):

```bash
pnpm admin:create --username admin --password "mat-khau-6-ky-tu"
```

## Model AI free

Provider và API key được quản lý trong DB, tại `/admin` → **AI provider**: thêm/sửa, bật/tắt,
đổi thứ tự ưu tiên, nút kiểm tra key. Key được mã hoá bằng `CREDENTIAL_KEY` và không bao giờ
trả ra API (chỉ hiện 4 ký tự cuối).

Thứ tự thử là `priority` giảm dần; provider lỗi/timeout thì nhảy sang provider kế tiếp.
Provider không có `apiKey` bị bỏ qua, trừ khi là `localhost`/`127.0.0.1` (Ollama).

`LLM_PROVIDERS` trong `.env` **chỉ dùng để seed lần đầu khi bảng `llm_providers` còn trống**;
sau đó biến này bị bỏ qua. Muốn đổi key, dùng trang admin, không cần restart.

```jsonc
[
  { "name": "openrouter-free", "baseUrl": "https://openrouter.ai/api/v1", "model": "meta-llama/llama-3.3-70b-instruct:free", "apiKey": "sk-or-..." },
  { "name": "groq-free",       "baseUrl": "https://api.groq.com/openai/v1", "model": "llama-3.3-70b-versatile", "apiKey": "gsk_..." },
  { "name": "gemini-free",     "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-3.5-flash-lite", "apiKey": "..." },
  { "name": "ollama-local",    "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5:3b", "apiKey": "" }
]
```

Danh sách model free thay đổi theo từng provider — kiểm tra lại trước khi triển khai.
Để `[]` nếu chỉ muốn chạy rule (không gọi AI).

## Luồng chính

1. `POST /webhooks/:provider` verify chữ ký trên raw body → ghi `webhook_events` + `outbox` trong 1 transaction → trả 200.
2. Worker (1s) claim outbox → parse → advisory lock theo hội thoại → upsert customer/conversation → insert message (idempotent theo `provider_message_id`).
3. `resolve()`: rule → LLM → fallback; lưu `metadata.source` trên tin trả lời.
4. Tin bot/agent đi qua outbox → kiểm tra cửa sổ gửi (`canSend`) → gọi adapter → lưu `provider_message_id`, trạng thái `sent`/`failed`/`blocked_by_policy`.
5. Human takeover: `conversations.mode = human`; worker bỏ qua tin mới của bot nhưng vẫn lưu để agent đọc.

## API

Tất cả dưới `/api/v1`, trừ `/webhooks/*` và `/health`.

| Method | Path |
|---|---|
| POST | `/auth/login`, `/auth/logout`; GET `/auth/me` |
| GET/POST/PATCH | `/tenants`, `/tenants/:id` (chỉ `admin`); POST `/tenants/:id/suspend`, `/resume`, `/reset-owner-password` |
| ALL | `/customers/*` → 308 sang `/tenants/*` (alias tạm thời) |
| GET/POST/PATCH/DELETE | `/llm-providers`; POST `/llm-providers/:id/test` (chỉ `admin`) |
| GET | `/conversations`, `/conversations/:id`, `/conversations/:id/messages?before=` |
| POST | `/conversations/:id/takeover`, `/release`, `/messages` |
| GET/POST/PATCH/DELETE | `/channels`, `/channels/:id/test` (chỉ `owner`) |
| GET/POST | `/bots`; GET/PATCH/DELETE `/bots/:botId`; GET/POST/PATCH/DELETE `/bots/:botId/rules` (chỉ `owner`) |
| GET | `/stats/summary` |

Phân quyền (deny by default): `admin` chỉ gọi `/tenants/*` và `/llm-providers/*`; `owner` gọi toàn bộ API của tenant (`/bots/*`, `/channels/*`, `/conversations/*`, `/stats/*`). Chưa có role nhân viên; `messages.sender_type = 'agent'` nghĩa là tin do người (chủ shop hoặc Page Inbox) gửi, không phải role. Endpoint mới phải khai báo `@Roles`, nếu không sẽ bị `RolesGuard` chặn.

Mỗi tenant có nhiều AI agent. Kênh phải chọn `botId` và bot phải thuộc cùng tenant. Tạo bot/kênh vượt `maxBots`/`maxChannels` trả 403 (khóa dòng workspace trong cùng transaction nên request song song không vượt được). Kênh `disabled` không tính vào giới hạn và chỉ lưu tin, không trả lời. Xoá bot đang gắn kênh hoặc bot cuối cùng trả 409; bot đã có tin được soft delete. Xoá kênh đã có hội thoại sẽ chuyển `status='disabled'` và giữ lịch sử.

## Test

```bash
pnpm typecheck     # tsc --noEmit, gồm cả e2e
pnpm test          # unit: normalize, matcher, crypto, canSend
pnpm test:e2e      # e2e: webhook, hội thoại, phân quyền, cách ly tenant
```

E2E tự tạo DB `bv_agent_msg_test` trên Postgres của `docker compose` (port 5433) và chạy toàn bộ migration. Không mock DB.

Muốn trỏ vào Postgres khác (ví dụ CI), đặt trước khi chạy:

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/bv_agent_msg_test
export TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
```

CI (`.github/workflows/ci.yml`) chạy trên mọi push và pull request: Node 24 + pnpm, service `postgres:18-alpine`, rồi `pnpm install --frozen-lockfile`, `typecheck`, `build`, `admin:build`, `test`, `test:e2e`. Bước cuối chạy `drizzle-kit generate` và fail nếu schema và migration lệch nhau.

## Trạng thái theo phase

| Phase | Nội dung | Trạng thái |
|---|---|---|
| P0 | Khung Nest, env fail-fast, `/health`, Swagger | ✅ |
| P1 | 11 bảng + migration + seed, auth session/argon2id, admin shell | ✅ |
| P2 | Messenger adapter, webhook, worker, outbox, retry, FakeAdapter qua mock fetch | ✅ |
| P3 | `resolve()` rule→LLM→fallback, CRUD bot/rule, conversations + takeover | ✅ |
| P4 | Test bảo mật/idempotency, log redaction, health | 🟡 một phần (backup/alert/Dockerfile production chưa làm) |
| P5 | Zalo OA | 🟡 adapter verify/parse/send cơ bản; OAuth + refresh lock chưa làm |
| P6 | WhatsApp | 🟡 adapter text cơ bản; template/opt-in/media chưa làm |

## Khác với kế hoạch

- Dùng **pnpm** nhưng là single package (không chia workspace con); `pnpm-workspace.yaml` chỉ để khai báo `allowBuilds` (argon2, esbuild).
- Admin dùng React Router **library mode** + Vite thay vì framework mode: cùng kết quả SPA `ssr:false`, ít file hơn.
- `sessions` là bảng thứ 11 (kế hoạch đếm 10 bảng nhưng D5 yêu cầu session server-side).
- Tách **`/admin`** (admin quản lý khách hàng) và **`/app`** (workspace của khách) thay vì một admin console duy nhất như kế hoạch gốc.
- UUIDv7 dùng hàm `uuidv7()` của PostgreSQL 18; nếu chạy PG < 18, đổi default trong `src/db/schema.ts` sang `gen_random_uuid()` và regenerate migration.
