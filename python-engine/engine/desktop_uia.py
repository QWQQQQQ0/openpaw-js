"""Desktop UI Automation via pywinauto UIA backend.

Provides semantic UI operations: enumerate interactive nodes, click by role/name,
type text into fields — all without hardcoding coordinates.
"""

from __future__ import annotations

import hashlib
import json
import sys
import traceback
from typing import Any

try:
    from pywinauto import Desktop
    from pywinauto.application import Application
    HAS_PYWINAUTO = True
except ImportError:
    HAS_PYWINAUTO = False


# Control types that are interactive leaf elements (not containers)
INTERACTIVE_CONTROL_TYPES = {
    "Button", "Edit", "ComboBox", "CheckBox", "RadioButton",
    "ListItem", "TreeItem", "MenuItem", "Hyperlink", "TabItem",
    "SplitButton", "TextBox", "ToggleSwitch", "Thumb",
}


def _extract_node(el) -> dict[str, Any] | None:
    """Extract node info from a UIA element. Returns None if not interactive."""
    try:
        info = el.element_info
        ct = info.control_type or ""
        if ct not in INTERACTIVE_CONTROL_TYPES:
            return None

        try:
            rect = el.rectangle()
            bounds = {
                "left": rect.left, "top": rect.top,
                "right": rect.right, "bottom": rect.bottom,
                "width": rect.width(), "height": rect.height(),
            }
        except Exception:
            bounds = None

        return {
            "role": ct,
            "name": info.name or "",
            "automation_id": info.automation_id or "",
            "class_name": info.class_name or "",
            "enabled": getattr(info, "enabled", True),
            "visible": getattr(info, "visible", True),
            "bounds": bounds,
        }
    except Exception:
        return None


class UIAEngine:
    """Wraps pywinauto for semantic desktop automation."""

    def __init__(self) -> None:
        if not HAS_PYWINAUTO:
            raise RuntimeError(
                "pywinauto is not installed. Run: pip install pywinauto"
            )
        self._target_hwnd: int | None = None

    def get_interactive_nodes(
        self,
        window_hwnd: int | None = None,
        roles: list[str] | None = None,
        name_keyword: str | None = None,
        onscreen_only: bool = False,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Return only interactive nodes (buttons, inputs, etc.) for a window.

        If window_hwnd is None, uses the foreground window.
        Uses descendants() for thorough traversal at any depth.
        Optional filters: roles, name_keyword, onscreen_only, limit.
        """
        try:
            if window_hwnd is not None:
                app = Application(backend="uia").connect(handle=window_hwnd)
                dlg = app.window(handle=window_hwnd)
            else:
                # Prefer the last known target window over the foreground window
                import ctypes
                hwnd = self._target_hwnd or ctypes.windll.user32.GetForegroundWindow()
                if hwnd:
                    app = Application(backend="uia").connect(handle=hwnd)
                    dlg = app.window(handle=hwnd)
                    window_hwnd = hwnd
                else:
                    dlg = Desktop(backend="uia")

            nodes: list[dict[str, Any]] = []
            try:
                for el in dlg.descendants():
                    node = _extract_node(el)
                    if node:
                        nodes.append(node)
            except Exception:
                pass

            total_count = len(nodes)

            # Apply filters
            filtered = nodes
            if roles:
                role_set = set(roles)
                filtered = [n for n in filtered if n["role"] in role_set]
            if name_keyword:
                kw = name_keyword.lower()
                filtered = [n for n in filtered if kw in (n["name"] or "").lower()
                            or kw in (n["automation_id"] or "").lower()]
            if onscreen_only:
                def _is_onscreen(n: dict[str, Any]) -> bool:
                    b = n.get("bounds")
                    if not b:
                        return True
                    return b["right"] > 0 and b["bottom"] > 0 and b["width"] > 0 and b["height"] > 0
                filtered = [n for n in filtered if _is_onscreen(n)]
            if limit and limit > 0:
                filtered = filtered[:limit]

            # Persist the target window for subsequent calls without explicit hwnd
            if window_hwnd is not None:
                self._target_hwnd = window_hwnd

            return {
                "window_title": dlg.window_text(),
                "window_hwnd": window_hwnd,
                "nodes": filtered,
                "count": len(filtered),
                "total_count": total_count,
            }
        except Exception:
            return {
                "window_title": "",
                "window_hwnd": window_hwnd,
                "nodes": [],
                "count": 0,
                "total_count": 0,
                "error": traceback.format_exc(),
            }

    def click(self, role: str, name: str | None = None,
              window_hwnd: int | None = None) -> dict[str, Any]:
        """Click a UI element by its role and optionally name.

        Searches all descendants. Uses UIA InvokePattern first, falls back to click_input.
        """
        try:
            if window_hwnd is not None:
                self._target_hwnd = window_hwnd
            el = self._find(role, name, window_hwnd)
            if el is None:
                return {"clicked": False, "error": f"Element not found: role={role}, name={name}"}

            try:
                el.invoke()
            except Exception:
                try:
                    el.click_input()
                except Exception:
                    el.click()

            return {"clicked": True, "role": role, "name": name or ""}
        except Exception:
            return {"clicked": False, "error": traceback.format_exc()}

    def type_text(self, text: str, role: str | None = None,
                  name: str | None = None,
                  window_hwnd: int | None = None) -> dict[str, Any]:
        """Type text into a field. If role/name given, focuses the element first."""
        try:
            if window_hwnd is not None:
                self._target_hwnd = window_hwnd
            if role:
                el = self._find(role, name, window_hwnd)
                if el is None:
                    return {"typed": False, "error": f"Element not found: role={role}, name={name}"}
                el.set_focus()
                el.type_keys(text, with_spaces=True)
            else:
                from pywinauto.keyboard import send_keys
                send_keys(text, with_spaces=True)

            return {"typed": text}
        except Exception:
            return {"typed": False, "error": traceback.format_exc()}

    def find_element(self, role: str, name: str | None = None,
                     window_hwnd: int | None = None) -> dict[str, Any]:
        """Locate an element and return its current bounds/enabled state."""
        try:
            if window_hwnd is not None:
                self._target_hwnd = window_hwnd
            el = self._find(role, name, window_hwnd)
            if el is None:
                return {"found": False, "role": role, "name": name or ""}

            rect = el.rectangle()
            return {
                "found": True,
                "role": role,
                "name": name or "",
                "bounds": {
                    "left": rect.left, "top": rect.top,
                    "right": rect.right, "bottom": rect.bottom,
                    "width": rect.width(), "height": rect.height(),
                },
                "enabled": el.is_enabled(),
                "visible": el.is_visible(),
            }
        except Exception:
            return {"found": False, "error": traceback.format_exc()}

    def get_property(self, role: str, name: str | None, prop: str,
                     window_hwnd: int | None = None) -> dict[str, Any]:
        """Read a UIA property from an element (e.g., Value, IsSelected)."""
        try:
            if window_hwnd is not None:
                self._target_hwnd = window_hwnd
            el = self._find(role, name, window_hwnd)
            if el is None:
                return {"value": None, "error": f"Element not found: role={role}, name={name}"}

            info = el.element_info
            value = getattr(info, prop.lower(), None)
            return {"role": role, "name": name or "", "property": prop, "value": value}
        except Exception:
            return {"value": None, "error": traceback.format_exc()}

    def fingerprint(self, window_hwnd: int | None = None) -> dict[str, Any]:
        """Compute hierarchical structural fingerprints of a window's UIA tree.

        Only hashes structural features (control_type, automation_id, depth, ordering),
        NOT dynamic content (names, text, bounds, enabled/visible state).

        Returns window-level + page-level fingerprints. A partial UI change (e.g.,
        new tab opened) only invalidates the affected page fingerprint, not the window.
        """
        try:
            if window_hwnd is not None:
                self._target_hwnd = window_hwnd
            root = self._get_root(window_hwnd)
            window_fp = self._hash_structure(root, depth=2)

            # Find page containers (groups/panes with automation_ids)
            pages: dict[str, str] = {}
            try:
                for container in root.descendants(control_type="Group"):
                    aid = container.element_info.automation_id
                    if aid:
                        pages[aid] = self._hash_structure(container, depth=3)
                for container in root.descendants(control_type="Pane"):
                    aid = container.element_info.automation_id
                    if aid:
                        pages[aid] = self._hash_structure(container, depth=3)
            except Exception:
                pass

            return {
                "window_fp": window_fp,
                "pages": pages,
                "window_title": root.window_text()
                    if window_hwnd else "Desktop",
                "window_hwnd": window_hwnd,
            }
        except Exception:
            return {
                "window_fp": "",
                "pages": {},
                "window_hwnd": window_hwnd,
                "error": traceback.format_exc(),
            }

    def _hash_structure(self, element, depth: int, _cur: int = 0) -> str:
        """Walk the UIA tree to `depth` and produce a stable structural hash.

        Only includes: control_type, automation_id, relative depth order.
        Ignores: names, text, bounds, enabled/visible state, list counts.
        """
        try:
            info = element.element_info
            sig = f"{info.control_type or '?'}|{info.automation_id or ''}"
        except Exception:
            sig = "error"

        if _cur >= depth:
            return hashlib.md5(sig.encode()).hexdigest()[:8]

        child_sigs: list[str] = []
        try:
            for child in element.children():
                child_sigs.append(self._hash_structure(child, depth, _cur + 1))
        except Exception:
            pass

        combined = sig + "(" + ",".join(sorted(child_sigs)) + ")"
        return hashlib.md5(combined.encode()).hexdigest()[:8]

    def find_at_point(self, x: int, y: int, hwnd: int | None = None) -> dict[str, Any]:
        """Find a UI element at the given screen coordinates."""
        try:
            if hwnd is not None:
                self._target_hwnd = hwnd

            # 获取所有元素并检查哪个包含该坐标
            root = self._get_root(hwnd)
            candidates = []

            for el in root.descendants():
                try:
                    rect = el.rectangle()
                    if rect.left <= x <= rect.right and rect.top <= y <= rect.bottom:
                        info = el.element_info
                        ct = info.control_type or ""
                        candidates.append({
                            "role": ct,
                            "name": info.name or "",
                            "automation_id": info.automation_id or "",
                            "class_name": info.class_name or "",
                            "bounds": {
                                "left": rect.left, "top": rect.top,
                                "right": rect.right, "bottom": rect.bottom,
                                "width": rect.width(), "height": rect.height(),
                            },
                            "area": rect.width() * rect.height(),
                        })
                except Exception:
                    continue

            # 返回面积最小的元素（最精确的匹配）
            if candidates:
                candidates.sort(key=lambda c: c["area"])
                best = candidates[0]
                del best["area"]
                return {"found": True, **best}

            return {"found": False, "x": x, "y": y}
        except Exception:
            return {"found": False, "error": traceback.format_exc()}

    # ── internal helpers ──

    def _get_root(self, window_hwnd: int | None = None):
        if window_hwnd is not None:
            app = Application(backend="uia").connect(handle=window_hwnd)
            return app.window(handle=window_hwnd)
        import ctypes
        hwnd = self._target_hwnd or ctypes.windll.user32.GetForegroundWindow()
        if hwnd:
            app = Application(backend="uia").connect(handle=hwnd)
            return app.window(handle=hwnd)
        return Desktop(backend="uia")

    def _find(self, role: str, name: str | None,
              window_hwnd: int | None = None):
        """Find a UI element by role and optional name in all descendants."""
        root = self._get_root(window_hwnd)

        # Build search criteria
        criteria: dict[str, Any] = {"control_type": role}
        if name:
            # Try exact name match, then substring, then automation_id
            candidates = []
            try:
                candidates = list(root.descendants(control_type=role, title=name))
            except Exception:
                pass
            if not candidates:
                try:
                    candidates = list(root.descendants(control_type=role, title_re=f".*{name}.*"))
                except Exception:
                    pass
            if not candidates:
                try:
                    candidates = list(root.descendants(control_type=role, auto_id=name))
                except Exception:
                    pass
        else:
            try:
                candidates = list(root.descendants(control_type=role))
            except Exception:
                candidates = []

        # Return first visible+enabled match, or first match
        if candidates:
            for c in candidates:
                try:
                    if c.is_visible() and c.is_enabled():
                        return c
                except Exception:
                    continue
            return candidates[0]

        return None
