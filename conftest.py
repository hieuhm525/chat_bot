"""Cô lập test khỏi .env và faq.md thật; phải chạy trước khi import app."""
import os
import tempfile
from pathlib import Path

_ROOT = Path(tempfile.mkdtemp(prefix="cskh-test-"))
(_ROOT / "faq.md").write_text(
    """# FAQ test

## Giờ mở cửa
- Thứ 2 – Thứ 7: 8:00 – 20:00

## Địa chỉ
123 Đường Ví Dụ, Quận 1

## Giao hàng
- Nội thành TP.HCM: 1–2 ngày

## Đổi trả
- Đổi trong 7 ngày
""",
    encoding="utf-8",
)

os.environ.update(
    APP_ENV="local",
    SEND_MODE="mock",
    ENABLE_MOCK_UI="true",
    ENABLE_SWEEPER="0",
    DB_PATH=str(_ROOT / "boot.db"),
    FAQ_PATH=str(_ROOT / "faq.md"),
    ADMIN_PASSWORD="",
    LLM_API_KEY="",
)
