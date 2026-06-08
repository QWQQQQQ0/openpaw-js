// App commands — list apps from cached index, launch apps with existing-instance check.

use crate::commands::app_index;
use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    SetForegroundWindow, ShowWindow, SW_RESTORE,
};

/// Collect all visible window hwnds (for detecting new windows after launch).
fn collect_visible_hwnds() -> std::collections::HashSet<i64> {
    let mut hwnds: std::collections::HashSet<i64> = std::collections::HashSet::new();

    struct CollectState {
        hwnds: std::collections::HashSet<i64>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut CollectState);
        if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
            state.hwnds.insert(hwnd.0 as i64);
        }
        BOOL(1)
    }

    let mut state = CollectState { hwnds: std::collections::HashSet::new() };
    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(&mut state as *mut _ as isize));
    }
    state.hwnds
}

/// Find a new visible window that wasn't in the before_hwnds set.
fn find_new_window(before_hwnds: &std::collections::HashSet<i64>) -> Option<i64> {
    let mut result: Option<i64> = None;

    struct FindState {
        before_hwnds: std::collections::HashSet<i64>,
        found: Option<i64>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut FindState);
        if IsWindowVisible(hwnd).as_bool() && GetWindowTextLengthW(hwnd) > 0 {
            let hwnd_val = hwnd.0 as i64;
            if !state.before_hwnds.contains(&hwnd_val) {
                state.found = Some(hwnd_val);
                return BOOL(0); // stop
            }
        }
        BOOL(1)
    }

    let mut state = FindState {
        before_hwnds: before_hwnds.clone(),
        found: None,
    };
    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(&mut state as *mut _ as isize));
    }
    state.found
}

/// Find the first visible top-level window belonging to processes matching `exe_name`.
/// Returns the hwnd as i64 if found.
fn find_hwnd_by_exe(exe_name: &str) -> Option<i64> {
    log::debug!("[find_hwnd_by_exe] Searching for exe_name='{}'", exe_name);

    // Step 1: Find all PIDs with matching executable name via ToolHelp snapshot
    let mut pids: Vec<u32> = Vec::new();
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(e) => {
                log::warn!("[find_hwnd_by_exe] Failed to create snapshot: {:?}", e);
                return None;
            }
        };

        let mut pe = PROCESSENTRY32W::default();
        pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snapshot, &mut pe).is_ok() {
            loop {
                let end = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(pe.szExeFile.len());
                let name = String::from_utf16_lossy(&pe.szExeFile[..end]).to_lowercase();
                if name == exe_name {
                    pids.push(pe.th32ProcessID);
                    log::debug!("[find_hwnd_by_exe] Found matching process: '{}' PID={}", name, pe.th32ProcessID);
                }
                if Process32NextW(snapshot, &mut pe).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }

    if pids.is_empty() {
        log::debug!("[find_hwnd_by_exe] No processes found for '{}'", exe_name);
        return None;
    }

    log::debug!("[find_hwnd_by_exe] Found {} matching PIDs, searching for visible windows...", pids.len());

    // Step 2: Find the first visible window with a title that belongs to one of these PIDs
    struct FindState {
        pids: Vec<u32>,
        found_hwnd: Option<HWND>,
    }

    unsafe extern "system" fn enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut FindState);

        let visible = IsWindowVisible(hwnd).as_bool();
        let title_len = GetWindowTextLengthW(hwnd);

        if !visible {
            return BOOL(1);
        }
        if title_len == 0 {
            return BOOL(1);
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        if state.pids.contains(&pid) {
            log::debug!("[find_hwnd_by_exe] Found matching window: hwnd={:?}, pid={}, title_len={}", hwnd, pid, title_len);
            state.found_hwnd = Some(hwnd);
            return BOOL(0); // stop enumeration
        }
        BOOL(1)
    }

    let mut state = FindState { pids, found_hwnd: None };
    unsafe {
        let _ = EnumWindows(Some(enum_callback), LPARAM(&mut state as *mut _ as isize));
    }

    state.found_hwnd.map(|h| h.0 as i64)
}

/// Check if an app with the given executable is already running.
/// If so, restore its window (if minimized) and return its hwnd.
/// Does NOT steal foreground focus — the float window stays on top.
fn bring_to_front_if_running(exe_path: &str) -> Option<i64> {
    let exe_name = std::path::Path::new(exe_path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    if exe_name.is_empty() {
        return None;
    }

    let hwnd = find_hwnd_by_exe(&exe_name)?;
    let hw = HWND(hwnd as isize as *mut std::ffi::c_void);
    // 只恢复最小化窗口，不强抢焦点（浮窗保持置顶）
    unsafe {
        let _ = ShowWindow(hw, SW_RESTORE);
    }
    Some(hwnd)
}

#[tauri::command]
pub fn desktop_list_apps() -> Result<Vec<app_index::AppInfo>, String> {
    app_index::get_apps_from_disk()
}

/// Launch an app by its path. Handles:
/// - AUMID paths (containing `!`): launches via explorer shell:AppsFolder\<aumid>
/// - cmd:// paths: launches via cmd /c start <name>
/// - Normal paths: launches via Command::new
fn launch_by_path(exe_path: &str) -> Result<std::process::Child, String> {
    if exe_path.contains('!') {
        // Store app AUMID like "Microsoft.Paint_8wekyb3d8bbwe!App"
        let shell_path = format!("shell:AppsFolder\\{}", exe_path);
        std::process::Command::new("explorer.exe")
            .arg(&shell_path)
            .spawn()
            .map_err(|e| format!("Failed to launch Store app '{}': {}", exe_path, e))
    } else if let Some(app_name) = exe_path.strip_prefix("cmd://") {
        // cmd://mspaint → cmd /c start "" mspaint
        std::process::Command::new("cmd")
            .args(["/c", "start", "", app_name])
            .spawn()
            .map_err(|e| format!("Failed to launch '{}': {}", app_name, e))
    } else {
        std::process::Command::new(exe_path)
            .spawn()
            .map_err(|e| format!("Failed to launch '{}': {}", exe_path, e))
    }
}

/// Check if exe_path is a real file path (not AUMID or cmd://).
fn is_file_path(exe_path: &str) -> bool {
    !exe_path.contains('!') && !exe_path.starts_with("cmd://")
}

#[tauri::command]
pub fn desktop_open_app(name: String) -> Result<i64, String> {
    log::info!("[desktop_open_app] name='{}'", name);

    if let Some(exe_path) = app_index::find_app(&name) {
        log::info!("[desktop_open_app] find_app found exe_path='{}', is_file_path={}", exe_path, is_file_path(&exe_path));

        // Check if already running — bring to front if so (only for real exe paths)
        if is_file_path(&exe_path) {
            if let Some(hwnd) = bring_to_front_if_running(&exe_path) {
                log::info!("[desktop_open_app] App already running, hwnd={}", hwnd);
                return Ok(hwnd);
            }
        }

        // 记录启动前的所有窗口 hwnd
        let before_hwnds: std::collections::HashSet<i64> = collect_visible_hwnds();
        log::info!("[desktop_open_app] Before launch: {} visible windows", before_hwnds.len());

        // Launch via appropriate method
        match launch_by_path(&exe_path) {
            Ok(_child) => {
                // Try to find hwnd for real exe paths
                if is_file_path(&exe_path) {
                    let exe_name = std::path::Path::new(&exe_path)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_lowercase())
                        .unwrap_or_default();
                    log::info!("[desktop_open_app] Launched, searching for window with exe_name='{}'", exe_name);
                    for i in 0..10 {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        if let Some(hwnd) = find_hwnd_by_exe(&exe_name) {
                            log::info!("[desktop_open_app] Found hwnd={} at attempt {}", hwnd, i + 1);
                            return Ok(hwnd);
                        }
                    }
                    log::warn!("[desktop_open_app] Failed to find hwnd for '{}' after 10 attempts", exe_name);
                } else {
                    // AUMID/cmd 启动：查找新出现的窗口
                    log::info!("[desktop_open_app] Launched via AUMID/cmd, searching for new window...");
                    for i in 0..10 {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        if let Some(hwnd) = find_new_window(&before_hwnds) {
                            log::info!("[desktop_open_app] Found new window hwnd={} at attempt {}", hwnd, i + 1);
                            return Ok(hwnd);
                        }
                    }
                    log::warn!("[desktop_open_app] Failed to find new window after 10 attempts");
                }
                return Ok(-1);
            }
            Err(e) => {
                log::warn!("Failed to launch '{}' via '{}': {e}, falling back", name, exe_path);
            }
        }
    } else {
        log::warn!("[desktop_open_app] find_app returned None for '{}'", name);
    }

    // Fallback 1: System32 built-in apps (中文名 → exe or cmd://mspaint)
    if let Some(exe_path) = app_index::system32_lookup(&name) {
        log::info!("[desktop_open_app] Fallback to system32: '{}'", exe_path);
        let before_hwnds = collect_visible_hwnds();
        match launch_by_path(&exe_path) {
            Ok(_child) => {
                for i in 0..10 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if let Some(hwnd) = find_new_window(&before_hwnds) {
                        log::info!("[desktop_open_app] Found new window hwnd={} at attempt {}", hwnd, i + 1);
                        return Ok(hwnd);
                    }
                }
                log::warn!("[desktop_open_app] system32 fallback: no new window found");
                return Ok(-1);
            }
            Err(e) => log::warn!("Failed to launch system32 '{}': {e}", exe_path),
        }
    }

    // Fallback 2: cmd /c start for Store apps and unknown names
    log::info!("[desktop_open_app] Fallback to cmd /c start: '{}'", name);
    let before_hwnds = collect_visible_hwnds();
    match std::process::Command::new("cmd")
        .args(["/c", "start", "", &name])
        .spawn()
    {
        Ok(_child) => {
            for i in 0..10 {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if let Some(hwnd) = find_new_window(&before_hwnds) {
                    log::info!("[desktop_open_app] Found new window hwnd={} at attempt {}", hwnd, i + 1);
                    return Ok(hwnd);
                }
            }
            log::warn!("[desktop_open_app] cmd fallback: no new window found");
            Ok(-1)
        }
        Err(e) => Err(format!("Failed to launch '{}': {}", name, e)),
    }
}

#[tauri::command]
pub fn desktop_find_app(name: String) -> Result<Option<String>, String> {
    Ok(app_index::find_app(&name))
}

#[tauri::command]
pub fn desktop_find_app_by_title(title: String) -> Result<Option<String>, String> {
    Ok(app_index::find_app_by_title(&title))
}

#[tauri::command]
pub fn desktop_refresh_apps() -> Result<usize, String> {
    Ok(app_index::build_and_persist())
}
