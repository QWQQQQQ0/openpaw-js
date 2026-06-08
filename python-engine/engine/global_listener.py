"""Global input event listener using pynput.

Captures keyboard, mouse, and scroll events system-wide.
Runs in background threads, queues events for polling by the bridge.

Event types:
  - mouse_click (with modifiers)
  - mouse_double_click
  - mouse_right_click
  - mouse_drag_start / mouse_drag_end
  - mouse_scroll
  - key_down / key_up (with modifiers)
"""

import time
import threading
from queue import Queue, Empty
from typing import Optional

from pynput import mouse, keyboard


# ── Modifier key tracking ──
# We maintain our own set instead of relying on pynput's listener state,
# because modifier keys need to be accurately reflected when non-modifier
# keys are pressed (e.g. Alt+A should show Alt as modifier).

_MODIFIER_KEYS = {
    keyboard.Key.ctrl, keyboard.Key.ctrl_l, keyboard.Key.ctrl_r,
    keyboard.Key.alt, keyboard.Key.alt_l, keyboard.Key.alt_r,
    keyboard.Key.shift, keyboard.Key.shift_l, keyboard.Key.shift_r,
    keyboard.Key.cmd, keyboard.Key.cmd_l, keyboard.Key.cmd_r,
}

_MODIFIER_NAMES = {
    keyboard.Key.ctrl: "Ctrl", keyboard.Key.ctrl_l: "LCtrl", keyboard.Key.ctrl_r: "RCtrl",
    keyboard.Key.alt: "Alt", keyboard.Key.alt_l: "LAlt", keyboard.Key.alt_r: "RAlt",
    keyboard.Key.shift: "Shift", keyboard.Key.shift_l: "LShift", keyboard.Key.shift_r: "RShift",
    keyboard.Key.cmd: "Win", keyboard.Key.cmd_l: "LWin", keyboard.Key.cmd_r: "RWin",
}


def _key_to_str(key) -> str:
    """Convert a pynput key to a readable string."""
    if isinstance(key, keyboard.Key):
        # Special keys
        name_map = {
            keyboard.Key.enter: "Enter",
            keyboard.Key.tab: "Tab",
            keyboard.Key.space: "Space",
            keyboard.Key.backspace: "Backspace",
            keyboard.Key.esc: "Escape",
            keyboard.Key.delete: "Delete",
            keyboard.Key.home: "Home",
            keyboard.Key.end: "End",
            keyboard.Key.page_up: "PageUp",
            keyboard.Key.page_down: "PageDown",
            keyboard.Key.up: "Up",
            keyboard.Key.down: "Down",
            keyboard.Key.left: "Left",
            keyboard.Key.right: "Right",
            keyboard.Key.f1: "F1", keyboard.Key.f2: "F2", keyboard.Key.f3: "F3",
            keyboard.Key.f4: "F4", keyboard.Key.f5: "F5", keyboard.Key.f6: "F6",
            keyboard.Key.f7: "F7", keyboard.Key.f8: "F8", keyboard.Key.f9: "F9",
            keyboard.Key.f10: "F10", keyboard.Key.f11: "F11", keyboard.Key.f12: "F12",
            keyboard.Key.print_screen: "PrintScreen",
            keyboard.Key.num_lock: "NumLock",
            keyboard.Key.caps_lock: "CapsLock",
        }
        return name_map.get(key, key.name or str(key))
    elif isinstance(key, keyboard.KeyCode):
        if key.char:
            return key.char
        if key.vk is not None:
            return f"VK_{key.vk:02X}"
    return str(key)


def _get_window_at(x: int, y: int) -> tuple[int, str]:
    """Get window handle and title at screen coordinates using ctypes."""
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        point = wintypes.POINT(x, y)
        hwnd = user32.WindowFromPoint(point)
        if not hwnd:
            return 0, ""

        # Get top-level window
        top = user32.GetAncestor(hwnd, 2)  # GA_ROOT = 2
        target = top if top else hwnd

        # Get window title
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(target, buf, 256)
        title = buf.value

        return target, title
    except Exception:
        return 0, ""


def _get_own_pid() -> int:
    """Get current process PID."""
    import ctypes
    return ctypes.windll.kernel32.GetCurrentProcessId()


def _is_own_window(hwnd: int, self_pid: int) -> bool:
    """Check if a window belongs to our own process.

    Walks the entire parent chain (GetParent) checking PID at each level.
    This handles WebView2 where the child window (Chrome_WidgetWin_1) may
    have a different PID than the top-level Tauri host window.
    """
    if not hwnd or not self_pid:
        return False
    try:
        import ctypes
        user32 = ctypes.windll.user32
        pid = ctypes.c_ulong()

        current = hwnd
        for _ in range(20):  # prevent infinite loops
            if not current:
                break
            user32.GetWindowThreadProcessId(current, ctypes.byref(pid))
            if pid.value == self_pid:
                return True
            # Try GetParent (includes owner windows) instead of just GetAncestor
            parent = user32.GetParent(current)
            if not parent or parent == current:
                # Also try the owner window
                parent = user32.GetWindow(current, 4)  # GW_OWNER = 4
            if not parent or parent == current:
                break
            current = parent
        return False
    except Exception:
        return False


class GlobalInputListener:
    """Captures global keyboard/mouse events via pynput and queues them."""

    # Drag detection threshold (pixels)
    DRAG_THRESHOLD = 5

    def __init__(self):
        self._queue: Queue = Queue()
        self._pressed_keys: set = set()  # Currently held keys (for modifier tracking)
        self._self_pid: int = 0  # Set by start(parent_pid=...) from Tauri

        # Drag state
        self._drag_start: Optional[tuple[int, int]] = None
        self._drag_start_time: float = 0
        self._drag_button: Optional[str] = None
        self._drag_emitted: bool = False

        # Double-click detection
        self._last_click_time: float = 0
        self._last_click_pos: Optional[tuple[int, int]] = None
        self._double_click_threshold: float = 0.4  # seconds
        self._double_click_distance: int = 5  # pixels

        # Listeners
        self._mouse_listener: Optional[mouse.Listener] = None
        self._keyboard_listener: Optional[keyboard.Listener] = None
        self._running = False

    def _emit(self, event: dict):
        """Push event to the queue."""
        self._queue.put(event)

    def _get_modifiers(self) -> list[str]:
        """Get currently held modifier keys."""
        mods = []
        for key in self._pressed_keys:
            if key in _MODIFIER_NAMES:
                mods.append(_MODIFIER_NAMES[key])
        return mods

    def _make_event(self, event_type: str, x: int = 0, y: int = 0,
                    key: Optional[str] = None, modifiers: Optional[list] = None) -> dict:
        """Create a standard event dict."""
        hwnd, window_title = _get_window_at(x, y)

        # Safety zone: skip mouse events on our own windows (but always allow keyboard events)
        if event_type.startswith("mouse") and _is_own_window(hwnd, self._self_pid):
            return {}

        return {
            "event_type": event_type,
            "x": x,
            "y": y,
            "key": key,
            "modifiers": modifiers or self._get_modifiers(),
            "hwnd": hwnd,
            "window_title": window_title,
            "timestamp": int(time.time() * 1000),
        }

    # ── Mouse callbacks ──

    def _on_click(self, x: int, y: int, button: mouse.Button, pressed: bool):
        btn_name = "left" if button == mouse.Button.left else "right"
        now = time.time()

        if pressed:
            # Start potential drag
            self._drag_start = (x, y)
            self._drag_start_time = now
            self._drag_button = btn_name
            self._drag_emitted = False

            # Check for double-click
            is_double = False
            if self._last_click_pos and self._last_click_time:
                dt = now - self._last_click_time
                dx = abs(x - self._last_click_pos[0])
                dy = abs(y - self._last_click_pos[1])
                if dt < self._double_click_threshold and dx < self._double_click_distance and dy < self._double_click_distance:
                    is_double = True

            if is_double:
                evt = self._make_event("mouse_double_click", x, y)
                if evt:
                    self._emit(evt)
                self._last_click_time = 0
                self._last_click_pos = None
            else:
                # Don't emit click yet — wait for release to confirm it's not a drag
                self._last_click_time = now
                self._last_click_pos = (x, y)
        else:
            # Mouse release
            if self._drag_start and self._drag_emitted:
                # End of drag
                evt = self._make_event("mouse_drag_end", x, y,
                                       key=self._drag_button)
                if evt:
                    self._emit(evt)
            elif self._drag_start:
                # No significant movement — it's a click
                if btn_name == "left":
                    evt = self._make_event("mouse_click", x, y)
                else:
                    evt = self._make_event("mouse_right_click", x, y)
                if evt:
                    self._emit(evt)

            self._drag_start = None
            self._drag_button = None
            self._drag_emitted = False

    def _on_move(self, x: int, y: int):
        if not self._drag_start:
            return

        dx = x - self._drag_start[0]
        dy = y - self._drag_start[1]
        dist = (dx * dx + dy * dy) ** 0.5

        if dist >= self.DRAG_THRESHOLD and not self._drag_emitted:
            # Emit drag start
            self._drag_emitted = True
            evt = self._make_event("mouse_drag_start",
                                   self._drag_start[0], self._drag_start[1],
                                   key=self._drag_button)
            if evt:
                self._emit(evt)

    def _on_scroll(self, x: int, y: int, dx: int, dy: int):
        evt = self._make_event("mouse_scroll", x, y,
                               key=f"{'down' if dy < 0 else 'up'}")
        if evt:
            evt["scroll_dx"] = dx
            evt["scroll_dy"] = dy
            self._emit(evt)

    # ── Keyboard callbacks ──

    def _on_press(self, key):
        self._pressed_keys.add(key)

        # Skip pure modifier key presses (we track them but don't emit events)
        if key in _MODIFIER_KEYS:
            return

        key_str = _key_to_str(key)
        mods = self._get_modifiers()

        # Get cursor position
        try:
            import ctypes
            pt = ctypes.wintypes.POINT()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            x, y = pt.x, pt.y
        except Exception:
            x, y = 0, 0

        evt = self._make_event("key_down", x, y, key=key_str, modifiers=mods)
        if evt:
            self._emit(evt)

    def _on_release(self, key):
        self._pressed_keys.discard(key)

        # Skip pure modifier key releases
        if key in _MODIFIER_KEYS:
            return

        key_str = _key_to_str(key)
        mods = self._get_modifiers()

        try:
            import ctypes
            pt = ctypes.wintypes.POINT()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            x, y = pt.x, pt.y
        except Exception:
            x, y = 0, 0

        # Only emit key_up for long presses (>500ms), matching old Rust behavior
        # Actually, we'll emit all key_up for completeness — the frontend can filter
        evt = self._make_event("key_up", x, y, key=key_str, modifiers=mods)
        if evt:
            self._emit(evt)

    # ── Control ──

    def start(self, parent_pid: int = 0):
        if self._running:
            return
        self._self_pid = parent_pid if parent_pid else _get_own_pid()
        self._running = True

        self._mouse_listener = mouse.Listener(
            on_click=self._on_click,
            on_move=self._on_move,
            on_scroll=self._on_scroll,
        )
        self._keyboard_listener = keyboard.Listener(
            on_press=self._on_press,
            on_release=self._on_release,
        )

        self._mouse_listener.start()
        self._keyboard_listener.start()

    def stop(self):
        self._running = False
        if self._mouse_listener:
            self._mouse_listener.stop()
            self._mouse_listener = None
        if self._keyboard_listener:
            self._keyboard_listener.stop()
            self._keyboard_listener = None
        self._pressed_keys.clear()

    def poll(self, max_events: int = 100) -> list[dict]:
        """Drain queued events (called by the bridge)."""
        events = []
        for _ in range(max_events):
            try:
                events.append(self._queue.get_nowait())
            except Empty:
                break
        return events

    @property
    def is_running(self) -> bool:
        return self._running


# Singleton
_listener: Optional[GlobalInputListener] = None


def get_listener() -> GlobalInputListener:
    global _listener
    if _listener is None:
        _listener = GlobalInputListener()
    return _listener
