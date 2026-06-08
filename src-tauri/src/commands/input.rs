// Desktop input simulation via Win32 SendInput
// Supports: click, double-click, right-click, middle-click, drag,
//           type text, key press/release, key combo, scroll, move

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEINPUT, MOUSE_EVENT_FLAGS, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SetCursorPos, SM_CXSCREEN, SM_CYSCREEN};

fn send_mouse_input(flags: MOUSE_EVENT_FLAGS, data: u32) -> u32 {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        let mut inputs = [input];
        SendInput(&mut inputs, std::mem::size_of::<INPUT>() as i32)
    }
}

fn send_keyboard_input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) {
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        let mut inputs = [input];
        SendInput(&mut inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

fn move_cursor(x: i32, y: i32) -> Result<(), String> {
    unsafe { SetCursorPos(x, y) }.map_err(|e| format!("SetCursorPos failed: {e:?}"))
}

/// Send a mouse move event via SendInput (absolute coordinates).
/// Unlike SetCursorPos, this injects WM_MOUSEMOVE into the input queue,
/// which is required for drawing applications (Paint, Photoshop, etc.)
/// to see intermediate cursor positions during drag/draw operations.
/// Returns the number of events successfully inserted (0 = blocked).
fn send_mouse_move_absolute(x: i32, y: i32) -> u32 {
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    // MOUSEEVENTF_ABSOLUTE normalizes to 0..65535
    let dx = if screen_w > 0 { ((x as f64 / screen_w as f64) * 65535.0) as i32 } else { 0 };
    let dy = if screen_h > 0 { ((y as f64 / screen_h as f64) * 65535.0) as i32 } else { 0 };

    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: 0,
                dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        let mut inputs = [input];
        SendInput(&mut inputs, std::mem::size_of::<INPUT>() as i32)
    }
}

fn parse_key_name(key: &str) -> Result<u16, String> {
    let vk = match key.to_lowercase().as_str() {
        "enter" | "return" => 0x0D,
        "escape" | "esc" => 0x1B,
        "tab" => 0x09,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "space" => 0x20,
        "arrowup" | "up" => 0x26,
        "arrowdown" | "down" => 0x28,
        "arrowleft" | "left" => 0x25,
        "arrowright" | "right" => 0x27,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "insert" => 0x2D,
        "printscreen" => 0x2C,
        "numlock" => 0x90,
        "scrolllock" => 0x91,
        "capslock" => 0x14,
        "f1" => 0x70,
        "f2" => 0x71,
        "f3" => 0x72,
        "f4" => 0x73,
        "f5" => 0x74,
        "f6" => 0x75,
        "f7" => 0x76,
        "f8" => 0x77,
        "f9" => 0x78,
        "f10" => 0x79,
        "f11" => 0x7A,
        "f12" => 0x7B,
        "ctrl" | "lctrl" => 0xA2,
        "rctrl" => 0xA3,
        "alt" | "lalt" => 0xA4,
        "ralt" => 0xA5,
        "shift" | "lshift" => 0xA0,
        "rshift" => 0xA1,
        "win" | "lwin" => 0x5B,
        "rwin" => 0x5C,
        _ => {
            // Single character keys
            let chars: Vec<char> = key.chars().collect();
            if chars.len() == 1 {
                let ch = chars[0].to_ascii_uppercase() as u8;
                if ch.is_ascii_alphanumeric() || ch.is_ascii_punctuation() || ch == b' ' {
                    ch as u16
                } else {
                    return Err(format!("Unknown key: {key}"));
                }
            } else {
                return Err(format!("Unknown key: {key}"));
            }
        }
    };
    Ok(vk)
}

/// Parse a key string that may contain combos like "Ctrl+A", "Ctrl+Shift+S"
/// Returns (modifiers VK codes, main key VK code)
fn parse_key_combo(key: &str) -> Result<(Vec<u16>, u16), String> {
    let parts: Vec<&str> = key.split('+').map(|s| s.trim()).collect();
    if parts.is_empty() {
        return Err("Empty key".to_string());
    }

    let mut modifiers = Vec::new();
    let mut main_key = 0u16;

    for (i, part) in parts.iter().enumerate() {
        let vk = parse_key_name(part)?;
        let is_modifier = matches!(
            vk,
            0xA0 | 0xA1 | 0xA2 | 0xA3 | 0xA4 | 0xA5 | 0x5B | 0x5C
        );

        if is_modifier {
            modifiers.push(vk);
        } else if i == parts.len() - 1 {
            main_key = vk;
        } else {
            return Err(format!("Non-modifier key must be last: {part}"));
        }
    }

    if main_key == 0 && !modifiers.is_empty() {
        // Single modifier key press (like just "Ctrl")
        main_key = modifiers.pop().unwrap();
    }

    Ok((modifiers, main_key))
}

// ═══════════════════════════════════════════════════════════════
// Tauri commands
// ═══════════════════════════════════════════════════════════════

#[tauri::command]
pub fn desktop_click(x: i32, y: i32) -> Result<(), String> {
    move_cursor(x, y)?;
    std::thread::sleep(std::time::Duration::from_millis(10));
    send_mouse_input(MOUSEEVENTF_LEFTDOWN, 0);
    send_mouse_input(MOUSEEVENTF_LEFTUP, 0);
    Ok(())
}

#[tauri::command]
pub fn desktop_double_click(x: i32, y: i32) -> Result<(), String> {
    desktop_click(x, y)?;
    std::thread::sleep(std::time::Duration::from_millis(50));
    desktop_click(x, y)
}

#[tauri::command]
pub fn desktop_right_click(x: i32, y: i32) -> Result<(), String> {
    move_cursor(x, y)?;
    std::thread::sleep(std::time::Duration::from_millis(10));
    send_mouse_input(MOUSEEVENTF_RIGHTDOWN, 0);
    send_mouse_input(MOUSEEVENTF_RIGHTUP, 0);
    Ok(())
}

#[tauri::command]
pub fn desktop_middle_click(x: i32, y: i32) -> Result<(), String> {
    move_cursor(x, y)?;
    std::thread::sleep(std::time::Duration::from_millis(10));
    send_mouse_input(MOUSEEVENTF_MIDDLEDOWN, 0);
    send_mouse_input(MOUSEEVENTF_MIDDLEUP, 0);
    Ok(())
}

#[tauri::command]
pub fn desktop_mouse_down(x: i32, y: i32, button: Option<String>) -> Result<(), String> {
    move_cursor(x, y)?;
    std::thread::sleep(std::time::Duration::from_millis(10));
    let btn = button.unwrap_or_else(|| "left".to_string());
    match btn.as_str() {
        "left" => { send_mouse_input(MOUSEEVENTF_LEFTDOWN, 0); }
        "right" => { send_mouse_input(MOUSEEVENTF_RIGHTDOWN, 0); }
        "middle" => { send_mouse_input(MOUSEEVENTF_MIDDLEDOWN, 0); }
        _ => return Err(format!("Unknown button: {btn}")),
    };
    Ok(())
}

#[tauri::command]
pub fn desktop_mouse_up(x: i32, y: i32, button: Option<String>) -> Result<(), String> {
    move_cursor(x, y)?;
    let btn = button.unwrap_or_else(|| "left".to_string());
    match btn.as_str() {
        "left" => { send_mouse_input(MOUSEEVENTF_LEFTUP, 0); }
        "right" => { send_mouse_input(MOUSEEVENTF_RIGHTUP, 0); }
        "middle" => { send_mouse_input(MOUSEEVENTF_MIDDLEUP, 0); }
        _ => return Err(format!("Unknown button: {btn}")),
    };
    Ok(())
}

#[tauri::command]
pub fn desktop_drag(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    duration_ms: Option<u64>,
    button: Option<String>,
) -> Result<(), String> {
    let dur = duration_ms.unwrap_or(300);
    let btn = button.unwrap_or_else(|| "left".to_string());
    let (down_flag, up_flag) = match btn.as_str() {
        "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        _ => return Err(format!("Unknown button: {btn}")),
    };

    // Move to start
    move_cursor(start_x, start_y)?;
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Mouse down
    send_mouse_input(down_flag, 0);
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Interpolate movement from start to end
    let steps = 20u64.max(dur / 16); // ~60fps
    let dx = (end_x - start_x) as f64;
    let dy = (end_y - start_y) as f64;
    let step_delay = dur / steps;

    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let x = start_x + (dx * t) as i32;
        let y = start_y + (dy * t) as i32;
        move_cursor(x, y)?;
        if step_delay > 0 {
            std::thread::sleep(std::time::Duration::from_millis(step_delay));
        }
    }

    // Ensure we end at exact target
    move_cursor(end_x, end_y)?;
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Mouse up
    send_mouse_input(up_flag, 0);
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct Waypoint {
    pub x: i32,
    pub y: i32,
}

/// Smooth mouse movement along a pre-sampled path.
/// waypoints must have at least 1 point.
/// hold_button: if set, presses the button at the first waypoint and releases at the last.
#[tauri::command]
pub fn desktop_move_cursor(
    waypoints: Vec<Waypoint>,
    duration_ms: Option<u64>,
    hold_button: Option<String>,
) -> Result<(), String> {
    if waypoints.is_empty() {
        return Err("waypoints must not be empty".to_string());
    }

    let dur = duration_ms.unwrap_or(500);
    let total = waypoints.len() as u64;

    // 短暂休眠让前序操作（截图、压缩等）的 IPC 和系统资源完全释放
    std::thread::sleep(std::time::Duration::from_millis(50));

    eprintln!("[rust:move_cursor] waypoints={}, duration_ms={}, hold_button={:?}, first=({},{}), last=({},{})",
        total, dur, hold_button,
        waypoints[0].x, waypoints[0].y,
        waypoints[waypoints.len()-1].x, waypoints[waypoints.len()-1].y,
    );

    // ── Press button at start ──
    let down_flag = if let Some(ref btn) = hold_button {
        let flag = match btn.as_str() {
            "left" => MOUSEEVENTF_LEFTDOWN,
            "right" => MOUSEEVENTF_RIGHTDOWN,
            "middle" => MOUSEEVENTF_MIDDLEDOWN,
            _ => return Err(format!("Unknown button: {btn}")),
        };
        move_cursor(waypoints[0].x, waypoints[0].y)?;
        std::thread::sleep(std::time::Duration::from_millis(30));
        let sent = send_mouse_input(flag, 0);
        if sent == 0 { eprintln!("[rust:move_cursor] ⚠ SendInput LEFTDOWN returned 0 — BLOCKED!"); }
        std::thread::sleep(std::time::Duration::from_millis(10));
        Some(flag)
    } else {
        None
    };

    // ── Walk through waypoints with pacing ──
    let start_time = std::time::Instant::now();
    let mut move_blocked: u32 = 0;
    for (i, pt) in waypoints.iter().enumerate() {
        move_cursor(pt.x, pt.y)?;
        let sent = send_mouse_move_absolute(pt.x, pt.y);
        if sent == 0 { move_blocked += 1; }

        if i + 1 < waypoints.len() {
            let elapsed = start_time.elapsed().as_millis() as u64;
            let expected = ((i as u64 + 1) * dur) / total;
            if expected > elapsed {
                std::thread::sleep(std::time::Duration::from_millis(expected - elapsed));
            }
        }
    }
    if move_blocked > 0 {
        eprintln!("[rust:move_cursor] ⚠ SendInput MOVE blocked {}/{} times!", move_blocked, total);
    }

    // ── Release button at end ──
    if let Some(down) = down_flag {
        let last = &waypoints[waypoints.len() - 1];
        move_cursor(last.x, last.y)?;
        let sent_move = send_mouse_move_absolute(last.x, last.y);
        std::thread::sleep(std::time::Duration::from_millis(30));

        let up_flag = match down {
            MOUSEEVENTF_LEFTDOWN => MOUSEEVENTF_LEFTUP,
            MOUSEEVENTF_RIGHTDOWN => MOUSEEVENTF_RIGHTUP,
            MOUSEEVENTF_MIDDLEDOWN => MOUSEEVENTF_MIDDLEUP,
            _ => MOUSEEVENTF_LEFTUP,
        };
        let sent_up = send_mouse_input(up_flag, 0);
        eprintln!("[rust:move_cursor] release: up_flag={:?}, pos=({},{}), final_move_sent={}, up_sent={}",
            up_flag, last.x, last.y, sent_move, sent_up);
        if sent_up == 0 { eprintln!("[rust:move_cursor] ⚠ SendInput LEFTUP returned 0 — BLOCKED!"); }
    } else {
        eprintln!("[rust:move_cursor] no hold_button — move only, no press/release");
    }

    Ok(())
}

#[tauri::command]
pub fn desktop_type_text(text: String) -> Result<(), String> {
    for ch in text.encode_utf16() {
        send_keyboard_input(VIRTUAL_KEY(0), ch, KEYEVENTF_UNICODE);
        send_keyboard_input(VIRTUAL_KEY(0), ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_press_key(key: String) -> Result<(), String> {
    let (modifiers, main_key) = parse_key_combo(&key)?;

    // Press modifiers down
    for &vk in &modifiers {
        send_keyboard_input(VIRTUAL_KEY(vk), 0, KEYBD_EVENT_FLAGS(0));
        std::thread::sleep(std::time::Duration::from_millis(5));
    }

    // Press and release main key
    send_keyboard_input(VIRTUAL_KEY(main_key), 0, KEYBD_EVENT_FLAGS(0));
    std::thread::sleep(std::time::Duration::from_millis(5));
    send_keyboard_input(VIRTUAL_KEY(main_key), 0, KEYEVENTF_KEYUP);

    // Release modifiers (reverse order)
    for &vk in modifiers.iter().rev() {
        std::thread::sleep(std::time::Duration::from_millis(5));
        send_keyboard_input(VIRTUAL_KEY(vk), 0, KEYEVENTF_KEYUP);
    }

    Ok(())
}

#[tauri::command]
pub fn desktop_key_down(key: String) -> Result<(), String> {
    let vk = parse_key_name(&key)?;
    send_keyboard_input(VIRTUAL_KEY(vk), 0, KEYBD_EVENT_FLAGS(0));
    Ok(())
}

#[tauri::command]
pub fn desktop_key_up(key: String) -> Result<(), String> {
    let vk = parse_key_name(&key)?;
    send_keyboard_input(VIRTUAL_KEY(vk), 0, KEYEVENTF_KEYUP);
    Ok(())
}

#[tauri::command]
pub fn desktop_scroll(x: i32, y: i32, delta: i32) -> Result<(), String> {
    move_cursor(x, y)?;
    std::thread::sleep(std::time::Duration::from_millis(10));
    send_mouse_input(MOUSEEVENTF_WHEEL, delta as u32);
    Ok(())
}

#[tauri::command]
pub fn desktop_move_mouse(x: i32, y: i32) -> Result<(), String> {
    move_cursor(x, y)
}

// ── Clipboard ──

#[tauri::command]
pub fn desktop_get_clipboard() -> Result<String, String> {
    clipboard_win::get_clipboard_string()
        .map_err(|e| format!("getClipboard failed: {e:?}"))
}

#[tauri::command]
pub fn desktop_set_clipboard(text: String) -> Result<(), String> {
    clipboard_win::set_clipboard_string(&text)
        .map_err(|e| format!("setClipboard failed: {e:?}"))
}
