// 来源: lib/services/desktop/desktop_native_service.dart — getWindows/focusWindow

use serde::Serialize;
use windows::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    PostMessageW, SetForegroundWindow, SetWindowPos, ShowWindow,
    SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SWP_NOZORDER, WM_CLOSE,
};

#[derive(Debug, Clone, Serialize)]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub hwnd: i64,
    pub title: String,
    pub class_name: String,
    pub is_visible: bool,
    pub process_id: u32,
    pub app_name: String,
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub width: i32,
    pub height: i32,
}

/// 从 process_id 获取进程可执行文件名（不含路径），如 "WeChat.exe"
fn get_process_name(process_id: u32) -> String {
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) {
            Ok(handle) => {
                let mut buf = vec![0u16; 512];
                let mut size = buf.len() as u32;
                let pw = windows::core::PWSTR(buf.as_mut_ptr());
                let result = windows::Win32::System::Threading::QueryFullProcessImageNameW(
                    handle,
                    windows::Win32::System::Threading::PROCESS_NAME_WIN32,
                    pw,
                    &mut size,
                );
                let _ = windows::Win32::Foundation::CloseHandle(handle);
                if result.is_ok() && size > 0 {
                    let path = String::from_utf16_lossy(&buf[..size as usize]);
                    // 取最后一段文件名
                    path.rsplit('\\').next().unwrap_or(&path).to_string()
                } else {
                    String::new()
                }
            }
            Err(_) => String::new(),
        }
    }
}

struct EnumState {
    windows: Vec<WindowInfo>,
}

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, l_param: LPARAM) -> BOOL {
    let state = &mut *(l_param.0 as *mut EnumState);

    if IsWindowVisible(hwnd).as_bool() == false {
        return BOOL(1);
    }

    let title_len = GetWindowTextLengthW(hwnd);
    if title_len == 0 {
        return BOOL(1);
    }

    let mut title_buf = vec![0u16; (title_len + 1) as usize];
    let read = GetWindowTextW(hwnd, &mut title_buf);
    let title = String::from_utf16_lossy(&title_buf[..read as usize]);
    if title.is_empty() {
        return BOOL(1);
    }

    let mut class_buf = vec![0u16; 256];
    let class_len = GetClassNameW(hwnd, &mut class_buf);
    let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);

    let mut rect = Default::default();
    let _ = GetWindowRect(hwnd, &mut rect);

    let mut process_id = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut process_id));

    let app_name = get_process_name(process_id);

    state.windows.push(WindowInfo {
        hwnd: hwnd.0 as i64,
        title,
        class_name,
        is_visible: true,
        process_id,
        app_name,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    });

    BOOL(1)
}

#[tauri::command]
pub fn desktop_list_windows() -> Result<Vec<WindowInfo>, String> {
    let mut state = EnumState { windows: Vec::new() };

    let hwnd_ptr: *mut EnumState = &mut state;
    let result = unsafe {
        EnumWindows(
            Some(enum_windows_callback),
            LPARAM(hwnd_ptr as isize),
        )
    };

    if let Err(e) = result {
        return Err(format!("EnumWindows failed: {e:?}"));
    }

    Ok(state.windows)
}

#[tauri::command]
pub fn desktop_focus_window(hwnd: i64) -> Result<bool, String> {
    let hwnd = HWND(hwnd as isize as *mut std::ffi::c_void);

    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let result = SetForegroundWindow(hwnd);
        Ok(result.as_bool())
    }
}

#[tauri::command]
pub fn restore_window(hwnd: i64) -> Result<bool, String> {
    let hwnd = HWND(hwnd as isize as *mut std::ffi::c_void);
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            return Ok(true);
        }
        Ok(false)
    }
}

#[tauri::command]
pub fn get_window_bounds(hwnd: i64) -> Result<WindowBounds, String> {
    let hwnd = HWND(hwnd as isize as *mut std::ffi::c_void);

    unsafe {
        let mut rect = Default::default();
        let result = GetWindowRect(hwnd, &mut rect);

        if result.is_err() {
            return Err(format!("GetWindowRect failed for hwnd {}", hwnd.0 as i64));
        }

        Ok(WindowBounds {
            x: rect.left,
            y: rect.top,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        })
    }
}

#[tauri::command]
pub fn desktop_minimize_window(hwnd: i64) -> Result<bool, String> {
    let hwnd = HWND(hwnd as isize as *mut std::ffi::c_void);
    unsafe { Ok(ShowWindow(hwnd, SW_MINIMIZE).as_bool()) }
}

#[tauri::command]
pub fn desktop_maximize_window(hwnd: i64) -> Result<bool, String> {
    let hwnd = HWND(hwnd as isize as *mut std::ffi::c_void);
    unsafe { Ok(ShowWindow(hwnd, SW_MAXIMIZE).as_bool()) }
}

#[tauri::command]
pub fn desktop_close_window(hwnd: i64) -> Result<bool, String> {
    let hwnd = HWND(hwnd as isize as *mut std::ffi::c_void);
    unsafe { Ok(PostMessageW(hwnd, WM_CLOSE, None, None).is_ok()) }
}

#[tauri::command]
pub fn desktop_resize_window(hwnd: i64, width: i32, height: i32) -> Result<bool, String> {
    let hwnd = HWND(hwnd as isize as *mut std::ffi::c_void);
    unsafe {
        Ok(SetWindowPos(
            hwnd,
            HWND::default(),
            0,
            0,
            width,
            height,
            SWP_NOZORDER,
        )
        .is_ok())
    }
}
