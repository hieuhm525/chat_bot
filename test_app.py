import time

import pytest
from fastapi.testclient import TestClient

import app as bot

client = TestClient(bot.app)


@pytest.fixture(autouse=True)
def fresh(tmp_path, monkeypatch):
    bot.init_db(str(tmp_path / "test.db"))
    monkeypatch.setattr(bot, "_chat_completion", lambda messages: "Giá 100.000đ ạ.")
    yield


def test_reply_and_store():
    r = client.post("/chat", json={"text": "giá bao nhiêu"})
    assert r.status_code == 200
    assert r.json()["reply"] == "Giá 100.000đ ạ."
    with bot.db() as c:
        assert c.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 2


def test_duplicate_mid():
    assert bot.handle_message("p1", "chào", "mid-1")
    assert bot.handle_message("p1", "chào", "mid-1") is None
    with bot.db() as c:
        assert c.execute("SELECT COUNT(*) FROM messages WHERE psid='p1'").fetchone()[0] == 2


def test_llm_error_falls_back(monkeypatch):
    def boom(messages):
        raise RuntimeError("llm down")

    monkeypatch.setattr(bot, "_chat_completion", boom)
    assert bot.handle_message("p2", "chào") == bot.FALLBACK


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
