# LOCAL_PLAN — Chạy thử end-to-end trên máy

> Mục tiêu: khách nhắn Page → AI trả lời, chạy hoàn toàn trên máy bạn.
> Chưa cần App Review, chưa cần VPS. Xong trước, production sau (xem `PLAN.md`).

---

## 1. Định nghĩa "thông luồng" (DoD)

- Từ **tài khoản Facebook thứ 2** (đã thêm làm Tester) nhắn vào Page.
- Nhận câu trả lời AI trong **≤ 5 giây**.
- Tin nhắn của khách + câu trả lời được lưu vào SQLite.
- Không trả lời 2 lần cho cùng 1 tin (webhook retry).
- Tắt/bật server không mất dữ liệu, không lỗi chữ ký.

Không cần: giọng điệu hoàn hảo, handoff người thật, comment, nhiều Page.

---

## 2. Kết quả tìm hiểu: dùng repo nào?

| Lựa chọn | Local | Có AI sẵn | Công dựng | Kết luận |
|---|---|---|---|---|
| `fbsamples/messenger-platform-samples` (official, 1.7k★, còn cập nhật) | ✅ | ❌ | Thấp | **Chỉ để tham khảo** endpoint. Bản Python là 1 file snippet Graph v15, không phải app. |
| `enginebai/PyMessager` (606★) | ✅ | ❌ | Thấp | Wrapper API, dừng từ 2023, không có webhook/LLM. |
| `messenger4j` (Java) | ✅ | ❌ | — | Archived từ 2019. |
| `node-red-contrib-chatbot` | ✅ | ⚠️ | Trung bình | Kéo thả, hỗ trợ Messenger, nhưng flow khó version-control, cũ. |
| **n8n** (self-host Docker) | ✅ | ✅ | Thấp | Nhanh nhất nếu chấp nhận Docker ~1GB RAM và debug qua UI. Không hợp nếu muốn code sở hữu. |
| **Botpress** (self-host) | ✅ | ✅ | Cao | Cần Postgres + Redis, nặng cho 1 Page. |
| **Typebot** | ✅ | ⚠️ | Trung bình | Flow dạng form, không phải chat tự do; kênh Messenger hạn chế. |
| **Chatwoot** | ✅ | ❌ | Cao | Hộp thư đa kênh + người thật, không phải bot. |
| ManyChat / Chatfuel | ❌ SaaS | ✅ | Rất thấp | Không local, thuê bao, không sở hữu logic. |

**Quyết định:** tự viết FastAPI ~200 dòng. Lý do: yêu cầu chỉ 1 Page + 1 luồng, code tự viết ít hơn thời gian học/ vá n8n hay Botpress, và tái dùng đúng `PLAN.md` khi lên production. Dùng official sample để đối chiếu tên field, không copy code.

---

## 3. Kiến trúc local

```
                    ┌─────────────── CÙNG 1 LÕI ───────────────┐
Mock mode:  Browser /chat ──►│ handle_message(psid, text)        │
                             │   ├── faq.md + 10 tin gần nhất    │
                             │   ├── LLM API (hoặc Ollama)       │
                             │   └── lưu SQLite                  │
Real mode:  FB Page ──webhook──►│                              │──► Send API
            (qua tunnel)     └──────────────────────────────────┘
```

- Một biến `SEND_MODE=mock|meta` quyết định trả lời ra trình duyệt hay gọi Send API.
- `mock` cho phép test **toàn bộ logic AI ngay hôm nay**, không cần Meta.
- `meta` chỉ thay lớp vận chuyển, lõi giữ nguyên.

**Vì sao mock trước:** mọi thứ phía Meta (tạo app, quyền Page, tunnel, chế độ dev) đều là bước thủ công có thể tắc. Tách ra thì lỗi AI và lỗi tích hợp không trộn vào nhau.

---

## 4. Chuẩn bị phía bạn (~20 phút, làm song song)

- [ ] Tài khoản Facebook **thứ 2** để đóng vai khách (bắt buộc, chế độ dev chỉ nhắn được với người có role trong app).
- [ ] Quyền admin Page cần test.
- [ ] Tài khoản Meta for Developers.
- [ ] API key LLM (hoặc cài Ollama nếu muốn offline 100%).
- [ ] Cài `ngrok` hoặc `cloudflared`, Python 3.10+.

### Các bước trên App Dashboard

1. developers.facebook.com → **Create app** → loại **Business**.
2. **Add product → Messenger**.
3. Messenger → Settings → **Connect Page** → chọn Page → **Generate token**. Lưu Page token.
4. Copy **App ID**, **App Secret** (Settings → Basic).
5. **App Roles → Roles** → thêm tài khoản khách làm **Tester** → đăng nhập tài khoản đó accept lời mời.
6. Webhooks (làm ở L1, sau khi có tunnel): Callback URL `https://<tunnel>/webhook`, Verify Token tự đặt, subscribe `messages` + `messaging_postbacks`.
7. Nếu Page đang bật **Meta Business AI** → tắt, tránh 2 bot cùng trả lời.

---

## 5. Phases

### L0 — Lõi + mock UI (≈2 giờ) — ✅ xong
- [x] `app.py`: FastAPI, SQLite, `faq.md`, gọi LLM, timeout 10s, fallback.
- [x] `GET /` — trang chat tối giản: ô nhập, hiện hội thoại, gọi `POST /chat`.
- [x] `POST /chat` dùng chung `handle_message()` với webhook sau này.
- [x] `test_app.py`: 5 case (trong FAQ, ngoài FAQ, LLM lỗi, tin trùng, tin rỗng) — pass.
- **DoD:** mở `localhost:8000`, gõ "giá bao nhiêu" → nhận câu trả lời từ FAQ; dữ liệu nằm trong `chat.db`.

### L1 — Nối Messenger thật (≈1 giờ + chờ)
- [ ] Chạy `ngrok http 8000`, lấy HTTPS URL.
- [ ] Điền webhook + verify token trên dashboard → bấm **Verify and Save**.
- [ ] Subscribe `messages`, `messaging_postbacks`.
- [ ] `GET /webhook` trả `hub.challenge`; `POST /webhook` verify `X-Hub-Signature-256`.
- [ ] `POST /webhook` trả 200 ngay, xử lý LLM ở `BackgroundTasks`.
- [ ] Send API `POST /me/messages` với `messaging_type=RESPONSE`, typing indicator trước.
- **DoD:** tài khoản khách nhắn Page → nhận trả lời trong Messenger; log server hiện đúng `psid`.

### L2 — Chống lỗi cơ bản (≈30 phút)
- [ ] Dedupe theo `mid` (unique index), lock theo `psid`.
- [ ] Kiểm tra cửa sổ 24h trước khi gửi.
- [ ] Retry Send API 2 lần, lỗi thì log rõ.
- [ ] `GET /healthz`.
- **DoD:** gửi 3 tin liên tiếp thật nhanh → đúng 3 câu trả lời, không lặp, không lệch thứ tự.

---

## 6. Lệnh chạy dự kiến

```bash
python -m venv .venv && source .venv/bin/activate
pip install fastapi uvicorn httpx python-dotenv
cp .env.example .env          # điền token
uvicorn app:app --reload --port 8000

# tab khác
ngrok http 8000               # hoặc: cloudflared tunnel --url http://localhost:8000
```

`.env`:
```
SEND_MODE=mock
PAGE_TOKEN=
APP_SECRET=
VERIFY_TOKEN=doi-mot-chuoi-ngau-nhien
GRAPH_VERSION=v23.0
LLM_PROVIDER=openai        # openai | anthropic | ollama
LLM_API_KEY=
LLM_MODEL=
```

---

## 7. File dự kiến

```
app.py            # webhook + mock UI + handle_message + send
faq.md            # kiến thức của bạn
templates/chat.html
test_app.py
.env.example
chat.db           # tự sinh, không commit
```

---

## 8. Rủi ro & cách xử lý

| Rủi ro | Xử lý |
|---|---|
| Tunnel đổi URL mỗi lần chạy | ngrok free có static domain → dùng; hoặc cập nhật lại webhook (30 giây) |
| Không nhận được tin | Kiểm tra theo thứ tự: webhook verified → subscribed fields → Page đã connect → tài khoản có role Tester |
| Chế độ dev chỉ nhắn được với tester | Đúng thiết kế; thêm tài khoản khách vào App Roles |
| Webhook bị retry → trả lời lặp | Trả 200 trong <5s + dedupe `mid` |
| Token hết hạn / sai quyền | Dùng token Page lấy từ Messenger Settings, không dùng token user ngắn hạn |
| Máy sleep → tunnel chết | Chỉ ảnh hưởng lúc test; production dùng VPS |
| LLM chậm/bịa | Timeout 10s + prompt chỉ dùng FAQ + câu fallback cố định |
| 2 bot cùng trả lời | Tắt Meta Business AI trên Page |
| Lộ token khi demo | `.env` không commit, không log token |

---

## 9. Không làm ở bước này

App Review, Business Verification, VPS/Caddy, Telegram handoff, comment, WhatsApp, dashboard, vector DB. Tất cả nằm trong `PLAN.md` giai đoạn sau.

---

## 10. Thứ tự

`L0 → L1 → L2`, tổng **~3.5 giờ** (chưa tính thời gian chờ Meta). Nếu L1 tắc ở phía Meta, L0 vẫn demo được ngay.

---

## 11. Đã chốt

1. **LLM:** API key có sẵn → dùng chuẩn OpenAI-compatible (`LLM_BASE_URL` + `LLM_MODEL`), đổi provider chỉ bằng `.env`.
2. **Tunnel:** chưa cài → L1 sẽ cài `cloudflared` (không cần tài khoản) hoặc `ngrok`.
3. **Tài khoản test:** có Page, chưa có acc thứ 2 → dùng chính tài khoản admin Page làm người gửi (admin là app role, dev mode cho phép). Acc thứ 2 chỉ cần khi muốn giả lập khách hoàn toàn.
