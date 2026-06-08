"""OpenPaw Automation Engine — Python sidecar.

Reads JSON Line requests from stdin, dispatches to tool handlers,
writes JSON Line responses to stdout. Runs until stdin closes.

Protocol:
  Request:  {"id":"...","tool":"...","params":{...}}
  Response: {"id":"...","ok":true,"data":{...}}
            {"id":"...","ok":false,"error":"..."}
"""

from __future__ import annotations

import sys
import traceback
from typing import Any, Callable

from protocol import read_request, write_response, ok, fail
from engine.desktop_uia import UIAEngine
from engine.browser import BrowserEngine
from engine.screenshot import ScreenshotEngine
from engine.ocr import OCREngine
from engine.office import WordGenerator, ExcelGenerator, PptGenerator
from engine.global_listener import get_listener

# ── Tool registry ──
# Each handler receives (params: dict) -> dict (the data field of the response)

_uia: UIAEngine | None = None
_browser: BrowserEngine | None = None
_screenshot: ScreenshotEngine | None = None
_ocr: OCREngine | None = None
_word_gen: WordGenerator | None = None
_excel_gen: ExcelGenerator | None = None
_ppt_gen: PptGenerator | None = None


def _get_uia() -> UIAEngine:
    global _uia
    if _uia is None:
        _uia = UIAEngine()
    return _uia


def _get_browser() -> BrowserEngine:
    global _browser
    if _browser is None:
        _browser = BrowserEngine()
    return _browser


def _get_screenshot() -> ScreenshotEngine:
    global _screenshot
    if _screenshot is None:
        _screenshot = ScreenshotEngine()
    return _screenshot


def _get_ocr() -> OCREngine:
    global _ocr
    if _ocr is None:
        _ocr = OCREngine()
    return _ocr


def _get_word_gen() -> WordGenerator:
    global _word_gen
    if _word_gen is None:
        _word_gen = WordGenerator()
    return _word_gen


def _get_excel_gen() -> ExcelGenerator:
    global _excel_gen
    if _excel_gen is None:
        _excel_gen = ExcelGenerator()
    return _excel_gen


def _get_ppt_gen() -> PptGenerator:
    global _ppt_gen
    if _ppt_gen is None:
        _ppt_gen = PptGenerator()
    return _ppt_gen


def _handle_uia_get_interactive(params: dict) -> dict[str, Any]:
    hwnd = params.get("window_hwnd")
    return _get_uia().get_interactive_nodes(
        window_hwnd=hwnd,
        roles=params.get("roles"),
        name_keyword=params.get("name_keyword"),
        onscreen_only=params.get("onscreen_only", False),
        limit=params.get("limit"),
    )


def _handle_uia_click(params: dict) -> dict[str, Any]:
    return _get_uia().click(
        role=params["role"],
        name=params.get("name"),
        window_hwnd=params.get("window_hwnd"),
    )


def _handle_uia_type(params: dict) -> dict[str, Any]:
    return _get_uia().type_text(
        text=params["text"],
        role=params.get("role"),
        name=params.get("name"),
        window_hwnd=params.get("window_hwnd"),
    )


def _handle_uia_find(params: dict) -> dict[str, Any]:
    return _get_uia().find_element(
        role=params["role"],
        name=params.get("name"),
        window_hwnd=params.get("window_hwnd"),
    )


def _handle_uia_get_property(params: dict) -> dict[str, Any]:
    return _get_uia().get_property(
        role=params["role"],
        name=params.get("name"),
        prop=params["property"],
        window_hwnd=params.get("window_hwnd"),
    )


def _handle_uia_fingerprint(params: dict) -> dict[str, Any]:
    return _get_uia().fingerprint(window_hwnd=params.get("window_hwnd"))


def _handle_uia_find_at_point(params: dict) -> dict[str, Any]:
    return _get_uia().find_at_point(
        x=params["x"],
        y=params["y"],
        hwnd=params.get("hwnd"),
    )


# ── Browser (Playwright) handlers ──

def _handle_web_launch(params: dict) -> dict[str, Any]:
    return _get_browser().launch(
        headless=params.get("headless", True),
        channel=params.get("channel", ""),
    )


def _handle_web_navigate(params: dict) -> dict[str, Any]:
    return _get_browser().navigate(url=params["url"])


def _handle_web_get_interactive(_params: dict) -> dict[str, Any]:
    return _get_browser().get_interactive_nodes()


def _handle_web_click_selector(params: dict) -> dict[str, Any]:
    return _get_browser().click_selector(selector=params["selector"])


def _handle_web_click_role(params: dict) -> dict[str, Any]:
    return _get_browser().click_role(
        role=params["role"],
        name=params.get("name"),
    )


def _handle_web_fill(params: dict) -> dict[str, Any]:
    return _get_browser().fill(selector=params["selector"], text=params["text"])


def _handle_web_type(params: dict) -> dict[str, Any]:
    return _get_browser().type_text(text=params["text"])


def _handle_web_scroll(params: dict) -> dict[str, Any]:
    return _get_browser().scroll(delta_y=params.get("delta_y", 300))


def _handle_web_close(_params: dict) -> dict[str, Any]:
    return _get_browser().close()


def _handle_web_start_recording(_params: dict) -> dict[str, Any]:
    return _get_browser().start_recording()


def _handle_web_stop_recording(_params: dict) -> dict[str, Any]:
    return _get_browser().stop_recording()


def _handle_web_get_recorded_events(_params: dict) -> dict[str, Any]:
    return _get_browser().get_recorded_events()


# ── Screenshot (mss) handlers ──

def _handle_screenshot_full(_params: dict) -> dict[str, Any]:
    return _get_screenshot().full()


def _handle_screenshot_region(params: dict) -> dict[str, Any]:
    return _get_screenshot().region(
        left=params["left"],
        top=params["top"],
        width=params["width"],
        height=params["height"],
    )


def _handle_screenshot_monitors(_params: dict) -> dict[str, Any]:
    return _get_screenshot().all_monitors()


# ── OCR (PaddleOCR) handlers ──

def _handle_ocr_recognize(params: dict) -> dict[str, Any]:
    return _get_ocr().recognize(
        image_path=params.get("image_path", ""),
        image_base64=params.get("image_base64", ""),
    )


# ── Global input listener (pynput) handlers ──

def _handle_global_listener_start(params: dict) -> dict[str, Any]:
    listener = get_listener()
    listener.start(parent_pid=params.get("parent_pid", 0))
    return {"running": listener.is_running}


def _handle_global_listener_stop(_params: dict) -> dict[str, Any]:
    listener = get_listener()
    listener.stop()
    return {"running": listener.is_running}


def _handle_global_listener_poll(params: dict) -> dict[str, Any]:
    listener = get_listener()
    max_events = params.get("max_events", 100)
    events = listener.poll(max_events=max_events)
    return {"events": events, "count": len(events)}


# ── Office document generators ──

def _handle_word_generate(params: dict) -> dict[str, Any]:
    import base64
    gen = _get_word_gen()
    docx_bytes = gen.generate(
        title=params["title"],
        content=params.get("content", ""),
        subtitle=params.get("subtitle"),
        author=params.get("author"),
    )
    save_path = params.get("save_path")
    if save_path:
        with open(save_path, "wb") as f:
            f.write(docx_bytes)
        return {"saved": True, "path": save_path, "size": len(docx_bytes)}
    return {"saved": False, "data": base64.b64encode(docx_bytes).decode("utf-8"), "size": len(docx_bytes)}


def _handle_excel_generate(params: dict) -> dict[str, Any]:
    import base64
    gen = _get_excel_gen()
    xlsx_bytes = gen.generate(
        title=params["title"],
        sheets=params.get("sheets", []),
        author=params.get("author"),
    )
    save_path = params.get("save_path")
    if save_path:
        with open(save_path, "wb") as f:
            f.write(xlsx_bytes)
        return {"saved": True, "path": save_path, "size": len(xlsx_bytes)}
    return {"saved": False, "data": base64.b64encode(xlsx_bytes).decode("utf-8"), "size": len(xlsx_bytes)}


def _handle_ppt_generate(params: dict) -> dict[str, Any]:
    import base64
    gen = _get_ppt_gen()

    # Support both structured slides and markdown content
    if "markdown" in params:
        pptx_bytes = gen.generate_from_markdown(
            title=params["title"],
            markdown=params["markdown"],
            author=params.get("author"),
        )
    else:
        pptx_bytes = gen.generate(
            title=params["title"],
            slides=params.get("slides", []),
            author=params.get("author"),
        )

    save_path = params.get("save_path")
    if save_path:
        with open(save_path, "wb") as f:
            f.write(pptx_bytes)
        return {"saved": True, "path": save_path, "size": len(pptx_bytes)}
    return {"saved": False, "data": base64.b64encode(pptx_bytes).decode("utf-8"), "size": len(pptx_bytes)}


def _handle_exec_python(params: dict) -> dict:
    """Execute arbitrary Python code in a restricted sandbox.

    Allowed modules (SAFE_MODULES):
      json, math, datetime, re, collections, itertools, random, statistics,
      uuid, base64, hashlib, textwrap, string, typing, enum, functools,
      operator, bisect, decimal, fractions, copy.

    The value of a variable named ``result`` in the executed scope is
    returned as the ``result`` field.
    """
    code = params.get("code", "")
    timeout_sec = params.get("timeout_sec", 30)
    input_vars = params.get("params", {})

    import io
    import sys
    import traceback
    import time

    old_stdout, old_stderr = sys.stdout, sys.stderr
    captured_stdout, captured_stderr = io.StringIO(), io.StringIO()
    sys.stdout, sys.stderr = captured_stdout, captured_stderr

    SAFE_MODULES = {
        "json", "math", "datetime", "re", "collections", "itertools",
        "random", "statistics", "uuid", "base64", "hashlib", "textwrap",
        "string", "typing", "enum", "functools", "operator", "bisect",
        "decimal", "fractions", "copy",
    }

    def safe_import(name, *args):
        if name not in SAFE_MODULES:
            raise ImportError(f"Module '{name}' is not allowed")
        return __import__(name, *args)

    safe_globals = {
        "__builtins__": {
            "print": print,
            "len": len,
            "range": range,
            "int": int,
            "float": float,
            "str": str,
            "bool": bool,
            "list": list,
            "dict": dict,
            "tuple": tuple,
            "set": set,
            "sorted": sorted,
            "reversed": reversed,
            "enumerate": enumerate,
            "zip": zip,
            "map": map,
            "filter": filter,
            "any": any,
            "all": all,
            "min": min,
            "max": max,
            "sum": sum,
            "abs": abs,
            "round": round,
            "isinstance": isinstance,
            "type": type,
            "hasattr": hasattr,
            "getattr": getattr,
            "setattr": setattr,
            "ValueError": ValueError,
            "TypeError": TypeError,
            "KeyError": KeyError,
            "IndexError": IndexError,
            "Exception": Exception,
            "StopIteration": StopIteration,
            "__import__": safe_import,
        }
    }
    safe_globals.update(input_vars)

    result_value, error_str = None, None
    start = time.time()

    try:
        compiled = compile(code, "<sandbox>", "exec", flags=0)
        exec(compiled, safe_globals)
        result_value = safe_globals.get("result", None)
    except Exception:
        error_str = traceback.format_exc()
    finally:
        sys.stdout, sys.stderr = old_stdout, old_stderr

    duration_ms = int((time.time() - start) * 1000)
    output = captured_stdout.getvalue()
    err_output = captured_stderr.getvalue()

    return {
        "success": error_str is None,
        "output": output,
        "error": error_str or err_output or "",
        "result": result_value,
        "duration_ms": duration_ms,
        "truncated": len(output) > 100000,
    }


TOOL_MAP: dict[str, Callable[[dict], dict[str, Any]]] = {
    "uia_get_interactive": _handle_uia_get_interactive,
    "uia_click":           _handle_uia_click,
    "uia_type":            _handle_uia_type,
    "uia_find":            _handle_uia_find,
    "uia_get_property":    _handle_uia_get_property,
    "uia_fingerprint":     _handle_uia_fingerprint,
    "uia_find_at_point":   _handle_uia_find_at_point,
    # Browser
    "web_launch":          _handle_web_launch,
    "web_navigate":        _handle_web_navigate,
    "web_get_interactive": _handle_web_get_interactive,
    "web_click_selector":  _handle_web_click_selector,
    "web_click_role":      _handle_web_click_role,
    "web_fill":            _handle_web_fill,
    "web_type":            _handle_web_type,
    "web_scroll":          _handle_web_scroll,
    "web_close":           _handle_web_close,
    "web_start_recording":        _handle_web_start_recording,
    "web_stop_recording":         _handle_web_stop_recording,
    "web_get_recorded_events":    _handle_web_get_recorded_events,
    # Screenshot (mss)
    "screenshot_full":     _handle_screenshot_full,
    "screenshot_region":   _handle_screenshot_region,
    "screenshot_monitors": _handle_screenshot_monitors,
    # Global input listener (pynput)
    "global_listener_start": _handle_global_listener_start,
    "global_listener_stop":  _handle_global_listener_stop,
    "global_listener_poll":  _handle_global_listener_poll,
    # OCR (PaddleOCR)
    "ocr_recognize":       _handle_ocr_recognize,
    # Office document generators
    "word_generate":       _handle_word_generate,
    "excel_generate":      _handle_excel_generate,
    "ppt_generate":        _handle_ppt_generate,
    # Code sandbox (exec_python)
    "exec_python":         _handle_exec_python,
}


def main() -> None:
    """Run the stdin/stdout event loop."""
    # Warmup: pre-initialize EasyOCR so the first OCR request doesn't
    # block the bridge Mutex for minutes (downloading ~200MB models +
    # loading PyTorch). A blocked Mutex piles up Tauri IPC calls and
    # triggers a WebView2 resource-request handler panic (0xc0000409).
    try:
        import sys
        sys.stderr.write("[python-engine] Warming up EasyOCR (first run downloads ~200MB models)...\n")
        sys.stderr.flush()
        _get_ocr().warmup()
        sys.stderr.write("[python-engine] EasyOCR warmup complete.\n")
        sys.stderr.flush()
    except Exception as e:
        sys.stderr.write(f"[python-engine] EasyOCR warmup failed (OCR unavailable): {e}\n")
        sys.stderr.flush()

    # Signal ready (Rust side reads this line to know the engine is alive)
    write_response({"id": "__ready__", "ok": True, "data": {"version": "0.1.0"}})

    while True:
        try:
            req = read_request()
        except Exception as e:
            write_response(fail("__parse__", f"JSON parse error: {e}"))
            continue

        if req is None:
            break  # stdin closed, shut down

        req_id = req.get("id", "")
        tool = req.get("tool", "")
        params = req.get("params", {})

        handler = TOOL_MAP.get(tool)
        if handler is None:
            write_response(fail(req_id, f"Unknown tool: {tool}"))
            continue

        try:
            data = handler(params)
            write_response(ok(req_id, data))
        except Exception as e:
            write_response(fail(req_id, traceback.format_exc()))


if __name__ == "__main__":
    main()
