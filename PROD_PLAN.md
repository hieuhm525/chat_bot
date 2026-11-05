# PROD_PLAN — Nền tảng tối thiểu để lên production 1 Page

> Mục tiêu: giữ code nhỏ, nhưng chặn trước các lỗi khiến lên prod phải đập đi làm lại:
> mất tin, trả lời sai thứ tự, lộ webhook, mất dữ liệu, deploy không rollback được.
>
> Nguyên tắc: **1 Page, 1 process, SQLite WAL, VPS + Caddy + systemd**.
> Không Docker/K8s/Redis/Postgres/vector DB cho tới khi có số liệu chứng minh cần.
>
> Bản này đã qua 2 vòng review độc lập; các điểm sửa quan trọng nằm ở mục 8.

---

## 1. Quyết định khóa cứng

| Hạng mục | Chốt | Lý do | Khi nào đổi |
|---|---|---|---|
| Runtime | 1 uvicorn worker, Python 3.12 | `BackgroundTasks` + lock theo psid là in-process; nhiều worker sẽ phá dedupe/order | > vài chục tin/phút hoặc cần zero-downtime |
| DB | SQLite WAL | 0 vận hành, đủ cho 1 Page | > 100k tin hoặc nhiều instance |
| Message pipeline | DB là nguồn sự thật + trạng thái gửi | Chống mất tin khi crash/retry webhook | Khi cần queue phân tán |
| Deploy | VPS 1GB + Caddy + systemd | Ít moving part, debug bằng `journalctl` | Khi cần autoscale |
| Kiến thức | DB `faq`, `faq.md` chỉ seed lần đầu | Admin sửa là bot dùng ngay | Khi FAQ > 50KB hoặc > 100 mục |
| Kênh | Messenger text + handoff Telegram | Đúng phạm vi 1 Page | Khi mở comment/IG/WhatsApp |

**Không làm bây giờ:** Docker/K8s, Redis/Celery, Postgres, vector DB, multi-page,
dashboard analytics, comment/Instagram/WhatsApp, JSON prompt phức tạp, golden set chạy trong CI.

---

## 2. Các phase

### Phase 0 — Chốt nền (0.5 ngày)

- [ ] Chốt phạm vi: chỉ text; FAQ + LLM; fallback + pause + báo Telegram.
- [ ] Chốt env production, tách khỏi `.env` local:
  - `APP_ENV=local|production`
  - `SEND_MODE=mock|meta`, `ENABLE_MOCK_UI=true|false`
  - `PAGE_TOKEN`, `APP_SECRET`, `VERIFY_TOKEN`, `PAGE_ID` (optional)
  - `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `MAX_TOKENS`
  - `ADMIN_PASSWORD`, `SHOP_NAME`, `DB_PATH`, `FAQ_PATH`
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `OWNER_PSID`
- [ ] Viết “Definition of Ready for Prod” (mục 5) và thống nhất không deploy khi còn thiếu.
- [ ] Chọn domain, cài Caddy + systemd, tạo user `cskh`, thư mục `/opt/cskh-bot`, `/var/backups/cskh`.
- [ ] **Bắt đầu Phase 4 (privacy/App Review) ngay sau phase này**, không đợi code xong.
      Đây là đường dài 2–4 tuần; làm sớm để chờ duyệt song song với Phase 1–3.
- [ ] Pin dependency + CI tối thiểu: Python 3.12, `ruff`, `pytest`.

**Gate:** không còn biến môi trường nào được đọc rải rác mà chưa nằm trong danh sách trên.

---

### Phase 1 — Sửa lõi trước khi public (2.5–3 ngày)

Đây là phần đáng làm nhất. Làm xong phase này thì mọi thứ sau chỉ là vận hành.

#### 1.1. Config fail-fast
- [ ] Gom config về một chỗ (`config.py` hoặc đầu `app.py`), validate lúc start.
- [ ] `APP_ENV=production` bắt buộc: `SEND_MODE=meta`, `ENABLE_MOCK_UI=false`,
      có `PAGE_TOKEN`/`APP_SECRET`/`VERIFY_TOKEN`/`LLM_API_KEY`; thiếu → **dừng app**.
- [ ] `/webhook` **luôn yêu cầu chữ ký** nếu `APP_SECRET` tồn tại; nếu `APP_SECRET` rỗng
      thì endpoint trả 503, không bao giờ fail-open — kể cả `SEND_MODE=mock`.
- [ ] `SEND_MODE` chỉ nhận `mock|meta`; `MAX_TOKENS` parse lỗi phải báo rõ.
- [ ] `ADMIN_PASSWORD` nếu có phải ≥ 12 ký tự; rỗng = tắt admin.
- [ ] `.env` local `chmod 600`; production dùng `/etc/cskh-bot.env` root:root 600.

#### 1.2. DB migrations + trạng thái tin nhắn
- [ ] Migration runner dùng `PRAGMA user_version`; mỗi migration chạy trong 1 transaction,
      idempotent, chỉ additive. Migration 001 dựng schema hiện tại + bảng `app_meta`.
- [ ] Thêm vào `messages`:
  - `status`: `received | answered | sent | failed` (chỉ có nghĩa với `role='user'`)
  - `attempts`, `last_error`, `status_at`
- [ ] `app_meta(key, value)` để đánh dấu `faq_seeded=1`; tránh seed lại khi admin xoá hết FAQ.
- [ ] **Không** thêm `needs_human`/`last_bot_at`; dùng `conversations.bot_paused_until` là đủ.
- [ ] Tin bot dùng `mid = f"{mid}:bot"`; retry phải **tìm row cũ trước**, chỉ `INSERT` nếu chưa có.
      Nếu đã có thì dùng lại đúng câu đã lưu, không tạo row mới.
- [ ] Index: `CREATE INDEX idx_pending ON messages(status, status_at) WHERE role='user'`.
- [ ] PRAGMA mỗi connection: `busy_timeout=30000`, `synchronous=NORMAL`;
      `journal_mode=WAL` chỉ cần set một lần trong init.
- [ ] Trước khi migrate production: backup; migration lỗi thì app không start, không chạy nửa schema.

#### 1.3. Pipeline đúng thứ tự, không mất tin
- [ ] Lock theo `psid`: dùng **lock striping** (ví dụ 64 `threading.Lock`, chọn theo
      `crc32(psid) % 64`) thay vì map lock + cleanup. Ít code, không rò bộ nhớ.
- [ ] Luôn acquire lock **trước khi đọc status**; không giữ connection DB trong lúc gọi LLM.
- [ ] Dedupe phải phân biệt “đang xử lý” với “đã chết”:
  - `sent` → bỏ qua.
  - `received`/`answered` còn tươi (< 2 phút) → đang in-flight, bỏ qua (tránh gửi 2 lần).
  - `received`/`answered` quá 2 phút → sweeper xử lý lại.
  - `failed` và `attempts < 3` → retry; `attempts >= 3` → terminal, alert.
- [ ] Retry thông minh:
  - Đã có assistant row → **gửi lại đúng câu đã lưu**, không gọi LLM lần nữa.
  - Chưa có assistant row → mới gọi LLM để sinh câu trả lời.
- [ ] Thứ tự: insert user (`received`) → gọi LLM → insert assistant + set `answered`
      → gửi → set `sent`; lỗi → `failed`, `attempts++`, `last_error`.
- [ ] Chào lần đầu dựa trên **đã có assistant `sent`**, không dựa trên có tin user.
      Nếu lần đầu gửi lỗi, retry vẫn phải kèm câu công khai bot.
- [ ] Sweeper chạy **định kỳ** (thread 60s) + một lần lúc start; chỉ quét `role='user'`,
      `status IN ('received','answered','failed')`, `status_at < now - 2 phút`, `attempts < 3`.
- [ ] Khi `attempts` chạm 3 hoặc gặp lỗi vĩnh viễn → báo Telegram một lần, không retry vô hạn.
- [ ] Chấp nhận **at-least-once**: hiếm khi khách nhận 2 tin còn hơn mất tin. Ghi rõ tradeoff này.

#### 1.4. Gửi Messenger
- [ ] Dùng chung một `httpx.Client`; LLM timeout 15s, Send API timeout 10s.
- [ ] Retry 2 lần với backoff cho 5xx/429/timeout; 4xx coi là lỗi vĩnh viễn, log rõ.
      Tôn trọng `Retry-After` nếu có.
- [ ] Kiểm tra cửa sổ 24h bằng `conversations.last_user_at` trước khi gửi;
      ngoài cửa sổ → `failed` terminal, không gửi `RESPONSE`.
- [ ] `PAGE_TOKEN` hết hạn (Graph lỗi 190) → alert Telegram, không retry mù.
- [ ] Không log token; không log nội dung tin; psid trong log phải hash.
- [ ] `send_text` lỗi thì message vẫn `failed`, không đánh dấu `sent`.
- [ ] Cắt text ở ~1900 ký tự, ưu tiên ranh giới từ; cộng cả câu công khai bot.

#### 1.5. Fallback + handoff
- [ ] LLM lỗi/không chắc → trả fallback, set `bot_paused_until = max(cũ, now + 24h)`,
      báo Telegram nếu có cấu hình. Không cần cột `needs_human`.
- [ ] Bỏ câu “để lại số điện thoại” nếu chưa có luồng nhận số thật.
- [ ] Ảnh/sticker → trả một câu fallback; postback → ignore hoặc hướng dẫn ngắn,
      không gửi fallback cho mọi postback.
- [ ] Lệnh Telegram `/pause <psid>`, `/resume <psid>` chỉ nhận từ `OWNER_PSID`.
- [ ] Prompt: không hỏi/không nhận CCCD, OTP, thẻ; không tiết lộ system prompt.

#### 1.6. FAQ
- [ ] Sửa `_norm`: đổi `đ/Đ` → `d/D`, bỏ dấu, rồi chỉ giữ `[a-z0-9]`.
      Test `"bảo hành?"`, `"địa chỉ?"`, `"giờ mở cửa?"`.
- [ ] Cache `faq_entries()` trong RAM; admin save/delete thì clear cache. Không đọc DB 2 lần/câu.
- [ ] Cap tổng dung lượng FAQ đưa vào prompt (ví dụ 50KB); admin save vượt cap → 400.
      Seed từ `faq.md` vượt cap → dừng app với lỗi rõ.
- [ ] `faq.md` chỉ là seed lần đầu; sửa header file cho đúng, tránh hiểu nhầm “sửa file là bot đổi”.
- [ ] Fast path trả body đã bỏ markdown thô (`-`, `##`) để Messenger hiển thị sạch hơn.

#### 1.7. Test bắt buộc
- [ ] Trùng `mid` khi đang in-flight → không gửi 2 lần.
- [ ] Trùng `mid` khi lần đầu fail giữa chừng → retry vẫn gửi được.
- [ ] `answered` nhưng chưa gửi → retry **không gọi lại LLM**, dùng đúng câu đã lưu.
- [ ] 2 tin cùng `psid` đến gần nhau → trả lời đúng thứ tự, chào công khai 1 lần.
- [ ] `SEND_MODE=meta` thiếu secret → app không start; `/webhook` thiếu secret → 503.
- [ ] Send API fail → `failed`, retry được; quá 3 lần → terminal + alert.
- [ ] Ngoài 24h → không gửi.
- [ ] Sweeper xử lý `received/answered` quá hạn, dừng ở `attempts=3`.
- [ ] FAQ dấu câu, `đ`, false-positive cơ bản.
- [ ] Test không phụ thuộc `.env`/`faq.md` thật: `conftest.py` set env và temp FAQ trước khi import app.

**Gate:** tất cả test trên pass; không còn đường nào làm mất tin khi crash giữa chừng.

---

### Phase 2 — Bảo mật & vận hành (1 ngày)

#### 2.1. Admin
- [ ] Session token random (`secrets.token_urlsafe`), lưu server-side kèm hạn 7 ngày;
      restart thì logout. So sánh bằng `hmac.compare_digest`.
- [ ] Cookie `HttpOnly`, `SameSite=Lax`; `Secure` chỉ bật khi `APP_ENV=production`
      (local HTTP vẫn đăng nhập được).
- [ ] Rate limit `/admin/login` (ví dụ 5 lần/phút/IP) và delay khi sai.
- [ ] `ADMIN_PASSWORD` rỗng → `/admin` trả 404/503 rõ ràng, không chỉ “sai mật khẩu”.
- [ ] Production có thể chặn `/admin` theo IP ở Caddy.

#### 2.2. Bề mặt public
- [ ] Production tắt mock UI `/chat` (`ENABLE_MOCK_UI=false`); `DELETE /chat` cũng tắt theo.
- [ ] `ChatIn.text` max 1000 ký tự; nếu bật mock UI public thì `psid` phải do server sinh,
      không lấy từ client.
- [ ] Tắt `/docs`, `/redoc`, `/openapi.json` ở production.
- [ ] Caddy: TLS tự động, giới hạn body 1MB, security headers, access log.
      **Không log query string của `/webhook`** vì có `hub.verify_token`.
- [ ] Healthcheck `/healthz` phải `SELECT 1` được DB và trả `mode`, `pending`
      (không trả secret), không chỉ `os.path.exists`.
- [ ] `TrustedHostMiddleware`; uvicorn `--proxy-headers --forwarded-allow-ips=127.0.0.1`.
- [ ] Nếu có `PAGE_ID`, bỏ qua webhook entry của Page khác.
- [ ] Cost guard: tối đa ~10 tin/phút/psid (in-memory), vượt thì trả fallback 1 lần rồi im.

#### 2.3. Deploy & rollback
- [ ] `systemd` unit: `Restart=always`, `RestartSec=3`, `User=cskh`, `UMask=0077`,
      `EnvironmentFile=/etc/cskh-bot.env`, `NoNewPrivileges`, `PrivateTmp`,
      `ProtectSystem=strict`, `ProtectHome=true`,
      `ReadWritePaths=/opt/cskh-bot/data /var/backups/cskh`.
- [ ] `uvicorn app:app --host 127.0.0.1 --port 8000 --workers 1`.
- [ ] Backup hằng ngày:
      `sqlite3 data/chat.db ".backup '/var/backups/cskh/chat-$(date +%F).db'"`, giữ 7 bản.
- [ ] **Copy backup ra ngoài VPS** mỗi tuần (rsync/rclone); ổ VPS chết không mất hết.
- [ ] Restore đã diễn tập: stop service → copy DB → **xoá `chat.db-wal`/`chat.db-shm` cũ**
      → chown → start. Không xoá WAL/SHM dễ hỏng DB.
- [ ] Deploy: stop → backup → pull tag → cài deps → migrate → start → `curl /healthz`
      → fail thì rollback code + restore DB.
- [ ] Log ra stdout, xoay vòng bằng `journalctl`; không ghi file log tự quản.
- [ ] Alert Telegram: 3 lỗi gửi liên tiếp, `pending` quá N, token 190, hoặc service down.

**Gate:** deploy một lệnh, rollback một lệnh, backup restore đã thử, alert chạy thật.

---

### Phase 3 — Chất lượng trả lời & handoff (0.5–1 ngày)

- [ ] Bắt đầu bằng **fallback sentinel** đơn giản: reply rỗng hoặc đúng `FALLBACK` → pause.
      Chỉ nâng lên JSON `{reply, needs_human}` nếu thực tế cần phân biệt “không chắc” với “lỗi”.
- [ ] Bộ 15–20 câu hỏi vàng: trong FAQ, ngoài FAQ, giá, giao hàng, đổi trả, hỏi người thật.
- [ ] Chạy bộ vàng **thủ công** trước mỗi lần đổi prompt/FAQ; không chạy trong CI
      (tốn tiền LLM, flaky). Lưu kết quả vào `tests/golden/`.
- [ ] Admin có nút “thử bằng LLM” bên cạnh “thử FAQ” để biết câu nào sẽ fallback.
- [ ] Telegram handoff: gửi psid + link hội thoại; `/pause`, `/resume` chỉ owner.
- [ ] Chống trùng tiêu đề FAQ: giữ check-then-insert hiện tại là đủ với 1 admin;
      unique index trên title chuẩn hoá chỉ làm khi có nhiều admin.

**Gate:** 15–20 câu vàng đạt; câu ngoài FAQ không bịa giá/tồn kho; handoff đến trong ≤ 10s.

---

### Phase 4 — Meta & pháp lý (bắt đầu ngay sau Phase 0, chờ 2–4 tuần)

- [ ] `/privacy`, `/terms`, `/deletion` + data deletion callback (verify `signed_request`).
- [ ] Chính sách lưu dữ liệu: ví dụ xoá tin sau 90–180 ngày; cron/systemd timer xoá thật.
- [ ] App Review: `pages_messaging`, `pages_manage_metadata`; video demo 1 phút.
- [ ] Business Verification, app icon, mô tả.
- [ ] Tắt Meta Business AI trên Page; thêm tester; kiểm tra webhook fields.
- [ ] Rà chính sách 24h và tag `HUMAN_AGENT` chỉ dùng khi người thật trả lời.

**Gate:** app ở Live, tài khoản ngoài tester nhắn được, privacy/deletion hoạt động.

---

### Phase 5 — Go-live (0.5 ngày)

- [ ] Chạy toàn bộ checklist mục 5.
- [ ] Smoke test bằng tài khoản thứ 2: chào, FAQ, câu ngoài FAQ, ảnh, 2 tin liên tiếp.
- [ ] Kiểm tra log: không có token/nội dung tin; có psid hash/request id.
- [ ] Theo dõi 24h: tỷ lệ fallback, lỗi gửi, thời gian trả lời.
- [ ] Có người trực Page trong 24h đầu.

---

## 3. Thứ tự & ước lượng

| Phase | Việc | Ước lượng |
|---|---|---|
| 0 | Chốt phạm vi, env, hạ tầng, bắt đầu Meta | 0.5 ngày |
| 1 | Lõi: config, migration, pipeline, send, FAQ, test | 2.5–3 ngày |
| 2 | Admin, bảo mật, deploy, backup, alert | 1 ngày |
| 3 | Fallback sentinel, golden set, handoff | 0.5–1 ngày |
| 4 | Meta + privacy (chạy song song từ sau Phase 0) | 0.5 ngày + chờ duyệt |
| 5 | Go-live | 0.5 ngày |

**Tối thiểu để chạy được với khách thật:** Phase 0 + 1 + 2 (~4–4.5 ngày code + 2–4 tuần chờ Meta).
**Để ngủ ngon:** thêm Phase 3.
**Chưa cần:** mọi thứ trong mục “Không làm bây giờ”.

> Lưu ý timeline: App Review là đường dài nhất. Nộp sau Phase 0, đừng đợi code xong mới nộp.

---

## 4. File/thay đổi dự kiến

Giữ `app.py` cho tới khi vượt ~800 dòng; chưa tách module sớm.

```
app.py                 # routes, config validate, pipeline, sweeper
test_app.py            # test cũ + test mới
conftest.py            # env/temp DB/FAQ cô lập
migrations/001_init.sql
deploy/Caddyfile
deploy/cskh-bot.service
deploy/backup.sh
deploy/deploy.sh
PROD_PLAN.md
```

Khi `app.py` > 800 dòng hoặc test bắt đầu khó, tách theo lát cắt:
`config.py`, `db.py`, `bot.py`, `messenger.py`, `admin.py` — không tách trước.

---

## 5. Definition of Ready for Prod

Chỉ deploy khi tất cả đúng:

- [ ] `APP_ENV=production` + thiếu secret → app không start.
- [ ] `/webhook` không bao giờ fail-open; thiếu `APP_SECRET` → 503.
- [ ] Không còn khả năng mất tin khi crash giữa insert và gửi.
- [ ] Retry `answered` dùng lại câu đã lưu, không gọi LLM lần 2.
- [ ] 2 tin cùng psid không trả lời sai thứ tự; chào công khai 1 lần.
- [ ] Sweeper chạy định kỳ, dừng ở 3 lần, có alert.
- [ ] Send API retry + kiểm tra 24h + alert token 190.
- [ ] Fallback có pause + báo Telegram.
- [ ] FAQ dấu câu/`đ` đúng; prompt không vượt cap.
- [ ] Admin dùng session random, cookie Secure, login có rate limit.
- [ ] `/chat` tắt ở production; `/docs` tắt.
- [ ] Backup hằng ngày + off-VPS + đã thử restore (xoá WAL/SHM).
- [ ] Deploy và rollback đều một lệnh.
- [ ] `/healthz` kiểm tra DB thật.
- [ ] Log không có token/nội dung tin; psid đã hash.
- [ ] Privacy + deletion + retention job đã có.
- [ ] 15–20 câu vàng pass.
- [ ] Có người trực Page 24h đầu.

---

## 6. Rủi ro còn lại (chấp nhận có ý thức)

| Rủi ro | Chấp nhận vì | Khi nào xử lý |
|---|---|---|
| SQLite 1 writer | 1 Page, vài tin/phút | > 100k tin hoặc nhiều instance |
| `BackgroundTasks` không durable | Có DB status + sweeper | Khi cần queue thật |
| At-least-once có thể trùng tin | Ưu tiên không mất tin | Khi Messenger có idempotency key |
| Lock theo psid là in-process | 1 worker | Khi scale nhiều worker |
| Admin session mất khi restart | 1 admin | Khi có nhiều admin |
| Không có RAG/vector DB | FAQ < 50KB | Khi FAQ > 100 mục |
| VPS là single point | 1 Page, chi phí thấp | Khi cần SLA cao |
| App Review 2–4 tuần | Meta kiểm soát | Không tránh được; nộp sớm |

---

## 7. Việc làm ngay (theo thứ tự)

1. `chmod 600 .env`; tách env production; đặt `APP_ENV`.
2. Fail-closed `/webhook` + config fail-fast.
3. Migration `user_version` + `app_meta` + cột trạng thái + PRAGMA.
4. Lock striping theo `psid` + dedupe in-flight + sweeper định kỳ.
5. Retry gửi lại câu đã lưu + Send API retry + kiểm tra 24h.
6. Fallback → pause + Telegram + alert token 190.
7. Sửa `_norm` dấu câu/`đ` + test.
8. Admin session random + cookie Secure + rate limit.
9. Backup off-VPS + systemd + Caddy + deploy/rollback.
10. Nộp App Review/privacy ngay sau Phase 0.
11. Golden set 15–20 câu (thủ công).

---

## 8. Đã sửa sau review (vì sao khác bản đầu)

1. **Dedupe `received` tươi = in-flight, bỏ qua** — bản đầu nói “xử lý lại” sẽ gửi 2 tin
   khi webhook retry đúng lúc task đang gọi LLM.
2. **Retry `answered` phải gửi lại câu đã lưu**, không gọi lại LLM — tránh tốn tiền và
   tránh 2 câu trả lời khác nhau.
3. **`mid:bot` phải tìm row cũ trước khi insert** — nếu không, retry đụng UNIQUE và mất reply.
4. **Sweeper định kỳ + index `(status, status_at)`**, không chỉ chạy lúc start.
5. **Webhook fail-closed ở mọi mode**, không chỉ meta.
6. **Thêm PRAGMA `busy_timeout`/`synchronous=NORMAL`** và quy trình restore xoá WAL/SHM.
7. **App Review dời lên ngay sau Phase 0** vì là đường dài 2–4 tuần.
8. **Bỏ JSON prompt/golden set CI/`needs_human`** khỏi base; để P2 khi thật cần.
9. **Ước lượng Phase 1 tăng lên 2.5–3 ngày** vì test concurrency + retry khó hơn tưởng.
10. **Thêm alert token 190, backup off-VPS, cost guard theo psid** — vận hành thực tế.
