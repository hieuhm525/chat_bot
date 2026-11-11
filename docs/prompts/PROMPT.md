# Prompt: nền tảng cho thuê AI agent CSKH (bv-agent-msg)

## Bối cảnh

Bạn đang làm việc trên repo `bv-agent-msg`: NestJS 11 + PostgreSQL + Drizzle, admin SPA React (Vite) trong `admin/`. Đọc `README.md`, `docs/PLAN-bv-agent-msg.md` và `src/db/schema.ts` trước khi sửa. Repo đã có: webhook Messenger, outbox worker, `resolve()` rule → LLM → fallback, session cookie + argon2id, human takeover, các bảng `workspaces, users, bots, channels, customers, conversations, messages, bot_rules`.

## Mục tiêu sản phẩm

Đây là dịch vụ **cho thuê AI agent chăm sóc khách hàng** (SaaS). Chủ nền tảng bán gói thuê cho các doanh nghiệp. Mỗi doanh nghiệp thuê là một **tenant**. Tenant tạo và cấu hình AI agent của họ, gắn agent vào các kênh chat (Messenger trước, Zalo OA sau). Agent tự trả lời khách nhắn tới, và nhân viên của tenant có thể tiếp quản khi cần.

## Thuật ngữ (dùng thống nhất trong code, UI và tài liệu)

| Thuật ngữ | Nghĩa | Bảng hiện tại |
|---|---|---|
| Admin | Chủ nền tảng, người bán dịch vụ | `users.role = 'admin'`, workspace `is_platform = true` |
| Tenant | Doanh nghiệp thuê dịch vụ | `workspaces` |
| Thành viên tenant | Người đăng nhập của tenant: `owner` (chủ) và `agent` (nhân viên) | `users` |
| AI agent | Con bot do tenant cấu hình | `bots` (+ `bot_rules`) |
| Khách | Người nhắn tin vào kênh của tenant | `customers` |
| Conversation | Một luồng chat giữa một khách và một kênh của tenant | `conversations` |
| Message | Một tin nhắn trong conversation | `messages` |

Lưu ý: trong code hiện tại, module `customers` ở phía admin đang có nghĩa là "tenant đã mua", trùng tên với bảng `customers` (khách cuối). Đổi phía admin sang `tenants` (route, controller, UI) để hết nhầm lẫn.

## Phân quyền

### Admin (`/admin`)
- Quản lý tenant: tạo, sửa, tạm khóa, mở lại. Khi tạo tenant thì tạo luôn workspace, một AI agent mặc định và tài khoản `owner`.
- Quản lý gói thuê của tenant: tên gói, số AI agent tối đa, số kênh tối đa, ngày hết hạn, trạng thái (`trial`, `active`, `suspended`, `expired`).
- Xem số liệu tổng hợp theo tenant: số agent, số kênh, số conversation, số message theo tháng.
- Đặt lại mật khẩu cho `owner` của tenant.
- **Không** đọc nội dung conversation hay message của tenant. API admin chỉ trả số đếm, không trả nội dung.

### Tenant `owner` (`/app`)
- Quản lý AI agent (CRUD, giới hạn theo gói): tên, lời chào, câu fallback, câu chuyển người, bật/tắt LLM, model, persona/system prompt, rule (keyword → câu trả lời).
- Quản lý kênh: kết nối Page/OA, chọn AI agent phục vụ kênh đó, kiểm tra kết nối.
- Quản lý thành viên: thêm, xóa tài khoản `agent` (nhân viên).
- Xem toàn bộ conversation của tenant mình: lọc theo kênh, AI agent, trạng thái (`bot`, `human`, `off`), khoảng thời gian; tìm theo tên khách hoặc nội dung.
- Mở một conversation để xem đầy đủ lịch sử message, tiếp quản, gửi tin tay, trả lại cho bot.

### Tenant `agent` (nhân viên)
- Giống `owner` ở phần conversation (xem, tiếp quản, trả lời, trả lại bot).
- Không sửa AI agent, kênh hay thành viên.

### Cách ly dữ liệu
- Mọi truy vấn dữ liệu tenant đều lọc theo `workspace_id` lấy từ session, không lấy từ request body hay query.
- Có test chéo tenant: user của tenant A gọi mọi endpoint với id của tenant B phải nhận 404.
- Tenant bị `suspended` hoặc `expired`: không đăng nhập được, webhook vẫn lưu message vào nhưng bot không trả lời.

## Lưu conversation và message

Mỗi conversation phải lưu **đầy đủ** mọi message giữa khách với AI agent và nhân viên. Không xóa, không ghi đè nội dung.

Mỗi message lưu:
- `direction`: `in` (khách gửi) hoặc `out` (gửi cho khách).
- `sender_type`: `customer`, `bot`, `agent` (nhân viên) hoặc `system` (ví dụ "đã chuyển cho nhân viên").
- `sender_user_id`: id nhân viên khi `sender_type = 'agent'` (**cột mới**, hiện chưa có).
- `bot_id`: AI agent đã trả lời khi `sender_type = 'bot'` (**cột mới**), vì tenant có thể đổi agent của kênh về sau.
- `content`, `content_type`. Với ảnh/file: lưu URL và loại file vào `metadata`, chưa cần tải file về.
- `status` gửi: `queued`, `sent`, `delivered`, `read`, `failed`, `blocked_by_policy`, kèm `error_code` nếu lỗi. Tin gửi lỗi vẫn phải nằm trong lịch sử.
- `metadata` cho tin bot: `source` (`rule`, `llm`, `fallback`), id rule khớp, tên model, số token vào/ra, thời gian phản hồi (ms).
- `provider_message_id` để chống trùng khi webhook gửi lại.
- `created_at` theo thứ tự thời gian thật của sự kiện.

Conversation lưu thêm: AI agent đang phục vụ, người đang tiếp quản (`assigned_user_id`), thời điểm tin cuối, số message, và lịch sử chuyển trạng thái `bot` ↔ `human` (ai chuyển, lúc nào). Lịch sử này ghi thành message `system` trong conversation.

API xem message phân trang theo con trỏ (`?before=<message_id>`), mặc định 50 tin, sắp xếp cũ → mới khi hiển thị.

## Ràng buộc kỹ thuật

- Giữ kiến trúc trong `docs/PLAN-bv-agent-msg.md`: 1 process, outbox Postgres, không Redis, không microservice.
- Thay đổi schema bằng migration `drizzle-kit`, không sửa migration cũ. Dữ liệu hiện có phải còn nguyên sau khi migrate.
- Mỗi hạng mục có test: phân quyền theo role, cách ly tenant, giới hạn gói, lưu message đủ trường cho cả bốn loại người gửi.
- UI tiếng Việt. Code và tên biến tiếng Anh.

## Thứ tự làm

1. Đổi tên `customers` phía admin thành `tenants`; thêm bảng/cột gói thuê và trạng thái tenant.
2. Thêm `sender_user_id`, `bot_id` vào `messages`; ghi message `system` khi chuyển trạng thái; bổ sung metadata cho tin bot.
3. Cho phép một tenant có nhiều AI agent; mỗi kênh chọn một agent; chặn theo giới hạn gói.
4. Thêm quản lý thành viên (`owner` thêm/xóa `agent`) và kiểm tra quyền theo role ở từng endpoint.
5. Màn hình admin: danh sách tenant, gói, số liệu. Màn hình tenant: agent, kênh, thành viên, conversation có bộ lọc.
6. Test chéo tenant và test phân quyền chạy trong CI.

Làm xong mỗi bước thì chạy `pnpm test` và `pnpm build`, báo lại những gì đã đổi và những gì chưa làm.

## Ngoài phạm vi
Thanh toán online, hóa đơn, RAG/vector DB, workflow builder, broadcast, báo cáo nâng cao, đa ngôn ngữ.
