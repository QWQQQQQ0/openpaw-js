"""OCR text recognition via EasyOCR — visual fallback only.

Used when UIA cannot find elements (custom-drawn UIs, games, remote desktop).
"""

from __future__ import annotations

import traceback
from typing import Any

try:
    import easyocr
    HAS_EASYOCR = True
except ImportError:
    HAS_EASYOCR = False


_reader: easyocr.Reader | None = None


def _get_reader() -> easyocr.Reader:
    global _reader
    if _reader is None:
        _reader = easyocr.Reader(['ch_sim', 'en'], gpu=False)
    return _reader


class OCREngine:
    """Wraps EasyOCR for text recognition from images."""

    def __init__(self) -> None:
        if not HAS_EASYOCR:
            raise RuntimeError(
                "EasyOCR is not installed. Run: pip install easyocr"
            )

    def warmup(self) -> None:
        """Pre-initialize EasyOCR reader — downloads models and loads PyTorch.

        Called at engine startup so the first OCR request doesn't block the
        bridge Mutex for minutes (which would pile up IPC calls and crash
        WebView2's resource-request handler).
        """
        _get_reader()

    def recognize(self, image_path: str = "", image_base64: str = "") -> dict[str, Any]:
        """Recognize text in an image. Provide either file path or base64 data URL.

        Returns list of {text, confidence, bbox} entries.
        """
        import tempfile
        import base64
        import os

        path = image_path
        # If base64 is provided, decode to temp file
        if not path and image_base64:
            try:
                # Strip data URL prefix if present
                if image_base64.startswith("data:"):
                    image_base64 = image_base64.split(",", 1)[1]
                data = base64.b64decode(image_base64)
                tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
                tmp.write(data)
                tmp.close()
                path = tmp.name
            except Exception:
                return {"texts": [], "error": "Failed to decode base64 image"}

        if not path:
            return {"texts": [], "error": "No image path or base64 provided"}

        try:
            reader = _get_reader()
            results = reader.readtext(path)

            texts: list[dict[str, Any]] = []
            for (bbox, text, confidence) in results:
                # bbox is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
                texts.append({
                    "text": text,
                    "confidence": round(confidence, 3),
                    "bbox": {
                        "left": int(bbox[0][0]),
                        "top": int(bbox[0][1]),
                        "right": int(bbox[2][0]),
                        "bottom": int(bbox[2][1]),
                    },
                })
        except Exception:
            return {"texts": [], "error": traceback.format_exc()}
        finally:
            # Clean up temp file
            if not image_path and path and os.path.exists(path):
                try:
                    os.unlink(path)
                except Exception:
                    pass

        return {"texts": texts, "count": len(texts)}
