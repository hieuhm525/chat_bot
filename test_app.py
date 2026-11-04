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


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    bot.init_db(str(tmp_path / "test.db"))
    monkeypatch.setattr(bot, "_chat_completion", lambda messages: "Giá 100.000đ ạ.")
    yield


def test_reply_and_store():
    r = client.post("/chat", json={"text": "giá bao nhiêu"})
    assert r.status_code == 200
    reply = r.json()["reply"]
    assert reply.startswith(f"Dạ em là trợ lý tự động của {bot.SHOP_NAME}.")
    assert reply.endswith("Giá 100.000đ ạ.")
    with bot.db() as c:
        assert c.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2


def test_duplicate_mid():
    assert bot.handle_message("p1", "chào", "mid-1")
    assert bot.handle_message("p1", "chào", "mid-1") is None
    with bot.db() as c:
        assert c.execute("SELECT COUNT(*) FROM messages WHERE psid='p1'").fetchone()[0] == 2


def test_faq_match_skips_llm(monkeypatch):
    def boom(messages):
        raise AssertionError("không được gọi LLM khi FAQ đã khớp")

    monkeypatch.setattr(bot, "_chat_completion", boom)
    assert "1–2 ngày" in bot.handle_message("p9", "shop ơi giao hang may ngay")
    assert bot.faq_answer("chào shop") is None


def test_llm_error_falls_back(monkeypatch):
    def boom(messages):
        raise RuntimeError("llm down")

    monkeypatch.setattr(bot, "_chat_completion", boom)
    assert bot.handle_message("p2", "chào").endswith(bot.FALLBACK)


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
    sig = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    r = client.post("/webhook", content=body, headers={"x-hub-signature-256": sig})
    assert r.status_code == 200
    assert len(sent) == 1
    assert sent[0][0] == "psid-1"
    assert sent[0][1].endswith("Giá 100.000đ ạ.")


def test_webhook_bad_signature(monkeypatch):
    monkeypatch.setattr(bot, "APP_SECRET", "s3cret")
    body = json.dumps(payload()).encode()
    r = client.post("/webhook", content=body, headers={"x-hub-signature-256": "sha256=bad"})
    assert r.status_code == 403


def test_webhook_ignores_echo(monkeypatch):
    monkeypatch.setattr(bot, "APP_SECRET", "")
    sent = []
    monkeypatch.setattr(bot, "send_text", lambda psid, text: sent.append(text))
    body = json.dumps(payload(echo=True)).encode()
    assert client.post("/webhook", content=body).status_code == 200
    assert sent == []


def test_disclosure_only_on_first_message():
    first = bot.handle_message("p4", "chào")
    second = bot.handle_message("p4", "cảm ơn")
    assert first.startswith("Dạ em là trợ lý tự động")
    assert not second.startswith("Dạ em là trợ lý tự động")
