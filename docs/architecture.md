# Kiến trúc: luồng một tin nhắn

Tài liệu này mô tả đường đi của một tin nhắn qua hệ thống. Code là nguồn đúng; mỗi bước ghi file chịu trách nhiệm.

## Tin vào (khách → bot)

1. **Webhook** — `src/modules/messaging/webhook.controller.ts`
   - `GET /webhooks/:provider` xác minh đăng ký (`hub.verify_token` trong env hoặc trong DB của kênh).
   - `POST /webhooks/:provider` tìm kênh theo external id (kể cả kênh `disabled`), verify chữ ký trên raw body qua adapter (`src/modules/channels/adapters/`).
   - Ghi `webhook_events` (idempotent theo hash raw body) + một job `outbox` kind `process_event` trong **cùng một transaction**, rồi trả 200 ngay. Không xử lý gì thêm trong request.
2. **Worker** — `src/modules/messaging/outbox.worker.ts`
   - Tick mỗi 1 giây (`setInterval`, tắt bằng `WORKER_ENABLED=false`), claim tối đa 20 job bằng `FOR UPDATE SKIP LOCKED`, retry với backoff 5s → 1h, tối đa 5 lần.
   - Job `process_event` gọi `EventProcessor.process()`; job `send_message` gọi `OutboundService.send()`.
3. **Xử lý event** — `src/modules/messaging/event-processor.service.ts`
   - Adapter `parse()` payload thành sự kiện chuẩn (`message`, `status`, echo từ Page Inbox).
   - Với tin khách: advisory lock theo hội thoại → upsert `customers` + `conversations` → insert `messages` (`direction='in'`, `status='received'`, idempotent theo `provider_message_id`).
   - Cập nhật profile khách và hiện "đang nhắn" chạy song song, lỗi không chặn câu trả lời.
   - Bỏ qua trả lời nếu hội thoại ở `mode='human'`, kênh `disabled`, tenant bị khóa/hết hạn, hoặc bot tắt.
4. **Soạn câu trả lời** — `src/modules/bot/bot.service.ts`
   - `resolve()`: khớp `rule` (`scoreRule` + `matchRule`) → nếu không khớp và bot bật LLM thì gọi `src/modules/bot/llm.service.ts` (chuỗi provider theo `priority`) → cuối cùng là `fallbackMessage`. Không bao giờ ném lỗi.
   - Lưu `metadata.source` (`rule` / `llm` / `fallback`), kèm ruleId, model, token, latency.
   - Tin dài được cắt theo `maxTextLength` của adapter; mỗi phần cách nhau một độ trễ "đang nhắn" (`src/modules/messaging/reply-pacing.ts`).
   - Ghi từng tin `sender_type='bot'` (gồm cả lời chào `kind='greeting'`, câu chuyển người `kind='handoff'`, tin chờ `kind='wait'`) với `status='queued'` qua `message-writer.ts` và tạo job `outbox` kind `send_message` trong cùng transaction; `next_attempt_at` được dời theo `typingDelayMs` để các phần ra cách nhau.
   - Tin `sender_type='system'` (ghi chú nội bộ như auto-handoff) ghi thẳng `status='sent'`, **không** có job outbox, không gửi cho khách.

## Tin ra (bot/agent → khách)

1. **Worker** — `src/modules/messaging/outbox.worker.ts` claim job `send_message`.
2. **Gửi** — `src/modules/messaging/outbound.service.ts`
   - Chỉ gửi tin đang `queued`.
   - Tin bot: kiểm tra tenant còn hiệu lực; hội thoại phải còn `mode='bot'` (trừ tin `handoff`).
   - Không vượt tin trước còn `queued` trong cùng hội thoại (giữ thứ tự các phần).
   - Gọi `canSend()` của adapter: ngoài cửa sổ trả lời (Messenger/WhatsApp 24h, Zalo 48h) → `blocked_by_policy` với `error_code` là lý do.
   - Gọi `adapter.send()` → lưu `provider_message_id`, đổi `status='sent'`.
   - Lỗi không retry được → `failed`; lỗi tạm thời → ném ra để worker retry; hết 5 lần → `failed` (`send_gave_up`).
3. **Adapter** — `src/modules/channels/adapters/{messenger,whatsapp,zalo}.adapter.ts` gọi API provider.

## Admin/owner trả lời tay

`src/modules/messaging/conversations.controller.ts` `POST /conversations/:id/messages` → `ConversationsService.sendAgentMessage()` ghi tin `sender_type='agent'`, `status='queued'` + job `outbox` → đi đúng đường tin ra ở trên. UI `admin/app/routes/app/conversations.tsx` polling 2 giây khi còn tin `queued`, 8 giây khi rảnh.

## Trạng thái `messages.status`

Lấy từ check constraint trong `src/db/schema.ts`:

| Giá trị | Ý nghĩa |
|---|---|
| `received` | Tin vào từ khách (giữ nguyên trạng thái này, không đổi sau khi bot trả lời) |
| `queued` | Tin ra đang chờ worker gửi |
| `sent` | Provider đã nhận (có `provider_message_id`) |
| `delivered` | Provider báo đã tới thiết bị khách |
| `read` | Khách đã đọc |
| `failed` | Gửi thất bại (kèm `error_code`) |
| `blocked_by_policy` | Không gửi vì ngoài cửa sổ trả lời của provider |

`outbox.status`: `pending` → `running` → `done`, hoặc `failed` sau 5 lần thử.

## Sơ đồ

```mermaid
flowchart LR
  W[webhook.controller<br/>verify + ghi transaction] --> O[(outbox)]
  U[conversations.controller<br/>POST /:id/messages] --> Q[messages out: queued<br/>+ job send_message]
  O --> K[outbox.worker<br/>tick 1s]
  K -->|process_event| E[event-processor.service<br/>upsert + advisory lock]
  E --> IN[messages in: received]
  E --> R[bot.service resolve<br/>rule → llm → fallback]
  R --> Q
  Q --> K
  K -->|send_message| S[outbound.service<br/>tenant, mode, thứ tự, canSend]
  S --> A[channels/adapters<br/>messenger | whatsapp | zalo]
  A --> ST[messages: sent | failed | blocked_by_policy]
```

- Job `process_event` → `EventProcessor`, job `send_message` → `OutboundService`.
- Mọi thay đổi DB của một bước nằm trong transaction của bước đó.
