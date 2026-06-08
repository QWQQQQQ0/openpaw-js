"""JSON Line protocol for stdin/stdout communication with the Rust sidecar bridge."""

import sys
import json
from typing import Any

# Force UTF-8 on Windows (avoids GBK encoding errors from UIA text)
# stdin/stdout/stderr must all use UTF-8 to match the Rust bridge
if sys.platform == "win32":
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def read_request() -> dict[str, Any] | None:
    """Read a single JSON line from stdin. Returns None on EOF."""
    line = sys.stdin.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return None
    return json.loads(line)


def write_response(response: dict[str, Any]) -> None:
    """Write a single JSON line to stdout and flush (UTF-8)."""
    data = json.dumps(response, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(data.encode("utf-8"))
    sys.stdout.buffer.flush()


def ok(req_id: str, data: Any = None) -> dict[str, Any]:
    return {"id": req_id, "ok": True, "data": data}


def fail(req_id: str, error: str) -> dict[str, Any]:
    return {"id": req_id, "ok": False, "error": error}
