/**
 * 全局事件监听模块
 *
 * 使用 Windows API 的 SetWindowsHookEx 设置全局键盘/鼠标钩子，
 * 捕获跨应用的用户操作事件，并通过 Tauri 事件系统发送到前端。
 */

use std::sync::{Arc, Mutex, OnceLock};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use tauri::{AppHandle, Emitter};
use serde::{Deserialize, Serialize};

/// 全局事件类型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalInputEvent {
    /// 事件类型: mouse_click, mouse_double_click, mouse_right_click, key_down, key_up
    pub event_type: String,
    /// 屏幕坐标 X
    pub x: i32,
    /// 屏幕坐标 Y
    pub y: i32,
    /// 键盘按键 (如果是键盘事件)
    pub key: Option<String>,
    /// 修饰键
    pub modifiers: Vec<String>,
    /// 窗口句柄
    pub hwnd: i64,
    /// 窗口标题
    pub window_title: String,
    /// 时间戳
    pub timestamp: u64,
}

/// Hook 状态
struct HookState {
    mouse_hook: Option<HHOOK>,
    keyboard_hook: Option<HHOOK>,
    is_running: bool,
    app_handle: Option<AppHandle>,
    self_pid: u32,
}

// HHOOK 包含 *mut c_void，不是 Send 的，但我们保证只在主线程操作
unsafe impl Send for HookState {}
unsafe impl Sync for HookState {}

static HOOK_STATE: OnceLock<Arc<Mutex<HookState>>> = OnceLock::new();

/// 获取 Hook 状态
fn get_hook_state() -> Arc<Mutex<HookState>> {
    HOOK_STATE
        .get_or_init(|| {
            Arc::new(Mutex::new(HookState {
                mouse_hook: None,
                keyboard_hook: None,
                is_running: false,
                app_handle: None,
                self_pid: 0,
            }))
        })
        .clone()
}

/// 获取指定坐标的窗口信息
unsafe fn get_window_at_point(x: i32, y: i32) -> (i64, String) {
    let point = POINT { x, y };
    let hwnd = WindowFromPoint(point);

    if hwnd.0.is_null() {
        return (0, String::new());
    }

    let mut title_buf = [0u16; 256];
    let len = GetWindowTextW(hwnd, &mut title_buf);
    let title = String::from_utf16_lossy(&title_buf[..len as usize]);

    (hwnd.0 as i64, title)
}

/// 检查指定 HWND 是否属于当前进程（安全区过滤）
/// 往上找到顶层窗口再比 PID，因为 Tauri 的 WebView2 子窗口 (Chrome Legacy Window) 的 PID 和主进程不同
unsafe fn is_own_window(hwnd: HWND, self_pid: u32) -> bool {
    if hwnd.0.is_null() || self_pid == 0 {
        return false;
    }
    let top = GetAncestor(hwnd, GA_ROOT);
    let target = if top.0.is_null() { hwnd } else { top };
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(target, Some(&mut pid));
    pid == self_pid
}

/// 获取修饰键状态
unsafe fn get_modifiers() -> Vec<String> {
    let mut modifiers = Vec::new();

    if GetKeyState(VK_SHIFT.0 as i32) & 0x8000u16 as i16 != 0 {
        modifiers.push("Shift".to_string());
    }
    if GetKeyState(VK_CONTROL.0 as i32) & 0x8000u16 as i16 != 0 {
        modifiers.push("Ctrl".to_string());
    }
    if GetKeyState(VK_MENU.0 as i32) & 0x8000u16 as i16 != 0 {
        modifiers.push("Alt".to_string());
    }
    if GetKeyState(VK_LWIN.0 as i32) & 0x8000u16 as i16 != 0
        || GetKeyState(VK_RWIN.0 as i32) & 0x8000u16 as i16 != 0
    {
        modifiers.push("Win".to_string());
    }

    modifiers
}

/// 虚拟键码转字符串
fn vk_to_string(vk: u16) -> String {
    match vk {
        0x08 => "Backspace".to_string(),
        0x09 => "Tab".to_string(),
        0x0D => "Enter".to_string(),
        0x10 => "Shift".to_string(),
        0x11 => "Ctrl".to_string(),
        0x12 => "Alt".to_string(),
        0x13 => "Pause".to_string(),
        0x14 => "CapsLock".to_string(),
        0x1B => "Escape".to_string(),
        0x20 => "Space".to_string(),
        0x21 => "PageUp".to_string(),
        0x22 => "PageDown".to_string(),
        0x23 => "End".to_string(),
        0x24 => "Home".to_string(),
        0x25 => "Left".to_string(),
        0x26 => "Up".to_string(),
        0x27 => "Right".to_string(),
        0x28 => "Down".to_string(),
        0x2C => "PrintScreen".to_string(),
        0x2D => "Insert".to_string(),
        0x2E => "Delete".to_string(),
        0x5B => "LWin".to_string(),
        0x5C => "RWin".to_string(),
        0x60 => "Numpad0".to_string(),
        0x61 => "Numpad1".to_string(),
        0x62 => "Numpad2".to_string(),
        0x63 => "Numpad3".to_string(),
        0x64 => "Numpad4".to_string(),
        0x65 => "Numpad5".to_string(),
        0x66 => "Numpad6".to_string(),
        0x67 => "Numpad7".to_string(),
        0x68 => "Numpad8".to_string(),
        0x69 => "Numpad9".to_string(),
        0x6A => "Multiply".to_string(),
        0x6B => "Add".to_string(),
        0x6C => "Separator".to_string(),
        0x6D => "Subtract".to_string(),
        0x6E => "Decimal".to_string(),
        0x6F => "Divide".to_string(),
        0x70 => "F1".to_string(),
        0x71 => "F2".to_string(),
        0x72 => "F3".to_string(),
        0x73 => "F4".to_string(),
        0x74 => "F5".to_string(),
        0x75 => "F6".to_string(),
        0x76 => "F7".to_string(),
        0x77 => "F8".to_string(),
        0x78 => "F9".to_string(),
        0x79 => "F10".to_string(),
        0x7A => "F11".to_string(),
        0x7B => "F12".to_string(),
        0x90 => "NumLock".to_string(),
        0x91 => "ScrollLock".to_string(),
        0xA0 => "LShift".to_string(),
        0xA1 => "RShift".to_string(),
        0xA2 => "LCtrl".to_string(),
        0xA3 => "RCtrl".to_string(),
        0xA4 => "LAlt".to_string(),
        0xA5 => "RAlt".to_string(),
        _ => {
            // 尝试获取字符
            let ch = vk as u8;
            if ch.is_ascii_graphic() || ch == b' ' {
                (ch as char).to_string()
            } else {
                format!("VK_{:02X}", vk)
            }
        }
    }
}

/// 鼠标钩子回调
unsafe extern "system" fn mouse_hook_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if n_code >= 0 {
        let mouse_struct = *(l_param.0 as *const MSLLHOOKSTRUCT);
        let x = mouse_struct.pt.x;
        let y = mouse_struct.pt.y;

        let state = get_hook_state();
        let state_guard = state.lock().unwrap();

        // 只处理点击事件，忽略鼠标移动 (WM_MOUSEMOVE) 等
        let wpm = w_param.0 as u32;
        if wpm != WM_LBUTTONDOWN && wpm != WM_RBUTTONDOWN && wpm != WM_LBUTTONDBLCLK {
            return CallNextHookEx(None, n_code, w_param, l_param);
        }

        if state_guard.is_running {
            if let Some(ref app_handle) = state_guard.app_handle {
                let (hwnd, window_title) = get_window_at_point(x, y);

                // 获取顶层窗口 PID（WebView2 子窗口的 PID 和主进程不同）
                let top_hwnd = if hwnd != 0 { GetAncestor(HWND(hwnd as *mut _), GA_ROOT) } else { HWND(std::ptr::null_mut()) };
                let pid_hwnd = if top_hwnd.0.is_null() { HWND(hwnd as *mut _) } else { top_hwnd };
                let mut target_pid: u32 = 0;
                GetWindowThreadProcessId(pid_hwnd, Some(&mut target_pid));

                // 安全区：过滤自身窗口事件
                if is_own_window(HWND(hwnd as *mut _), state_guard.self_pid) {
                    log::info!("[SafeZone] BLOCKED mouse — hwnd={:#x} title=\"{}\" pid={} self={}", hwnd, window_title, target_pid, state_guard.self_pid);
                    return CallNextHookEx(None, n_code, w_param, l_param);
                }

                let event = match wpm {
                    WM_LBUTTONDOWN => {
                        log::info!("[GlobalListener] click @ ({},{}) title=\"{}\" pid={}", x, y, window_title, target_pid);
                        Some(GlobalInputEvent {
                            event_type: "mouse_click".to_string(),
                            x,
                            y,
                            key: None,
                            modifiers: get_modifiers(),
                            hwnd,
                            window_title,
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64,
                        })
                    }
                    WM_RBUTTONDOWN => {
                        log::info!("[GlobalListener] right_click @ ({},{}) title=\"{}\" pid={}", x, y, window_title, target_pid);
                        Some(GlobalInputEvent {
                            event_type: "mouse_right_click".to_string(),
                            x,
                            y,
                            key: None,
                            modifiers: get_modifiers(),
                            hwnd,
                            window_title,
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64,
                        })
                    }
                    WM_LBUTTONDBLCLK => {
                        log::info!("[GlobalListener] dblclick @ ({},{}) title=\"{}\" pid={}", x, y, window_title, target_pid);
                        Some(GlobalInputEvent {
                            event_type: "mouse_double_click".to_string(),
                            x,
                            y,
                            key: None,
                            modifiers: get_modifiers(),
                            hwnd,
                            window_title,
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64,
                        })
                    }
                    _ => None,
                };

                if let Some(event) = event {
                    let _ = app_handle.emit("global-input-event", &event);
                }
            }
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
}

/// 键盘钩子回调
unsafe extern "system" fn keyboard_hook_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if n_code >= 0 {
        let kb_struct = *(l_param.0 as *const KBDLLHOOKSTRUCT);
        let vk_code = kb_struct.vkCode as u16;

        let state = get_hook_state();
        let state_guard = state.lock().unwrap();

        if state_guard.is_running {
            if let Some(ref app_handle) = state_guard.app_handle {
                // 获取前台窗口（GetFocus 只能获取同线程焦点，跨进程需要用 GetForegroundWindow）
                let hwnd = GetForegroundWindow();

                // 安全区：过滤自身窗口事件
                if is_own_window(hwnd, state_guard.self_pid) {
                    log::info!("[SafeZone] BLOCKED key — key={} self_pid={}", vk_code, state_guard.self_pid);
                    return CallNextHookEx(None, n_code, w_param, l_param);
                }

                let mut target_pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut target_pid));

                let mut title_buf = [0u16; 256];
                let len = GetWindowTextW(hwnd, &mut title_buf);
                let window_title = String::from_utf16_lossy(&title_buf[..len as usize]);

                log::info!("[GlobalListener] key hwnd={:#x} title=\"{}\" pid={} vk={}", hwnd.0 as i64, window_title, target_pid, vk_code);

                // 获取鼠标位置
                let mut cursor_pos = POINT { x: 0, y: 0 };
                let _ = GetCursorPos(&mut cursor_pos);

                let key = vk_to_string(vk_code);
                let modifiers = get_modifiers();

                let event = match w_param.0 as u32 {
                    WM_KEYDOWN | WM_SYSKEYDOWN => {
                        Some(GlobalInputEvent {
                            event_type: "key_down".to_string(),
                            x: cursor_pos.x,
                            y: cursor_pos.y,
                            key: Some(key),
                            modifiers,
                            hwnd: hwnd.0 as i64,
                            window_title,
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64,
                        })
                    }
                    WM_KEYUP | WM_SYSKEYUP => {
                        Some(GlobalInputEvent {
                            event_type: "key_up".to_string(),
                            x: cursor_pos.x,
                            y: cursor_pos.y,
                            key: Some(key),
                            modifiers,
                            hwnd: hwnd.0 as i64,
                            window_title,
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64,
                        })
                    }
                    _ => None,
                };

                if let Some(event) = event {
                    let _ = app_handle.emit("global-input-event", &event);
                }
            }
        }
    }

    CallNextHookEx(None, n_code, w_param, l_param)
}

/// 启动全局事件监听
#[tauri::command]
pub fn start_global_listener(app_handle: AppHandle) -> Result<(), String> {
    let state = get_hook_state();
    let mut state_guard = state.lock().unwrap();

    if state_guard.is_running {
        return Ok(());
    }

    unsafe {
        // 记录当前进程 PID（用于安全区过滤）
        state_guard.self_pid = GetCurrentProcessId();
        log::info!("[GlobalListener] Starting — self_pid={}", state_guard.self_pid);

        // 安装鼠标钩子
        let mouse_hook = SetWindowsHookExW(
            WH_MOUSE_LL,
            Some(mouse_hook_proc),
            None,
            0,
        ).map_err(|e| format!("Failed to install mouse hook: {}", e))?;

        // 安装键盘钩子
        let keyboard_hook = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard_hook_proc),
            None,
            0,
        ).map_err(|e| format!("Failed to install keyboard hook: {}", e))?;

        state_guard.mouse_hook = Some(mouse_hook);
        state_guard.keyboard_hook = Some(keyboard_hook);
        state_guard.is_running = true;
        state_guard.app_handle = Some(app_handle);
    }

    println!("[GlobalListener] Started");
    Ok(())
}

/// 停止全局事件监听
#[tauri::command]
pub fn stop_global_listener() -> Result<(), String> {
    let state = get_hook_state();
    let mut state_guard = state.lock().unwrap();

    if !state_guard.is_running {
        return Ok(());
    }

    unsafe {
        if let Some(hook) = state_guard.mouse_hook.take() {
            let _ = UnhookWindowsHookEx(hook);
        }
        if let Some(hook) = state_guard.keyboard_hook.take() {
            let _ = UnhookWindowsHookEx(hook);
        }
    }

    state_guard.is_running = false;
    state_guard.app_handle = None;

    println!("[GlobalListener] Stopped");
    Ok(())
}

/// 检查全局监听是否正在运行
#[tauri::command]
pub fn is_global_listener_running() -> bool {
    let state = get_hook_state();
    let state_guard = state.lock().unwrap();
    state_guard.is_running
}
