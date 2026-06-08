"""Browser automation via Playwright.

Provides: launch, navigate, DOM + Accessibility Tree extraction,
click by selector/role, fill/type text, scroll, close,
and DOM event recording for automation recording.
"""

from __future__ import annotations

import time
import traceback
from typing import Any

try:
    from playwright.sync_api import sync_playwright, Page, Browser as PWBrowser
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

# JS code injected into the page to capture DOM events with semantic info
_RECORD_LISTENERS_JS = """() => {
    if (window.__openpaw_recording) return;  // already injected
    window.__openpaw_recording = true;
    window.__openpaw_event_buffer = [];

    function getElementInfo(el) {
        if (!el || el === document.documentElement || el === document.body) return null;
        const r = el.getBoundingClientRect();

        // Build best selector (priority: id > aria-label > text > css)
        let selector = '';
        if (el.id) {
            selector = '#' + CSS.escape(el.id);
        } else if (el.getAttribute('aria-label')) {
            selector = el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(el.getAttribute('aria-label')) + '"]';
        } else if (el.className && typeof el.className === 'string') {
            const classes = el.className.trim().split(/\\s+/).filter(c => c).map(c => '.' + CSS.escape(c)).join('');
            selector = el.tagName.toLowerCase() + classes;
        }

        // Get accessible name
        const name = el.getAttribute('aria-label')
            || el.getAttribute('title')
            || el.getAttribute('placeholder')
            || el.getAttribute('alt')
            || (el.textContent || '').trim().substring(0, 80);

        // Get ARIA role
        const role = el.getAttribute('role')
            || (el.tagName === 'BUTTON' ? 'button' : '')
            || (el.tagName === 'A' ? 'link' : '')
            || (el.tagName === 'INPUT' ? (el.type || 'textbox') : '')
            || (el.tagName === 'SELECT' ? 'combobox' : '')
            || (el.tagName === 'TEXTAREA' ? 'textbox' : '');

        return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').trim().substring(0, 120),
            selector: selector,
            role: role,
            name: name,
            bounds: {
                x: Math.round(r.left), y: Math.round(r.top),
                width: Math.round(r.width), height: Math.round(r.height)
            }
        };
    }

    function pushEvent(type, e, extra) {
        const info = e ? getElementInfo(e.target) : null;
        // 使用 Date.now() 获取当前 Unix 毫秒时间戳，和 Rust 的 SystemTime::now() 一致
        const eventData = {
            type: type,
            timestamp: Date.now(),
            x: e ? e.clientX : 0,
            y: e ? e.clientY : 0,
            element: info,
            key: extra && extra.key ? extra.key : undefined,
            modifiers: extra && extra.modifiers ? extra.modifiers : undefined,
            value: extra && extra.value !== undefined ? extra.value : undefined,
            url: location.href,
            title: document.title,
        };
        // Push to Python if exposed (real-time path)
        if (window.__openpaw_push_event) {
            try {
                window.__openpaw_push_event(eventData);
            } catch(e) {
                console.warn('[OpenPaw] __openpaw_push_event call failed, buffering:', e);
                window.__openpaw_event_buffer.push(eventData);
            }
        } else {
            // Buffer as fallback when push function not available
            window.__openpaw_event_buffer.push(eventData);
        }
    }

    document.addEventListener('click', function(e) { pushEvent('click', e); }, true);
    document.addEventListener('dblclick', function(e) { pushEvent('dblclick', e); }, true);
    document.addEventListener('contextmenu', function(e) { pushEvent('contextmenu', e); }, true);
    document.addEventListener('keydown', function(e) {
        const mods = [];
        if (e.ctrlKey) mods.push('Ctrl');
        if (e.altKey) mods.push('Alt');
        if (e.shiftKey) mods.push('Shift');
        if (e.metaKey) mods.push('Meta');
        pushEvent('keydown', e, { key: e.key, modifiers: mods });
    }, true);
    document.addEventListener('input', function(e) {
        pushEvent('input', e, { value: e.target.value });
    }, true);
}"""

_REMOVE_LISTENERS_JS = """() => {
    window.__openpaw_recording = false;
    window.__openpaw_event_buffer = [];
}"""


class BrowserEngine:
    """Wraps Playwright for web automation."""

    def __init__(self) -> None:
        if not HAS_PLAYWRIGHT:
            raise RuntimeError(
                "Playwright is not installed. Run: pip install playwright"
            )
        self._playwright = None
        self._browser: PWBrowser | None = None
        self._page: Page | None = None
        # Recording state
        self._recording_active: bool = False
        self._recorded_events: list[dict[str, Any]] = []
        self._event_handler_ref: Any = None  # reference to exposed function

    def launch(self, headless: bool = True, channel: str = "") -> dict[str, Any]:
        """Launch browser. Uses system Edge/Chrome by default (no download needed).

        Tries channels in order: msedge → chrome → chromium (bundled fallback).
        """
        try:
            self._playwright = sync_playwright().start()

            # Try system browsers first (no download required)
            channels = [c for c in [channel, "msedge", "chrome", ""] if c is not None]
            if "" in channels:
                channels.remove("")
                channels.append("")  # bundled chromium as last resort

            last_error = ""
            for ch in channels:
                try:
                    launch_args: dict[str, Any] = {"headless": headless}
                    if ch:
                        launch_args["channel"] = ch
                    self._browser = self._playwright.chromium.launch(**launch_args)
                    self._page = self._browser.new_page()
                    return {
                        "launched": True,
                        "headless": headless,
                        "channel": ch or "chromium",
                    }
                except Exception as e:
                    last_error = str(e)
                    continue

            return {"launched": False, "error": f"All channels failed: {last_error}"}
        except Exception:
            return {"launched": False, "error": traceback.format_exc()}

    def navigate(self, url: str) -> dict[str, Any]:
        """Navigate to a URL. Waits for page load."""
        if not self._page:
            return {"navigated": False, "error": "Browser not launched. Call web_launch first."}
        try:
            self._page.goto(url, wait_until="domcontentloaded", timeout=30000)
            return {
                "url": self._page.url,
                "title": self._page.title(),
            }
        except Exception:
            return {"navigated": False, "error": traceback.format_exc()}

    def get_interactive_nodes(self) -> dict[str, Any]:
        """Return visible interactive DOM elements + accessibility tree snapshot."""
        if not self._page:
            return {"url": "", "title": "", "nodes": [], "count": 0, "error": "Browser not launched"}

        try:
            dom = self._page.evaluate("""() => {
                const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="listitem"],[role="treeitem"],[contenteditable="true"]';
                return Array.from(document.querySelectorAll(selector))
                    .filter(el => {
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0
                            && r.top >= 0 && r.left >= 0
                            && r.bottom <= window.innerHeight
                            && r.right <= window.innerWidth;
                    })
                    .map((el, i) => ({
                        index: i,
                        tag: el.tagName.toLowerCase(),
                        role: el.getAttribute('role') || '',
                        name: (el.getAttribute('aria-label')
                            || el.getAttribute('title')
                            || el.getAttribute('placeholder')
                            || (el.textContent || '').trim().substring(0, 80)),
                        selector: el.id ? '#' + CSS.escape(el.id)
                            : '',
                        text: (el.textContent || '').trim().substring(0, 120),
                        bounds: (() => {
                            const r = el.getBoundingClientRect();
                            return {left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height)};
                        })(),
                    }));
            }""")

            # Also get accessibility tree for roles/names
            accessibility = None
            try:
                snapshot = self._page.accessibility.snapshot()
                accessibility = snapshot
            except Exception:
                pass

            return {
                "url": self._page.url,
                "title": self._page.title(),
                "nodes": dom,
                "accessibility": accessibility,
                "count": len(dom) if dom else 0,
            }
        except Exception:
            return {"url": "", "title": "", "nodes": [], "count": 0, "error": traceback.format_exc()}

    def click_selector(self, selector: str) -> dict[str, Any]:
        """Click an element by CSS selector."""
        if not self._page:
            return {"clicked": False, "error": "Browser not launched"}
        try:
            self._page.click(selector, timeout=5000)
            return {"clicked": True, "selector": selector}
        except Exception:
            return {"clicked": False, "error": traceback.format_exc()}

    def click_role(self, role: str, name: str | None = None) -> dict[str, Any]:
        """Click an element by ARIA role and optional accessible name."""
        if not self._page:
            return {"clicked": False, "error": "Browser not launched"}
        try:
            locator = self._page.get_by_role(role, name=name) if name else self._page.get_by_role(role)
            locator.first.click(timeout=5000)
            return {"clicked": True, "role": role, "name": name or ""}
        except Exception:
            return {"clicked": False, "error": traceback.format_exc()}

    def fill(self, selector: str, text: str) -> dict[str, Any]:
        """Fill an input field by CSS selector."""
        if not self._page:
            return {"filled": False, "error": "Browser not launched"}
        try:
            self._page.fill(selector, text, timeout=5000)
            return {"filled": True, "selector": selector, "text": text}
        except Exception:
            return {"filled": False, "error": traceback.format_exc()}

    def type_text(self, text: str) -> dict[str, Any]:
        """Type text at the current focus."""
        if not self._page:
            return {"typed": False, "error": "Browser not launched"}
        try:
            self._page.keyboard.type(text)
            return {"typed": text}
        except Exception:
            return {"typed": False, "error": traceback.format_exc()}

    def scroll(self, delta_y: int = 300) -> dict[str, Any]:
        """Scroll the page by delta_y pixels."""
        if not self._page:
            return {"scrolled": False, "error": "Browser not launched"}
        try:
            self._page.evaluate(f"window.scrollBy(0, {delta_y})")
            return {"scrolled": True, "delta_y": delta_y}
        except Exception:
            return {"scrolled": False, "error": traceback.format_exc()}

    def start_recording(self) -> dict[str, Any]:
        """Inject DOM event listeners into the current page and start recording."""
        if not self._page:
            return {"recording": False, "error": "Browser not launched"}
        try:
            self._recorded_events = []
            self._recording_active = True

            # Expose Python callback so JS can push events in real-time
            # (expose_function persists across same-origin navigations)
            if not self._event_handler_ref:
                def on_event(event_data: dict) -> None:
                    if self._recording_active:
                        event_data["_received_at"] = time.time()
                        self._recorded_events.append(event_data)

                self._event_handler_ref = on_event

            # Always try to expose — handle both first-time and re-expose
            try:
                self._page.expose_function("__openpaw_push_event", self._event_handler_ref)
            except Exception as e:
                # Already exposed from previous session — verify it's callable
                if "already registered" in str(e).lower() or "already exposed" in str(e).lower():
                    pass  # OK, the existing binding will work
                else:
                    # Unexpected error — reset ref so next attempt retries
                    self._event_handler_ref = None
                    return {"recording": False, "error": f"Failed to expose event function: {e}"}

            # Inject listeners into current page
            self._page.evaluate(_RECORD_LISTENERS_JS)

            # Verify injection succeeded
            is_injected = self._page.evaluate("() => !!window.__openpaw_recording")
            has_push_fn = self._page.evaluate("() => typeof window.__openpaw_push_event === 'function'")
            if not is_injected:
                return {"recording": False, "error": "JS listener injection failed"}
            if not has_push_fn:
                return {"recording": False, "error": "expose_function binding not available — __openpaw_push_event is not a function"}

            # Re-inject on page navigation (same-origin loads)
            def on_load(page: Page) -> None:
                try:
                    page.evaluate(_RECORD_LISTENERS_JS)
                except Exception:
                    pass

            self._page.on("load", on_load)

            return {"recording": True, "url": self._page.url}
        except Exception:
            return {"recording": False, "error": traceback.format_exc()}

    def stop_recording(self) -> dict[str, Any]:
        """Remove event listeners and return all recorded events."""
        if not self._page:
            return {"events": self._recorded_events, "count": len(self._recorded_events)}
        try:
            self._recording_active = False
            # Try to remove listeners from page
            try:
                self._page.evaluate(_REMOVE_LISTENERS_JS)
            except Exception:
                pass
            # Collect any remaining events from the page buffer
            try:
                buffer = self._page.evaluate("() => window.__openpaw_event_buffer || []")
                for evt in buffer:
                    evt["_received_at"] = time.time()
                    self._recorded_events.append(evt)
            except Exception:
                pass
            return {
                "events": self._recorded_events,
                "count": len(self._recorded_events),
            }
        except Exception:
            return {"events": self._recorded_events, "count": len(self._recorded_events), "error": traceback.format_exc()}

    def get_recorded_events(self) -> dict[str, Any]:
        """Return newly recorded events since last call and clear the buffer.

        Also drains the JS-side buffer as a fallback (in case __openpaw_push_event
        is unavailable, e.g. after cross-origin navigation).
        """
        # Drain JS buffer as fallback
        if self._page and self._recording_active:
            try:
                js_events = self._page.evaluate(
                    "() => { const buf = window.__openpaw_event_buffer || []; window.__openpaw_event_buffer = []; return buf; }"
                )
                for evt in js_events:
                    evt["_received_at"] = time.time()
                    self._recorded_events.append(evt)
            except Exception:
                pass  # page may have navigated away

        events = list(self._recorded_events)
        self._recorded_events = []
        return {"events": events, "count": len(events)}

    def close(self) -> dict[str, Any]:
        """Close browser and clean up."""
        try:
            self._recording_active = False
            if self._browser:
                self._browser.close()
            if self._playwright:
                self._playwright.stop()
            self._browser = None
            self._page = None
            self._playwright = None
            return {"closed": True}
        except Exception:
            return {"closed": False, "error": traceback.format_exc()}
