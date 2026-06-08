// App index — scans system apps at startup, persists to disk.
// Memory: only a tiny name→path map + aliases. Full data on disk.
//
// All scanners use pure Windows native APIs (COM, Registry, std::fs).
// No PowerShell — avoids GBK/UTF-8 encoding corruption on Chinese Windows.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    IPersistFile, STGM_READ,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

use winreg::enums::*;
use winreg::RegKey;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub app_id: String,
    pub source: String,
    pub path: String,
}

#[derive(Debug, Clone)]
struct AppEntry {
    name: String,
    name_lower: String,
    aliases: Vec<String>,
    exe_path: String,
    app_id: String,
    source: String,
}

// ── Tiny in-memory state (just lookups, not full app list) ──

struct AppLookup {
    name_to_path: HashMap<String, String>,            // name_lower → exe_path
    aliases: HashMap<String, String>,                 // alias_lower → name_lower
    cache_json: Vec<u8>,                              // serialized AppInfo JSON (for list_apps)
}

static APP_LOOKUP: Mutex<Option<AppLookup>> = Mutex::new(None);

fn cache_path() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let dir = PathBuf::from(&appdata).join("openpaw");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("app_cache.json"))
}

fn cache_meta_path() -> Option<PathBuf> {
    cache_path().map(|p| p.parent().unwrap().join("app_cache_meta.json"))
}

const CACHE_STALE_SECS: u64 = 24 * 3600; // full rescan after 24h
const CACHE_FRESH_SECS: u64 = 3600;       // skip scan entirely if < 1h
const CACHE_VERSION: u32 = 2;             // bump when scanner logic changes → force rescan

#[derive(Serialize, Deserialize, Default)]
struct CacheMeta {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    last_scan_epoch: u64,
    #[serde(default)]
    dir_mtimes: HashMap<String, u64>,  // dir_path → mtime in epoch secs
}

fn epoch_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn dir_mtime_secs(path: &str) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn load_cache_meta() -> CacheMeta {
    cache_meta_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cache_meta(meta: &CacheMeta) {
    if let Some(path) = cache_meta_path() {
        if let Ok(json) = serde_json::to_string(meta) {
            let _ = std::fs::write(&path, json);
        }
    }
}

// ── Default Chinese aliases ──

fn default_aliases() -> HashMap<String, String> {
    let mut m = HashMap::new();
    // 系统应用中文别名（确定性映射，不会变）
    m.insert("浏览器".into(), "chrome".into());
    m.insert("谷歌浏览器".into(), "chrome".into());
    m.insert("edge浏览器".into(), "msedge".into());
    m.insert("vscode".into(), "visual studio code".into());
    m.insert("vs code".into(), "visual studio code".into());
    m.insert("code".into(), "visual studio code".into());
    m.insert("代码编辑器".into(), "visual studio code".into());
    m.insert("word".into(), "winword".into());
    m.insert("excel".into(), "excel".into());
    m.insert("ppt".into(), "powerpnt".into());
    m.insert("powerpoint".into(), "powerpnt".into());
    // 系统应用 — 中文名 → 索引中的显示名
    m.insert("画图".into(), "画图".into());
    m.insert("记事本".into(), "记事本".into());
    m.insert("计算器".into(), "计算器".into());
    m.insert("截图".into(), "截图工具".into());
    m.insert("截图工具".into(), "截图工具".into());
    m.insert("远程桌面".into(), "远程桌面".into());
    m.insert("字符映射表".into(), "字符映射表".into());
    m.insert("任务管理器".into(), "任务管理器".into());
    m.insert("注册表".into(), "注册表编辑器".into());
    m.insert("注册表编辑器".into(), "注册表编辑器".into());
    m.insert("命令提示符".into(), "命令提示符".into());
    m.insert("终端".into(), "命令提示符".into());
    m.insert("命令行".into(), "命令提示符".into());
    m.insert("控制面板".into(), "控制面板".into());
    m.insert("系统配置".into(), "系统配置".into());
    m.insert("系统信息".into(), "系统信息".into());
    m.insert("写字板".into(), "写字板".into());
    m.insert("录音机".into(), "录音机".into());
    m.insert("步骤记录器".into(), "步骤记录器".into());
    m.insert("放大镜".into(), "放大镜".into());
    m.insert("屏幕键盘".into(), "屏幕键盘".into());
    m.insert("讲述人".into(), "讲述人".into());
    m.insert("文件管理器".into(), "文件资源管理器".into());
    m.insert("资源管理器".into(), "文件资源管理器".into());
    m.insert("设置".into(), "ms-settings:".into());
    m
}

// ── COM helper — resolve .lnk target path via IShellLinkW ──

fn resolve_shortcut(lnk_path: &std::path::Path) -> String {
    let path_str = lnk_path.to_string_lossy();
    let wide: Vec<u16> = path_str.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let sl: IShellLinkW = match CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) {
            Ok(sl) => sl,
            Err(_) => return String::new(),
        };

        let pf: IPersistFile = match sl.cast() {
            Ok(pf) => pf,
            Err(_) => return String::new(),
        };

        if pf.Load(PCWSTR::from_raw(wide.as_ptr()), STGM_READ).is_err() {
            return String::new();
        }

        if sl.Resolve(HWND::default(), 0u32).is_err() {
            return String::new();
        }

        let mut buf = [0u16; 260];
        if sl.GetPath(&mut buf, std::ptr::null_mut(), 0u32).is_err() {
            return String::new();
        }

        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }
}

// ── Scanner 1: Start Menu + Desktop .lnk shortcuts ──

fn shortcut_root_dirs() -> Vec<String> {
    vec![
        std::env::var("APPDATA").map(|p| format!("{}\\Microsoft\\Windows\\Start Menu\\Programs", p)).unwrap_or_default(),
        std::env::var("PROGRAMDATA").map(|p| format!("{}\\Microsoft\\Windows\\Start Menu\\Programs", p)).unwrap_or_default(),
        std::env::var("USERPROFILE").map(|p| format!("{}\\Desktop", p)).unwrap_or_default(),
        r"C:\Users\Public\Desktop".to_string(),
    ]
}

fn scan_shortcuts() -> Vec<AppEntry> {
    let mut apps: Vec<AppEntry> = Vec::new();
    let mut seen: HashMap<String, bool> = HashMap::new();

    for dir in &shortcut_root_dirs() {
        walk_lnk_dir(dir, &mut apps, &mut seen);
    }

    apps
}

/// Load cached apps from disk into APP_LOOKUP (no scanning).
fn load_apps_into_memory() -> Result<usize, String> {
    if let Some(path) = cache_path() {
        if let Ok(data) = std::fs::read(&path) {
            if let Ok(list) = serde_json::from_slice::<Vec<AppInfo>>(&data) {
                let count = list.len();
                let mut name_to_path: HashMap<String, String> = HashMap::new();
                for entry in &list {
                    if !entry.path.is_empty() {
                        name_to_path.insert(entry.name.to_lowercase(), entry.path.clone());
                    }
                }
                let alias_map = default_aliases();
                let mut flat_aliases: HashMap<String, String> = HashMap::new();
                for (alias, target) in &alias_map {
                    let tl = target.to_lowercase();
                    if name_to_path.contains_key(&tl) || name_to_path.keys().any(|n| n.contains(&tl)) {
                        flat_aliases.insert(alias.to_lowercase(), tl);
                    }
                }
                *APP_LOOKUP.lock().unwrap() = Some(AppLookup {
                    name_to_path,
                    aliases: flat_aliases,
                    cache_json: data,
                });
                return Ok(count);
            }
        }
    }
    Err("No cache on disk".to_string())
}

fn walk_lnk_dir(root: &str, apps: &mut Vec<AppEntry>, seen: &mut HashMap<String, bool>) {
    // Iterative traversal — avoids stack overflow on deep Start Menu trees
    // that can exceed the 2MB default std::thread stack.
    let mut stack: Vec<PathBuf> = vec![PathBuf::from(root)];

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().map_or(false, |e| e.eq_ignore_ascii_case("lnk")) {
                let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if name.is_empty() || seen.contains_key(&name.to_lowercase()) {
                    continue;
                }
                seen.insert(name.to_lowercase(), true);
                let target = resolve_shortcut(&path);
                apps.push(AppEntry {
                    name: name.clone(),
                    name_lower: name.to_lowercase(),
                    aliases: vec![],
                    exe_path: target,
                    app_id: String::new(),
                    source: "shortcut".into(),
                });
            }
        }
    }
}

/// Collect all directory mtimes under root (iterative, non-recursive).
fn collect_dir_mtimes(root: &str, mtimes: &mut HashMap<String, u64>) {
    mtimes.insert(root.to_string(), dir_mtime_secs(root));
    let mut stack: Vec<PathBuf> = vec![PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let key = path.to_string_lossy().to_string();
                mtimes.insert(key, dir_mtime_secs(&path.to_string_lossy()));
                stack.push(path);
            }
        }
    }
}

/// Only scan directories whose mtime changed since last scan.
fn incremental_scan_shortcuts(
    roots: &[String],
    old_mtimes: &HashMap<String, u64>,
    apps: &mut Vec<AppEntry>,
    seen: &mut HashMap<String, bool>,
) -> HashMap<String, u64> {
    let mut new_mtimes: HashMap<String, u64> = HashMap::new();
    let mut stack: Vec<PathBuf> = roots.iter().map(PathBuf::from).collect();

    while let Some(dir) = stack.pop() {
        let dir_key = dir.to_string_lossy().to_string();
        let current_mtime = dir_mtime_secs(&dir_key);
        new_mtimes.insert(dir_key.clone(), current_mtime);

        // Skip unchanged directories (unless root — always scan roots)
        if old_mtimes.get(&dir_key) == Some(&current_mtime) && roots.iter().all(|r| *r != dir_key) {
            continue;
        }

        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let sub_key = path.to_string_lossy().to_string();
                new_mtimes.insert(sub_key.clone(), dir_mtime_secs(&sub_key));
                stack.push(path);
            } else if path.extension().map_or(false, |e| e.eq_ignore_ascii_case("lnk")) {
                let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if name.is_empty() || seen.contains_key(&name.to_lowercase()) {
                    continue;
                }
                seen.insert(name.to_lowercase(), true);
                let target = resolve_shortcut(&path);
                apps.push(AppEntry {
                    name: name.clone(),
                    name_lower: name.to_lowercase(),
                    aliases: vec![],
                    exe_path: target,
                    app_id: String::new(),
                    source: "shortcut".into(),
                });
            }
        }
    }
    new_mtimes
}

// ── Scanner 2: Registry Uninstall entries (via winreg) ──

fn scan_registry() -> Vec<AppEntry> {
    let mut apps: Vec<AppEntry> = Vec::new();
    let mut seen: HashMap<String, bool> = HashMap::new();

    let roots = [
        (HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
    ];

    for (hkey, path) in &roots {
        let key = match RegKey::predef(*hkey).open_subkey_with_flags(path, KEY_READ) {
            Ok(k) => k,
            Err(_) => continue,
        };
        for subkey_name in key.enum_keys().flatten() {
            if seen.contains_key(&subkey_name.to_lowercase()) {
                continue;
            }
            let subkey = match key.open_subkey_with_flags(&subkey_name, KEY_READ) {
                Ok(k) => k,
                Err(_) => continue,
            };
            let display_name: String = subkey.get_value("DisplayName").unwrap_or_default();
            if display_name.is_empty() || seen.contains_key(&display_name.to_lowercase()) {
                continue;
            }
            seen.insert(display_name.to_lowercase(), true);
            apps.push(AppEntry {
                name: display_name.clone(),
                name_lower: display_name.to_lowercase(),
                aliases: vec![],
                exe_path: String::new(),
                app_id: String::new(),
                source: "registry".into(),
            });
        }
    }
    apps
}

// ── Scanner 3: Program Files directories (std::fs, no encoding issues) ──

fn scan_program_files() -> Vec<AppEntry> {
    let mut apps: Vec<AppEntry> = Vec::new();
    let mut seen: HashMap<String, bool> = HashMap::new();

    for base in &[r"C:\Program Files", r"C:\Program Files (x86)"] {
        let entries = match std::fs::read_dir(base) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if name.is_empty() || seen.contains_key(&name.to_lowercase()) {
                continue;
            }
            let exe_path = path.join(format!("{}.exe", name));
            if exe_path.exists() {
                seen.insert(name.to_lowercase(), true);
                apps.push(AppEntry {
                    name: name.clone(),
                    name_lower: name.to_lowercase(),
                    aliases: vec![],
                    exe_path: exe_path.to_string_lossy().to_string(),
                    app_id: String::new(),
                    source: "program_files".into(),
                });
            }
        }
    }
    apps
}

// ── System32 exe lookup (for desktop_open_app fallback) ──
/// Maps a name (Chinese or exe name) to a System32 exe path, if it exists.
pub fn system32_lookup(name: &str) -> Option<String> {
    let q = name.trim().to_lowercase();
    if q.is_empty() { return None; }

    let known: &[(&str, &[&str])] = &[
        ("mspaint.exe",    &["画图", "mspaint", "paint"]),
        ("notepad.exe",    &["记事本", "notepad"]),
        ("calc.exe",       &["计算器", "calc", "calculator"]),
        ("snippingtool.exe", &["截图工具", "截图", "snippingtool"]),
        ("mstsc.exe",      &["远程桌面", "mstsc"]),
        ("charmap.exe",    &["字符映射表", "charmap"]),
        ("taskmgr.exe",    &["任务管理器", "taskmgr"]),
        ("regedit.exe",    &["注册表编辑器", "注册表", "regedit"]),
        ("cmd.exe",        &["命令提示符", "终端", "命令行", "cmd"]),
        ("powershell.exe", &["powershell"]),
        ("control.exe",    &["控制面板", "control"]),
        ("msconfig.exe",   &["系统配置", "msconfig"]),
        ("dxdiag.exe",     &["directx 诊断工具", "dxdiag"]),
        ("msinfo32.exe",   &["系统信息", "msinfo32"]),
        ("write.exe",      &["写字板", "write"]),
        ("soundrecorder.exe", &["录音机", "soundrecorder"]),
        ("psr.exe",        &["步骤记录器", "psr"]),
        ("magnify.exe",    &["放大镜", "magnify"]),
        ("osk.exe",        &["屏幕键盘", "osk"]),
        ("narrator.exe",   &["讲述人", "narrator"]),
        ("explorer.exe",   &["文件资源管理器", "资源管理器", "文件管理器", "explorer"]),
    ];

    for (exe, keywords) in known {
        if keywords.iter().any(|kw| *kw == q || q.contains(kw)) {
            let path = format!(r"C:\Windows\System32\{}", exe);
            if std::path::Path::new(&path).exists() {
                return Some(path);
            }
            // Exe not on disk (Store app) — return cmd:// prefix for cmd start launch
            let exe_base = exe.replace(".exe", "");
            return Some(format!("cmd://{}", exe_base));
        }
    }
    None
}

// ── Scanner 4: Common Windows System32 apps ──

fn scan_system32() -> Vec<AppEntry> {
    let mut apps: Vec<AppEntry> = Vec::new();
    let system32 = r"C:\Windows\System32";

    // Common System32 executables with friendly names
    let known_apps: &[(&str, &str)] = &[
        ("mspaint.exe", "画图"),
        ("notepad.exe", "记事本"),
        ("calc.exe", "计算器"),
        ("snippingtool.exe", "截图工具"),
        ("mstsc.exe", "远程桌面"),
        ("charmap.exe", "字符映射表"),
        ("taskmgr.exe", "任务管理器"),
        ("regedit.exe", "注册表编辑器"),
        ("cmd.exe", "命令提示符"),
        ("powershell.exe", "PowerShell"),
        ("control.exe", "控制面板"),
        ("msconfig.exe", "系统配置"),
        ("dxdiag.exe", "DirectX 诊断工具"),
        ("msinfo32.exe", "系统信息"),
        ("write.exe", "写字板"),
        ("soundrecorder.exe", "录音机"),
        ("psr.exe", "步骤记录器"),
        ("magnify.exe", "放大镜"),
        ("osk.exe", "屏幕键盘"),
        ("narrator.exe", "讲述人"),
        ("explorer.exe", "文件资源管理器"),
    ];

    for &(exe_name, display_name) in known_apps {
        let exe_path = format!(r"{}\{}", system32, exe_name);
        let exists = std::path::Path::new(&exe_path).exists();
        let exe_base = exe_name.replace(".exe", "");
        apps.push(AppEntry {
            name: display_name.to_string(),
            name_lower: display_name.to_lowercase(),
            aliases: vec![exe_base.to_lowercase()],
            // If exe exists, use full path; otherwise store cmd:// prefix for later launching
            exe_path: if exists { exe_path } else { format!("cmd://{}", exe_base) },
            app_id: String::new(),
            source: "system32".into(),
        });
    }

    apps
}

// ── Scanner 5: All apps via Get-StartApps (includes Store apps) ──

fn scan_store_apps() -> Vec<AppEntry> {
    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NoLogo",
            "-Command",
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;Get-StartApps|ConvertTo-Json -Compress",
        ])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            #[derive(Deserialize)]
            struct SA {
                #[serde(rename = "Name")]
                name: Option<String>,
                #[serde(rename = "AppID")]
                app_id: Option<String>,
            }

            let json = String::from_utf8_lossy(&out.stdout);
            match serde_json::from_str::<Vec<SA>>(&json) {
                Ok(list) => {
                    let mut apps: Vec<AppEntry> = Vec::new();
                    for sa in list {
                        let name = sa.name.unwrap_or_default().trim().to_string();
                        let app_id = sa.app_id.unwrap_or_default().trim().to_string();
                        if name.is_empty() || app_id.is_empty() {
                            continue;
                        }
                        // Check if AUMID (Store app) or path (traditional app)
                        let (exe_path, source) = if app_id.contains('!') {
                            // Store app AUMID like "Microsoft.Paint_8wekyb3d8bbwe!App"
                            (app_id, "store_app")
                        } else {
                            // Traditional app — path or AUMID without '!'
                            (app_id, "start_app")
                        };
                        apps.push(AppEntry {
                            name: name.clone(),
                            name_lower: name.to_lowercase(),
                            aliases: vec![],
                            exe_path,
                            app_id: String::new(),
                            source: source.into(),
                        });
                    }
                    log::info!(
                        "scan_store_apps: found {} apps via Get-StartApps",
                        apps.len()
                    );
                    return apps;
                }
                Err(e) => log::warn!("scan_store_apps: failed to parse JSON: {e}"),
            }
        }
        Ok(out) => log::warn!(
            "scan_store_apps: PowerShell exited with {:?}",
            out.status.code()
        ),
        Err(e) => log::warn!("scan_store_apps: failed to run PowerShell: {e}"),
    }
    Vec::new()
}

// ── Build + persist to disk ──

fn load_user_aliases() -> HashMap<String, String> {
    if let Some(path) = cache_path() {
        let alias_path = path.parent().unwrap().join("aliases.json");
        if let Ok(content) = std::fs::read_to_string(&alias_path) {
            if let Ok(ua) = serde_json::from_str::<HashMap<String, String>>(&content) {
                return ua;
            }
        }
    }
    HashMap::new()
}

pub fn build_and_persist() -> usize {
    // Initialize COM for IShellLinkW (needed on background threads)
    unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }

    // ── Fast path: load from disk cache if fresh ──
    let meta = load_cache_meta();
    let age = epoch_secs().saturating_sub(meta.last_scan_epoch);

    let (shortcuts, pf_apps, registry_apps, new_meta);

    let version_ok = meta.version >= CACHE_VERSION;

    if version_ok && age < CACHE_FRESH_SECS {
        // Cache very fresh (< 1h) — just load from disk, no scanning at all
        log::info!("App index: cache v{} age={}s (<{}s), loading from disk, skipping scan", meta.version, age, CACHE_FRESH_SECS);
        let _ = load_apps_into_memory();
        unsafe { CoUninitialize(); }
        return APP_LOOKUP.lock().ok().and_then(|g| g.as_ref().map(|l| {
            serde_json::from_slice::<Vec<AppInfo>>(&l.cache_json).map(|v| v.len()).unwrap_or(0)
        })).unwrap_or(0);
    } else if version_ok && age < CACHE_STALE_SECS && !meta.dir_mtimes.is_empty() {
        // Cache exists but aging (1-24h) — incremental shortcut scan + full registry/pf
        log::info!("App index: cache age={}s, incremental scan", age);
        let roots = shortcut_root_dirs();
        let mut seen: HashMap<String, bool> = HashMap::new();
        let mut inc_shortcuts: Vec<AppEntry> = Vec::new();
        let updated_mtimes = incremental_scan_shortcuts(&roots, &meta.dir_mtimes, &mut inc_shortcuts, &mut seen);
        log::info!("App index: incremental scan found {} new shortcuts", inc_shortcuts.len());

        // Merge with cached shortcuts — load existing from disk, overlay new ones
        if let Ok(cached) = get_apps_from_disk() {
            for info in cached {
                let name_lower = info.name.to_lowercase();
                if !seen.contains_key(&name_lower) {
                    seen.insert(name_lower.clone(), true);
                    inc_shortcuts.push(AppEntry {
                        name: info.name.clone(),
                        name_lower,
                        aliases: vec![],
                        exe_path: info.path,
                        app_id: info.app_id,
                        source: info.source,
                    });
                }
            }
            log::info!("App index: merged with cache, total shortcuts={}", inc_shortcuts.len());
        }

        shortcuts = inc_shortcuts;
        pf_apps = scan_program_files();
        registry_apps = scan_registry();
        new_meta = CacheMeta { version: CACHE_VERSION, last_scan_epoch: epoch_secs(), dir_mtimes: updated_mtimes };
    } else {
        // Cache stale / missing / version mismatch — full scan
        log::info!("App index: cache v{} age={}s (stale or version mismatch), full scan", meta.version, age);
        shortcuts = scan_shortcuts();
        pf_apps = scan_program_files();
        registry_apps = scan_registry();

        let roots = shortcut_root_dirs();
        let mut dir_mtimes: HashMap<String, u64> = HashMap::new();
        for root in &roots {
            collect_dir_mtimes(root, &mut dir_mtimes);
        }
        new_meta = CacheMeta { version: CACHE_VERSION, last_scan_epoch: epoch_secs(), dir_mtimes };
    }

    let sys32_apps = scan_system32();
    let store_apps = scan_store_apps();
    log::info!(
        "App index scan: shortcuts={} program_files={} registry={} system32={} store_apps={}",
        shortcuts.len(),
        pf_apps.len(),
        registry_apps.len(),
        sys32_apps.len(),
        store_apps.len(),
    );

    let mut apps: Vec<AppEntry> = Vec::new();
    let mut seen: HashMap<String, bool> = HashMap::new();

    // Priority: shortcuts (have .exe paths) > pf_apps > system32 > store_apps > registry
    for entry in shortcuts
        .into_iter()
        .chain(pf_apps)
        .chain(sys32_apps)
        .chain(store_apps)
        .chain(registry_apps)
    {
        if seen.contains_key(&entry.name_lower) {
            if !entry.exe_path.is_empty() {
                if let Some(existing) = apps.iter_mut().find(|a| a.name_lower == entry.name_lower) {
                    let existing_is_cmd = existing.exe_path.starts_with("cmd://");
                    let new_is_aumid = entry.exe_path.contains('!');
                    // Replace if existing is empty, or if existing is cmd:// and new is AUMID
                    if existing.exe_path.is_empty()
                        || (existing_is_cmd && new_is_aumid)
                    {
                        *existing = entry;
                    }
                }
            }
            continue;
        }
        seen.insert(entry.name_lower.clone(), true);
        apps.push(entry);
    }

    // Merge default + user aliases
    let mut alias_map = default_aliases();
    for (k, v) in load_user_aliases() { alias_map.entry(k).or_insert(v); }

    for (alias, target) in &alias_map {
        let tl = target.to_lowercase();
        if let Some(entry) = apps.iter_mut().find(|a| a.name_lower == tl || a.name_lower.contains(&tl) || tl.contains(&a.name_lower)) {
            if !entry.aliases.contains(alias) { entry.aliases.push(alias.clone()); }
        }
    }

    apps.sort_by(|a, b| a.name_lower.cmp(&b.name_lower));

    // Build AppInfo list for disk
    let info_list: Vec<AppInfo> = apps.iter().map(|e| AppInfo {
        name: e.name.clone(), app_id: e.app_id.clone(), source: e.source.clone(), path: e.exe_path.clone(),
    }).collect();

    // Persist full data to disk
    if let Some(path) = cache_path() {
        if let Ok(json) = serde_json::to_vec(&info_list) {
            let _ = std::fs::write(&path, &json);
        }
    }

    // Build tiny in-memory lookup
    let mut name_to_path: HashMap<String, String> = HashMap::new();
    let mut flat_aliases: HashMap<String, String> = HashMap::new();
    for entry in &apps {
        if !entry.exe_path.is_empty() {
            name_to_path.insert(entry.name_lower.clone(), entry.exe_path.clone());
        }
        for alias in &entry.aliases {
            flat_aliases.insert(alias.to_lowercase(), entry.name_lower.clone());
        }
    }

    let count = info_list.len();
    let cache_json = serde_json::to_vec(&info_list).unwrap_or_default();
    *APP_LOOKUP.lock().unwrap() = Some(AppLookup { name_to_path, aliases: flat_aliases, cache_json });

    save_cache_meta(&new_meta);
    unsafe { CoUninitialize(); }

    log::info!("App index: {} apps saved to disk", count);
    count
}

// ── Read from disk (for list_apps — no memory overhead) ──

pub fn get_apps_from_disk() -> Result<Vec<AppInfo>, String> {
    if let Some(path) = cache_path() {
        if let Ok(data) = std::fs::read(&path) {
            if let Ok(list) = serde_json::from_slice::<Vec<AppInfo>>(&data) {
                return Ok(list);
            }
        }
    }
    // Fall back to cached JSON in memory
    if let Some(ref lookup) = *APP_LOOKUP.lock().unwrap() {
        if let Ok(list) = serde_json::from_slice::<Vec<AppInfo>>(&lookup.cache_json) {
            return Ok(list);
        }
    }
    Err("App index not built yet".to_string())
}

// ── Fuzzy match (uses tiny in-memory lookup) ──

pub fn find_app(query: &str) -> Option<String> {
    let guard = APP_LOOKUP.lock().unwrap();
    let lookup = guard.as_ref()?;
    let q = query.trim().to_lowercase();
    if q.is_empty() { return None; }

    // 1. Exact alias key match → canonical name → path
    if let Some(name) = lookup.aliases.get(&q) {
        if let Some(path) = lookup.name_to_path.get(name) { return Some(path.clone()); }
    }
    // 2. Exact name match
    if let Some(path) = lookup.name_to_path.get(&q) { return Some(path.clone()); }
    // 3. Name contains query (e.g. q="chrome" matches "google chrome")
    if let Some((_, path)) = lookup.name_to_path.iter().find(|(n, _)| n.contains(&q)) {
        return Some(path.clone());
    }
    // 4. Alias key contains query
    if let Some((_, name)) = lookup.aliases.iter().find(|(a, _)| a.contains(&q)) {
        if let Some(path) = lookup.name_to_path.get(name) { return Some(path.clone()); }
    }
    // 5. Query contains a name (e.g. q="open wechat" matches name="微信" via user alias)
    if let Some((name, path)) = lookup.name_to_path.iter().find(|(n, _)| q.contains(*n)) {
        return Some(path.clone());
    }
    // 6. Fuzzy: split query into tokens, try each as alias key → name → path
    for token in q.split_whitespace() {
        if token.len() < 2 { continue; }
        if let Some(name) = lookup.aliases.get(token) {
            if let Some(path) = lookup.name_to_path.get(name) { return Some(path.clone()); }
        }
        if let Some(path) = lookup.name_to_path.get(token) { return Some(path.clone()); }
        if let Some((_, path)) = lookup.name_to_path.iter().find(|(n, _)| n.contains(token)) {
            return Some(path.clone());
        }
    }
    None
}

/// Reverse match: check if any known app name/alias is contained within `window_title`.
/// Used for matching window titles like "Visual Studio Code - myproject" against app "visual studio code".
pub fn find_app_by_title(window_title: &str) -> Option<String> {
    let guard = APP_LOOKUP.lock().unwrap();
    let lookup = guard.as_ref()?;
    let title = window_title.trim().to_lowercase();
    if title.is_empty() { return None; }

    // 1. Alias contained in title → resolve to name → lookup path
    for (alias, name) in &lookup.aliases {
        if !alias.is_empty() && title.contains(alias.as_str()) {
            if let Some(path) = lookup.name_to_path.get(name) { return Some(path.clone()); }
        }
    }
    // 2. Name contained in title
    for (name, path) in &lookup.name_to_path {
        if !name.is_empty() && title.contains(name.as_str()) {
            return Some(path.clone());
        }
    }
    None
}
