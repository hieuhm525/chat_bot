import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient

import app as bot

client = TestClient(bot.app)


def payload(text="chào", mid="m-1", echo=False):
    return {
        "object": "page",
        "entry": [
            {
                "id": "PAGE",
                "time": 0,
                "messaging": [
                    {
                        "sender": {"id": "psid-1"},
                        "recipient": {"id": "PAGE"},
                        "timestamp": 0,
                        "message": {"mid": mid, "text": text, "is_echo": echo},
                    }
                ],
            }
        ],
    }


def signed(body: bytes, secret: str = "s3cret") -> dict:
    return {
        "x-hub-signature-256": "sha256="
        + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    }


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    bot.init_db(str(tmp_path / "test.db"))
    monkeypatch.setattr(bot, "_chat_completion", lambda messages: "Giá 100.000đ ạ.")
    bot._SESSIONS.clear()
    bot._LOGIN_HITS.clear()
    client.cookies.clear()
    yield


def test_reply_and_store():
    r = client.post("/chat", json={"text": "giá bao nhiêu"})
    assert r.status_code == 200
    reply = r.json()["reply"]
    assert reply.startswith(f"Dạ em là trợ lý tự động của {bot.SHOP_NAME}.")
    assert reply.endswith("Giá 100.000đ ạ.")
    with bot.db() as c:
        assert c.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2
        assert (
            c.execute("SELECT status FROM messages WHERE role='user'").fetchone()[0]
            == "sent"
        )


def test_duplicate_mid_in_flight_is_ignored():
    assert bot.handle_message("p1", "chào", "mid-1")
    assert bot.handle_message("p1", "chào", "mid-1") is None
    with bot.db() as c:
        assert c.execute("SELECT COUNT(*) FROM messages WHERE psid='p1'").fetchone()[0] == 2


def test_stale_answered_reuses_stored_reply():
    first = bot.handle_message("p1", "giá bao nhiêu", "mid-2")

    def boom(messages):
        raise AssertionError("retry không được gọi lại LLM")

    with bot.db() as c:
        c.execute(
            "UPDATE messages SET status_at=? WHERE mid='mid-2'", (time.time() - 3600,)
        )
    import app

    original = app._chat_completion
    bot._chat_completion = boom
    try:
        assert bot.handle_message("p1", "giá bao nhiêu", "mid-2") == first
    finally:
        bot._chat_completion = original


def test_faq_match_skips_llm(monkeypatch):
    def boom(messages):
        raise AssertionError("không được gọi LLM khi FAQ đã khớp")

    monkeypatch.setattr(bot, "_chat_completion", boom)
    assert "1–2 ngày" in bot.handle_message("p9", "shop ơi giao hang may ngay")
    assert bot.faq_answer("chào shop") is None


def test_faq_normalizes_punctuation_and_d_stroke():
    assert "8:00" in bot.faq_answer("giờ mở cửa?")
    assert "123 Đường" in bot.faq_answer("địa chỉ?")
    assert bot.faq_answer("bảo hành?") is None


def test_llm_error_falls_back_and_pauses():
    def boom(messages):
        raise RuntimeError("llm down")

    bot._chat_completion = boom
    try:
        assert bot.handle_message("p2", "chào").endswith(bot.FALLBACK)
    finally:
        bot._chat_completion = lambda messages: "Giá 100.000đ ạ."
    assert bot.handle_message("p2", "còn đó không") is None


def test_paused_bot_stays_silent():
    bot.handle_message("p3", "chào")
    with bot.db() as c:
        c.execute(
            "UPDATE conversations SET bot_paused_until=? WHERE psid=?",
            (time.time() + 3600, "p3"),
        )
    assert bot.handle_message("p3", "còn đó không") is None


def test_empty_message_rejected():
    assert client.post("/chat", json={"text": "   "}).status_code == 400


def test_too_long_message_rejected():
    assert client.post("/chat", json={"text": "a" * 1001}).status_code == 422


def test_mock_ui_can_be_disabled(monkeypatch):
    monkeypatch.setattr(bot, "ENABLE_MOCK_UI", False)
    assert client.get("/").status_code == 404
    assert client.post("/chat", json={"text": "chào"}).status_code == 404


def test_send_failure_marks_failed_then_retry_sends_stored_reply(monkeypatch):
    calls = {"llm": 0}

    def llm(messages):
        calls["llm"] += 1
        return "Giá 100.000đ ạ."

    monkeypatch.setattr(bot, "_chat_completion", llm)

    def boom(psid, text):
        raise RuntimeError("send down")

    monkeypatch.setattr(bot, "send_text", boom)
    bot.process_message("p5", "giá bao nhiêu", "mid-5")
    with bot.db() as c:
        row = c.execute("SELECT status, attempts FROM messages WHERE mid='mid-5'").fetchone()
    assert (row["status"], row["attempts"]) == ("failed", 1)

    sent = []
    monkeypatch.setattr(bot, "send_text", lambda psid, text: sent.append(text))
    bot.process_message("p5", "giá bao nhiêu", "mid-5")
    with bot.db() as c:
        row = c.execute("SELECT status FROM messages WHERE mid='mid-5'").fetchone()
    assert row["status"] == "sent"
    assert len(sent) == 1
    assert calls["llm"] == 1  # retry dùng câu đã lưu, không gọi LLM lần 2


def test_sweeper_retries_stale_failed_message(monkeypatch):
    monkeypatch.setattr(
        bot, "send_text", lambda psid, text: (_ for _ in ()).throw(RuntimeError("down"))
    )
    bot.process_message("p6", "chào", "mid-6")
    with bot.db() as c:
        c.execute("UPDATE messages SET status_at=? WHERE mid='mid-6'", (time.time() - 300,))

    sent = []
    monkeypatch.setattr(bot, "send_text", lambda psid, text: sent.append(text))
    bot._sweep_once()
    with bot.db() as c:
        row = c.execute("SELECT status FROM messages WHERE mid='mid-6'").fetchone()
    assert row["status"] == "sent"
    assert len(sent) == 1


def test_same_psid_keeps_send_order(monkeypatch):
    import threading

    monkeypatch.setattr(bot, "_chat_completion", lambda messages: messages[-1]["content"])
    reached = threading.Event()
    release = threading.Event()
    sent = []

    def slow_send(psid, text):
        if text.endswith("one"):
            reached.set()
            release.wait(2)
        sent.append(text.rsplit(" ", 1)[-1])

    monkeypatch.setattr(bot, "send_text", slow_send)
    t1 = threading.Thread(target=bot.process_message, args=("p8", "one", "mid-8a"))
    t1.start()
    assert reached.wait(2)
    t2 = threading.Thread(target=bot.process_message, args=("p8", "two", "mid-8b"))
    t2.start()
    time.sleep(0.1)
    release.set()
    t1.join(2)
    t2.join(2)
    assert sent == ["one", "two"]


def test_outside_24h_window_is_terminal(monkeypatch):
    sent = []
    bot.handle_message("p7", "chào", "mid-7")
    with bot.db() as c:
        c.execute(
            "UPDATE conversations SET last_user_at=? WHERE psid='p7'",
            (time.time() - bot.WINDOW_24H - 60,),
        )
        c.execute(
            "UPDATE messages SET status_at=? WHERE mid='mid-7'", (time.time() - 300,)
        )
    monkeypatch.setattr(bot, "send_text", lambda psid, text: sent.append(text))
    bot.process_message("p7", "chào", "mid-7")
    with bot.db() as c:
        row = c.execute("SELECT status, attempts FROM messages WHERE mid='mid-7'").fetchone()
    assert sent == []
    assert (row["status"], row["attempts"]) == ("failed", bot.MAX_ATTEMPTS)


def test_validate_config_requires_production_secrets():
    good = dict(
        app_env="production",
        send_mode="meta",
        page_token="p",
        app_secret="s",
        verify_token="v",
        llm_api_key="k",
        admin_password="x" * 12,
        enable_mock_ui=False,
    )
    assert bot.validate_config(**good) is None
    with pytest.raises(RuntimeError, match="PAGE_TOKEN"):
        bot.validate_config(**{**good, "page_token": ""})
    with pytest.raises(RuntimeError, match="SEND_MODE=meta"):
        bot.validate_config(**{**good, "send_mode": "mock"})
    with pytest.raises(RuntimeError, match="ENABLE_MOCK_UI=false"):
        bot.validate_config(**{**good, "enable_mock_ui": True})
    with pytest.raises(RuntimeError):
        bot.validate_config(**{**good, "app_env": "staging"})


def test_webhook_fails_closed_without_secret(monkeypatch):
    monkeypatch.setattr(bot, "APP_SECRET", "")
    r = client.post("/webhook", content=json.dumps(payload()).encode())
    assert r.status_code == 503


def test_webhook_verify_ok(monkeypatch):
    monkeypatch.setattr(bot, "VERIFY_TOKEN", "secret")
    r = client.get(
        "/webhook",
        params={"hub.mode": "subscribe", "hub.verify_token": "secret", "hub.challenge": "123"},
    )
    assert r.status_code == 200
    assert r.text == "123"


def test_webhook_verify_bad(monkeypatch):
    monkeypatch.setattr(bot, "VERIFY_TOKEN", "secret")
    r = client.get(
        "/webhook",
        params={"hub.mode": "subscribe", "hub.verify_token": "sai", "hub.challenge": "1"},
    )
    assert r.status_code == 403


def test_webhook_signature_and_reply(monkeypatch):
    monkeypatch.setattr(bot, "APP_SECRET", "s3cret")
    sent = []
    monkeypatch.setattr(bot, "send_text", lambda psid, text: sent.append((psid, text)))
    body = json.dumps(payload()).encode()
    r = client.post("/webhook", content=body, headers=signed(body))
    assert r.status_code == 200
    assert len(sent) == 1
    assert sent[0][0] == "psid-1"
    assert sent[0][1].endswith("Giá 100.000đ ạ.")
    with bot.db() as c:
        row = c.execute("SELECT status FROM messages WHERE mid='m-1'").fetchone()
    assert row["status"] == "sent"


def test_webhook_bad_signature(monkeypatch):
    monkeypatch.setattr(bot, "APP_SECRET", "s3cret")
    body = json.dumps(payload()).encode()
    r = client.post("/webhook", content=body, headers={"x-hub-signature-256": "sha256=bad"})
    assert r.status_code == 403


def test_webhook_ignores_echo(monkeypatch):
    monkeypatch.setattr(bot, "APP_SECRET", "s3cret")
    sent = []
    monkeypatch.setattr(bot, "send_text", lambda psid, text: sent.append(text))
    body = json.dumps(payload(echo=True)).encode()
    assert client.post("/webhook", content=body, headers=signed(body)).status_code == 200
    assert sent == []


def test_disclosure_only_on_first_message():
    first = bot.handle_message("p4", "chào")
    second = bot.handle_message("p4", "cảm ơn")
    assert first.startswith("Dạ em là trợ lý tự động")
    assert not second.startswith("Dạ em là trợ lý tự động")


def test_healthz_checks_db():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["mode"] == "mock"
    assert isinstance(r.json()["pending"], int)


def test_admin_requires_login(monkeypatch):
    monkeypatch.setattr(bot, "ADMIN_PASSWORD", "pw")
    assert client.get("/admin/faq").status_code == 401
    assert client.post("/admin/faq", json={"title": "Giờ mở cửa", "body": "x"}).status_code == 401


def test_admin_disabled_returns_503():
    assert client.get("/admin/faq").status_code == 503
    assert client.post("/admin/login", json={"password": "x"}).status_code == 503


def test_admin_session_and_crud(monkeypatch):
    monkeypatch.setattr(bot, "ADMIN_PASSWORD", "pw")
    assert client.post("/admin/login", json={"password": "sai"}).status_code == 401
    assert client.post("/admin/login", json={"password": "pw"}).status_code == 200

    r = client.post("/admin/faq", json={"title": "Mã giảm giá", "body": "SALE50"})
    assert r.status_code == 200
    assert "SALE50" in bot.faq_answer("mã giảm giá là gì")

    fid = r.json()["id"]
    assert client.post(
        "/admin/faq", json={"id": fid, "title": "Mã giảm giá", "body": "SALE70"}
    ).status_code == 200
    assert "SALE70" in bot.faq_answer("mã giảm giá là gì")

    assert client.delete(f"/admin/faq/{fid}").status_code == 200
    assert bot.faq_answer("mã giảm giá là gì") is None

    assert client.post("/admin/logout").status_code == 200
    assert client.get("/admin/faq").status_code == 401


def test_admin_login_rate_limited(monkeypatch):
    monkeypatch.setattr(bot, "ADMIN_PASSWORD", "pw")
    for _ in range(5):
        assert client.post("/admin/login", json={"password": "sai"}).status_code == 401
    assert client.post("/admin/login", json={"password": "pw"}).status_code == 429


def test_admin_validation(monkeypatch):
    monkeypatch.setattr(bot, "ADMIN_PASSWORD", "pw")
    client.post("/admin/login", json={"password": "pw"})
    assert client.post("/admin/faq", json={"title": "Giá", "body": "x"}).status_code == 400
    assert client.post("/admin/faq", json={"title": "Giờ mở cửa", "body": ""}).status_code == 400
    assert client.post(
        "/admin/faq", json={"title": "Giờ mở cửa", "body": "8:00"}
    ).status_code == 400  # trùng tiêu đề đã seed
