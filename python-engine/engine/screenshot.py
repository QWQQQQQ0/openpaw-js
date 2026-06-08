"""Fast screenshot capture via mss (replaces GDI BMP).

Returns PNG base64 — smaller and faster than the old BMP approach.
"""

from __future__ import annotations

import base64
import io
import traceback
from typing import Any

try:
    import mss
    from PIL import Image
    HAS_MSS = True
except ImportError:
    HAS_MSS = False


class ScreenshotEngine:
    """Wraps mss for fast screen capture."""

    def __init__(self) -> None:
        if not HAS_MSS:
            raise RuntimeError(
                "mss and Pillow are required. Run: pip install mss Pillow"
            )
        self._sct = mss.mss()

    def full(self) -> dict[str, Any]:
        """Capture the entire primary monitor."""
        try:
            monitor = self._sct.monitors[1]  # primary
            img = self._sct.grab(monitor)
            pil = Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX")
            buf = io.BytesIO()
            pil.save(buf, format="PNG", optimize=True)
            data_url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
            return {
                "image_data": data_url,
                "format": "png",
                "width": pil.width,
                "height": pil.height,
            }
        except Exception:
            return {"image_data": "", "error": traceback.format_exc()}

    def region(self, left: int, top: int, width: int, height: int) -> dict[str, Any]:
        """Capture a specific screen region."""
        try:
            region = {"left": left, "top": top, "width": width, "height": height}
            img = self._sct.grab(region)
            pil = Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX")
            buf = io.BytesIO()
            pil.save(buf, format="PNG", optimize=True)
            data_url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
            return {
                "image_data": data_url,
                "format": "png",
                "width": pil.width,
                "height": pil.height,
                "region": {"left": left, "top": top, "width": width, "height": height},
            }
        except Exception:
            return {"image_data": "", "error": traceback.format_exc()}

    def all_monitors(self) -> dict[str, Any]:
        """Return monitor layout info."""
        monitors = []
        for i, m in enumerate(self._sct.monitors):
            monitors.append({
                "index": i,
                "left": m["left"], "top": m["top"],
                "width": m["width"], "height": m["height"],
            })
        return {"monitors": monitors}
