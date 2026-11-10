# Prompt: sửa codebase cho đúng mô hình cho thuê AI agent

Đọc `docs/PROMPT.md` (yêu cầu sản phẩm), `src/db/schema.ts`, `README.md` trước khi sửa. Không viết lại những phần đã đúng: webhook + verify chữ ký, outbox worker, advisory lock, `resolve()`, lọc `workspace_id` trong service, test 404 chéo tenant.

Làm lần lượt từng bước bên dưới. Mỗi bước gồm migration drizzle-kit mới (không sửa migration cũ, dữ liệu cũ phải còn), code, test. Sau mỗi bước chạy `pnpm test`, `pnpm test:e2e` và `pnpm build`, rồi báo lại những gì đã đổi. Không chuyển sang bước sau nếu test đang đỏ.

## Phạm vi của admin (đã chốt)

Admin chỉ làm hai việc: **quản lý tenant** và **quản lý LLM provider/API key** (Gemini, OpenRouter, Groq, Ollama…). Admin không có màn hình hay API nào về hội thoại, bot, rule hoặc kênh. Những thứ đó thuộc về tenant ở `/app`.

- Bỏ cột "Bot" và nút "Bật/Tắt bot" ở `admin/app/routes/customers.tsx`, bỏ `botEnabled` trong `UpdateCustomerDto` và `CustomersService.update/list`. Thay bằng khóa/mở tenant (bước 2).
- Không xoá `admin/app/routes/conversations.tsx`, `bot.tsx`, `channels.tsx`, `dashboard.tsx`: đó là màn hình của tenant (`/app`), không phải của admin.
- Backend: user `admin` gọi `/conversations`, `/bot(s)`, `/channels`, `/stats` phải nhận **403** (bước 4). Hiện tại các API này trả dữ liệu rỗng của workspace Platform thay vì chặn.

## Bước 1. Lưu message đầy đủ — ĐÃ XONG

Đã làm và có e2e test: `sender_user_id`, `bot_id`, metadata tin bot, tách lời chào / trả lời / chuyển người, tin `system` khi takeover, release và auto-handoff, lưu echo từ Page Inbox, lưu URL tệp đính kèm, phân trang `(created_at, id)`, `conversations.message_count` và `bot_id`.

Còn lại (làm cùng bước 3): `resolveBot()` vẫn còn nhánh fallback "bot đầu tiên của workspace". `bots.llm_model` được lưu nhưng `LlmService` không dùng.

<details><summary>Yêu cầu gốc của bước 1</summary>

## Bước 1 (gốc). Lưu message đầy đủ

Hiện trạng sai:
- `messages` không lưu nhân viên nào gửi tin: `sendAgentMessage` trong `src/modules/messaging/conversations.service.ts` không nhận `userId`.
- Tin bot không lưu AI agent nào trả lời, rule nào khớp, model nào, bao nhiêu token, phản hồi mất bao lâu. `metadata` chỉ có `{ source }`.
- Lời chào, câu trả lời và câu chuyển người bị gộp vào **một** tin (`event-processor.service.ts`, biến `text`), nên không biết tin nào là tin nào.
- Takeover, release và auto-handoff (sau N lần fallback) chỉ đổi `conversations.mode`. Không để lại dấu vết trong lịch sử.
- Messenger bỏ qua tin `is_echo` (`messenger.adapter.ts`). Vì vậy tin nhân viên trả lời thẳng trong Facebook Page Inbox không được lưu, và lịch sử bị thiếu.
- Ảnh/file được lưu là `unsupported` với nội dung rỗng, mất URL tệp đính kèm.
- Phân trang message dùng `createdAt < before` (`messagesBefore`). Tin trùng timestamp bị bỏ sót, và `before` sai định dạng gây lỗi 500.

Cần làm:
1. Thêm vào `messages`: `sender_user_id uuid null → users.id`, `bot_id uuid null → bots.id`. Thêm check: `sender_type='agent'` thì `sender_user_id` bắt buộc; `sender_type='bot'` thì `bot_id` bắt buộc. Backfill dữ liệu cũ trước khi bật check: tin bot cũ gán bot của workspace; tin agent cũ gán `assigned_user_id` của conversation, hoặc owner nếu không có.
2. `sendAgentMessage(workspaceId, id, userId, content)`. Controller truyền `user.id`.
3. `BotService.resolve()` trả thêm `{ ruleId?, model?, provider?, tokensIn?, tokensOut?, latencyMs }`. `LlmService` đọc `usage` từ response OpenAI-compatible. Ghi tất cả vào `metadata` của tin bot.
4. Tách thành nhiều tin riêng, theo thứ tự: tin lời chào (`metadata.kind='greeting'`), tin trả lời, tin chuyển người (`metadata.kind='handoff'`). Mỗi tin có outbox riêng, gửi đúng thứ tự trong cùng conversation.
5. Ghi message `sender_type='system'`, `direction='out'`, `status='sent'`, **không** tạo outbox (không gửi cho khách) cho các sự kiện: `takeover` (ai), `release` (ai), `auto_handoff` (sau bao nhiêu fallback). Ghi trong cùng transaction với lệnh đổi `mode`. `release` cũng phải nhận `userId`.
6. Messenger echo: nếu `mid` đã có trong `messages` (tin do hệ thống gửi) thì bỏ qua. Nếu chưa có thì lưu thành `direction='out'`, `sender_type='agent'`, `sender_user_id=null`, `metadata.via='page_inbox'`. Nới check ở mục 1 cho riêng trường hợp này.
7. Tệp đính kèm: đổi `contentType` thành `image` hoặc `file`, lưu `metadata.attachments=[{type,url}]`. Bot vẫn trả câu "chưa xem được ảnh/file".
8. Phân trang theo id (uuidv7 tăng dần theo thời gian): `?before=<messageId>`, so sánh `(created_at, id)`. `before` không hợp lệ thì trả 400.
9. Thêm cột `conversations.message_count` (tăng trong transaction insert message) và `conversations.bot_id` (agent đang phục vụ).

Test: một conversation đi qua đủ luồng khách → bot (rule) → bot (llm, mock) → fallback ×N → auto-handoff → agent trả lời → release → bot. Kiểm tra từng message có đúng `sender_type`, `sender_user_id`, `bot_id`, `metadata` và đúng thứ tự. Thêm test echo không bị trùng và test phân trang không mất tin trùng timestamp.

</details>

## Bước 1b. Admin quản lý LLM provider và API key — ĐÃ XONG

Đã làm: bảng `llm_providers` (migration `0005`), key mã hoá AES-GCM với AAD = provider id, API `/llm-providers` chỉ admin (owner nhận 403), response chỉ có `hasKey` + 4 ký tự cuối, PATCH không gửi key thì giữ key cũ, `LlmService` đọc DB + cache 30s và xoá cache khi admin sửa, `LLM_PROVIDERS` chỉ seed khi bảng trống, UI `/admin/providers`, bỏ `llmModel` khỏi DTO bot. E2E đã kiểm tra: key không lộ, provider tắt không bị gọi, provider đầu lỗi thì chuyển provider sau, metadata tin bot ghi provider/model/token thật.

Đã sửa thêm: seed `LLM_PROVIDERS` chạy trong `onModuleInit`, có unit test.

Còn lại:
- Cột `bots.llm_model` không còn được dùng nhưng vẫn còn trong schema. Để nguyên, xoá ở một migration sau khi chắc chắn không cần.

<details><summary>Yêu cầu gốc của bước 1b</summary>

Hiện trạng: provider và API key nằm trong biến môi trường `LLM_PROVIDERS` (JSON), được đọc một lần lúc khởi động trong `src/modules/bot/llm.service.ts`. Muốn đổi key phải sửa `.env` rồi restart.

Cần làm:
1. Bảng `llm_providers`: `id`, `name`, `kind` (`openai_compatible`), `base_url`, `model`, `api_key_enc`, `key_id`, `priority` int, `enabled` bool, `last_check_at`, `last_check_ok`, `last_error`, `created_at`, `updated_at`. Mã hoá key bằng `encryptCredential` trong `src/common/crypto.ts` với `CREDENTIAL_KEY` (dùng `provider.id` làm associated data, giống cách kênh đang làm).
2. API chỉ cho `admin`: `GET/POST/PATCH/DELETE /api/v1/llm-providers` và `POST /llm-providers/:id/test` (gọi một completion ngắn, lưu kết quả). **Không bao giờ trả `api_key` ra ngoài**: chỉ trả `hasKey: true` và 4 ký tự cuối. PATCH với `apiKey` rỗng hoặc không gửi thì giữ key cũ.
3. `LlmService` đọc provider từ DB (`enabled = true`, sắp xếp theo `priority`), cache trong RAM khoảng 30 giây, và xoá cache khi admin sửa. Giữ thứ tự thử lần lượt: provider lỗi thì chuyển sang provider kế tiếp. `LLM_PROVIDERS` trong env chỉ dùng để **seed lần đầu** khi bảng trống, sau đó bỏ qua. Ghi rõ điều này trong README.
4. Tenant không thấy và không chọn API key. Bỏ `bots.llm_model` khỏi `UpdateBotDto` và UI tenant (hoặc để admin cho phép tenant chọn trong danh sách model đã bật; nếu làm thì `bots.llm_provider_id` FK, null = theo thứ tự mặc định). Mặc định: bỏ.
5. Metadata tin bot vẫn ghi `provider` và `model` thực tế đã trả lời (đã có).
6. UI admin: thêm menu "AI provider" cạnh "Khách hàng": bảng provider, form thêm/sửa (ô key kiểu password, để trống = giữ nguyên), nút "Kiểm tra", kéo hoặc sửa số để đổi thứ tự ưu tiên.
7. Test: key không xuất hiện trong bất kỳ response hay log nào; tenant `owner` gọi `/llm-providers` → 403; provider bị tắt thì không được gọi; provider đầu lỗi thì chuyển sang provider sau.

</details>

## Bước 2. Tenant và gói thuê — ĐÃ XONG

(Mục 6 và 3 việc "còn lại" bên dưới đã được làm trong bước 4.)

Đã làm: module `tenants` (alias `/customers` trả 308), migration `0006` (status, plan, max_bots, max_channels, expires_at; workspace cũ thành `active`), API tạo/sửa/khóa/mở/đặt lại mật khẩu (xoá session của owner), danh sách tenant dùng subquery, chặn đăng nhập và session của tenant bị khóa hoặc hết hạn (admin không bị ảnh hưởng), webhook của tenant bị khóa vẫn lưu tin nhưng bot im lặng, UI admin bỏ nút bật/tắt bot. Có e2e test cho từng trường hợp.

Còn lại:
- **Mục 6 chưa làm**: admin vẫn gọi được `/conversations`, `/bot`, `/channels`, `/stats`. Các API này trả dữ liệu rỗng của workspace Platform thay vì 403. Chuyển sang bước 4, vì `RolesGuard` deny-by-default sẽ xử lý mục này cho mọi endpoint.
- Tin bot đã `queued` trước khi tenant bị khóa vẫn được `OutboundService` gửi đi. Nên kiểm tra `tenantBlocked` trước khi gửi tin `sender_type='bot'`, và đánh dấu `failed` với `error_code='tenant_blocked'`.
- `messagesThisMonth` đếm trên `messages` theo `workspace_id`, nhưng chưa có index phù hợp. Thêm index `messages (workspace_id, created_at)` để danh sách tenant không quét toàn bảng khi dữ liệu lớn.

<details><summary>Yêu cầu gốc của bước 2</summary>

Hiện trạng sai:
- Module `customers` phía admin thực ra là tenant, trùng tên với bảng `customers` (khách nhắn tin).
- Chưa có gói thuê, hạn dùng hay trạng thái tenant. Admin chỉ bật/tắt được bot.
- `list()` join `bots` và `users` owner, nên một tenant có nhiều bot hoặc nhiều owner sẽ bị nhân dòng.

Cần làm:
1. Đổi `src/modules/customers` thành `src/modules/tenants`, route `/api/v1/tenants`, file UI `admin/app/routes/tenants.tsx`. Giữ alias `/customers` trả 308 trong một phiên bản.
2. Thêm vào `workspaces`: `status` (`trial|active|suspended|expired`), `plan` (text), `max_bots` int, `max_channels` int, `expires_at` timestamptz null.
3. API admin: tạo, sửa (tên, gói, giới hạn, hạn), `POST /tenants/:id/suspend`, `/resume`, `/reset-owner-password`. Danh sách trả số đếm (bots, channels, conversations, messages tháng này) bằng subquery, không join nhân dòng.
4. Auth: `resolveSession` từ chối user của tenant có `status in (suspended, expired)` hoặc `expires_at < now()`. Admin không bị ảnh hưởng.
5. Event processor: tenant không hoạt động thì **vẫn lưu** tin vào nhưng không gọi bot.
6. Admin **không** có endpoint nào trả nội dung message hay conversation. Thêm test: user admin gọi `/conversations` phải nhận 403, không phải danh sách rỗng.
7. Bỏ `botEnabled` khỏi API và UI admin (cột "Bot", nút "Bật/Tắt bot"). Thay bằng cột "Trạng thái", "Gói", "Hết hạn" và các nút "Khóa" / "Mở lại" / "Đặt lại mật khẩu". Sửa test e2e `lists customers and lets the admin toggle the bot` theo hành vi mới.
8. Tenant tự bật/tắt bot của mình trong `/app/bot` (đã có `enabled` trong `UpdateBotDto`), admin không làm việc này.

</details>

> **Thứ tự mới: làm bước 4 trước bước 3.** Bước 3 sẽ thêm nhiều endpoint mới (`/bots`, `/bots/:id/rules`). Khi `RolesGuard` deny-by-default đã có sẵn, mỗi endpoint mới buộc phải khai báo role ngay lúc viết, thay vì phải rà lại sau.

## Bước 3. Nhiều AI agent mỗi tenant — ĐÃ XONG

Đã làm: API `/bots` và `/bots/:id/rules` có `@Roles('owner')`, lọc theo workspace. Migration `0008` (`system_prompt`, `deleted_at`), `0009` (xoá `llm_model`), `0010` (persona mặc định, backfill bot có prompt rỗng, unique index `(provider, external_id) where status <> 'disabled'`). Persona của tenant đứng trước luật nền tảng, giới hạn 4000 ký tự; giọng điệu nằm trong persona mặc định thay vì luật nền tảng. Tạo bot, tạo kênh và mọi lần bật lại kênh (`activate()`) đều kiểm tra giới hạn gói trong transaction có `FOR UPDATE`. `test()` không bật lại kênh `disabled`. Page ID trùng với kênh đang chạy của tenant khác trả 409. Kênh bắt buộc có agent. Không xoá được bot đang gắn kênh hoặc bot cuối cùng (409); bot đã có tin nhắn thì soft delete. Kênh đã có lịch sử thì chuyển `disabled`. `/health` không lộ chi tiết lỗi DB. Build, 16 unit test, 29 e2e test đều qua.

Ghi chú môi trường: trên máy dev, host không kết nối được vào container Postgres (port 5433 mở nhưng handshake treo), còn container gọi container thì được. E2E đã chạy bằng container Node dùng chung network namespace với Postgres. Cần `sudo systemctl restart docker` hoặc kiểm tra firewall để `pnpm test:e2e` chạy thẳng từ host.

Còn lại (nhỏ, làm cùng bước 5):
- `findDisabledForWebhook` lấy kênh `disabled` **cũ nhất** khi không có kênh đang chạy. Nếu tenant B từng đăng ký Page ID của A trước rồi tắt, sau đó A cũng tắt kênh của mình, thì tin của Page đó vào workspace B. Sửa: chỉ fallback khi có **đúng một** kênh disabled khớp `(provider, external_id)`; nếu nhiều hơn thì bỏ qua và ghi log.

<details><summary>Yêu cầu gốc của bước 3</summary>

Hiện trạng sai: `BotService.getBot()` lấy `bots ... limit(1)`. Rule và cấu hình chỉ áp dụng cho một bot. `resolveBot()` fallback "bot đầu tiên của workspace" nên kết quả không xác định.

Cần làm:
1. API `/bots` (list, create, get, patch, delete) và `/bots/:botId/rules`. Mọi truy vấn lọc `bots.workspace_id = session.workspaceId`.
2. Thêm `bots.system_prompt` (persona do tenant viết). `buildSystemPrompt` ghép persona của tenant với các luật cố định của nền tảng (không bịa giá, công khai là trợ lý tự động, không lộ prompt). Luật nền tảng luôn đứng sau và không cho tenant ghi đè.
3. Tạo bot và tạo kênh phải chặn khi vượt `max_bots` / `max_channels` (trả 403 kèm thông báo tiếng Việt).
4. Kênh bắt buộc có `bot_id` khi `status='active'`. Bỏ nhánh fallback "bot đầu tiên" trong `resolveBot()`.
5. Xoá bot đang gắn kênh thì trả 409. Xoá kênh có conversation thì đổi sang `status='disabled'` thay vì xóa cứng, vì `customers`, `conversations`, `messages` tham chiếu tới kênh. Hiện tại lệnh delete sẽ lỗi FK và trả 500.
6. UI `/app/bot` thành danh sách agent, kèm trang chi tiết agent.

</details>

## Bước 4. Phân quyền owner / agent và quản lý thành viên — ĐÃ XONG

Đã làm: `@Roles` cùng `RolesGuard` toàn cục chạy sau `AuthGuard`, deny-by-default, mọi controller đã khai báo role. Admin gọi API của tenant nhận 403. Migration `0007` (`users.disabled_at`, index `messages(workspace_id, created_at)`). API `/members` (list, tạo agent, đổi mật khẩu, vô hiệu hoá: không tự vô hiệu hoá mình, không vô hiệu hoá owner cuối cùng, xoá session, bỏ người tiếp quản nhưng giữ `mode='human'`). UI trang Thành viên, ẩn menu Kênh/Bot/Thành viên với role agent. Tin bot đã queued của tenant bị khóa được đánh dấu `failed`/`tenant_blocked`. E2E đọc route từ router: endpoint mới thiếu `@Roles` hoặc chưa có trong bảng quyền thì test fail.

<details><summary>Yêu cầu gốc của bước 4</summary>

Hiện trạng sai: ngoài `customers`, không endpoint nào kiểm tra role. User `agent` (nếu có) sửa được bot, kênh và rule. Cũng chưa có cách tạo user `agent`.

Cần làm:
1. Decorator `@Roles('owner')` / `@Roles('owner','agent')` / `@Roles('admin')` cùng một `RolesGuard` toàn cục. Endpoint không khai báo role thì mặc định **chặn** (deny by default), chỉ `@Public()` mới bỏ qua.
2. Bảng quyền:
   - `admin`: chỉ `/tenants/*` và `/llm-providers/*`. Mọi endpoint của tenant trả 403 cho admin.
   - `owner`: `/bots/*`, `/channels/*`, `/members/*`, `/conversations/*`, `/stats/*`.
   - `agent`: `/conversations/*`, `/stats/summary`.
3. API `/members` cho owner: list, tạo user `agent` (username, mật khẩu), đổi mật khẩu, xóa. Không xoá được chính mình hay owner cuối cùng. Xoá user thì đặt lại `assigned_user_id` và xoá session của user đó. Tin cũ giữ nguyên `sender_user_id`, nên dùng soft delete: `users.disabled_at`.
4. Test dạng bảng: mỗi role × mỗi endpoint → mã trả về mong đợi.

</details>

## Bước 5. Màn hình conversation cho tenant — ĐÃ XONG

Đã làm: `GET /conversations` lọc theo kênh, agent, mode, người tiếp quản, khoảng ngày; tìm theo tên khách, external id và nội dung message (escape `%`/`_`, chỉ trong workspace), migration `0011` bật `pg_trgm` và GIN index trên `messages.content`. Cursor `(last_message_at, id)` mã hoá base64url, `limit` mặc định 30 tối đa 100, cursor sai trả 400. Mỗi dòng có tên kênh, tên agent, người tiếp quản, đoạn trích tin cuối. `GET /conversations/options` cho bộ lọc. Message trả `senderName` (Khách, tên bot, username, Page Inbox, Hệ thống), `status`, `errorCode`, `metadata`. Webhook vào kênh disabled chỉ khi có đúng một kênh khớp. UI `/app/conversations` có bộ lọc, tải thêm và chi tiết metadata. Lọc `from`/`to` dạng `YYYY-MM-DD` tính theo `workspaces.timezone` (bước 6). Build, 16 unit test, 35 e2e test đều qua.

<details><summary>Yêu cầu gốc của bước 5</summary>

1. Bộ lọc danh sách: kênh, AI agent, mode, người tiếp quản, khoảng thời gian. Tìm kiếm theo tên khách **và** nội dung message (dùng `pg_trgm` index trên `messages.content`, giới hạn trong workspace).
2. Cursor danh sách dùng `(last_message_at, id)`. Bỏ hằng số `30` viết cứng.
3. Khung chat hiển thị rõ người gửi: khách, tên AI agent, tên nhân viên, tin hệ thống, tin gửi từ Page Inbox. Tin `failed` / `blocked_by_policy` hiện lý do.
4. Xem chi tiết metadata của tin bot (nguồn, rule, model, token, độ trễ) khi bấm vào tin.

</details>

## Bước 6. Test và CI — ĐÃ XONG

Đã làm: `from`/`to` dạng `YYYY-MM-DD` tính theo `workspaces.timezone` bằng `AT TIME ZONE` (không thêm thư viện ngày). E2E đọc `TEST_DATABASE_URL` / `TEST_ADMIN_DATABASE_URL`, `afterAll` đóng app + pool nên Jest thoát sạch, không cần `--forceExit`. Test cách ly đọc route từ router: mọi route tenant có tham số id gọi bằng id tenant B → 404 (route mới thiếu mẫu dữ liệu thì fail), admin gọi route tenant → 403, danh sách của A không chứa id của B. Test admin không thấy nội dung tin, tên khách, system prompt hay phần thân API key qua `/tenants` và `/llm-providers`. CI `.github/workflows/ci.yml` chạy Node 24 + pnpm + service Postgres 18: typecheck, build, admin build, unit, e2e, và kiểm tra `drizzle-kit generate` không sinh migration mới. README có cách chạy test local và biến môi trường cho CI. 35 e2e test, 16 unit test đều qua.

<details><summary>Yêu cầu gốc của bước 6</summary>

- Test cách ly: user tenant A gọi mọi endpoint có `:id` với id của tenant B → 404. Danh sách của A không chứa dữ liệu của B.
- Test admin không đọc được message.
- Test giới hạn gói và tenant bị khóa.
- Các test trên chạy trong `pnpm test:e2e` và CI.

</details>

## Ngoài phạm vi
Thanh toán, hoá đơn, RAG, workflow builder, broadcast, đa ngôn ngữ. Không thêm Redis hay microservice.
