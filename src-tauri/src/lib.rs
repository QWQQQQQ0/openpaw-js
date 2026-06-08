mod commands;

use tauri::Manager;
use tauri::Emitter;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Force UTF-8 console output on Windows (avoids garbled Chinese text)
  // Safe: SetConsoleOutputCP(65001) = CP_UTF8, always available on Win10+
  let _ = unsafe { windows::Win32::System::Console::SetConsoleOutputCP(65001) };

  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::new().build())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_fs::init())
    .manage(commands::bridge::BridgeState {
      bridge: std::sync::Arc::new(std::sync::Mutex::new(None)),
    })
    .invoke_handler(tauri::generate_handler![
      commands::screenshot::desktop_screenshot,
      commands::screenshot::screenshot_window,
      commands::screenshot::screenshot_window_region,
      commands::input::desktop_click,
      commands::input::desktop_double_click,
      commands::input::desktop_right_click,
      commands::input::desktop_middle_click,
      commands::input::desktop_mouse_down,
      commands::input::desktop_mouse_up,
      commands::input::desktop_drag,
      commands::input::desktop_move_cursor,
      commands::input::desktop_type_text,
      commands::input::desktop_press_key,
      commands::input::desktop_key_down,
      commands::input::desktop_key_up,
      commands::input::desktop_scroll,
      commands::input::desktop_move_mouse,
      commands::input::desktop_get_clipboard,
      commands::input::desktop_set_clipboard,
      commands::window::desktop_list_windows,
      commands::window::desktop_focus_window,
      commands::window::get_window_bounds,
      commands::window::restore_window,
      commands::window::desktop_minimize_window,
      commands::window::desktop_maximize_window,
      commands::window::desktop_close_window,
      commands::window::desktop_resize_window,
      commands::app::desktop_list_apps,
      commands::app::desktop_open_app,
      commands::app::desktop_find_app,
      commands::app::desktop_find_app_by_title,
      commands::app::desktop_refresh_apps,
      commands::bridge::uia_get_interactive,
      commands::bridge::uia_click,
      commands::bridge::uia_type_text,
      commands::bridge::uia_find_element,
      commands::bridge::uia_get_property,
      commands::bridge::uia_fingerprint,
      commands::bridge::uia_find_element_at_point,
      commands::bridge::web_launch,
      commands::bridge::web_navigate,
      commands::bridge::web_get_interactive,
      commands::bridge::web_click_selector,
      commands::bridge::web_click_role,
      commands::bridge::web_fill,
      commands::bridge::web_scroll,
      commands::bridge::web_close,
      commands::bridge::web_start_recording,
      commands::bridge::web_stop_recording,
      commands::bridge::web_get_recorded_events,
      commands::bridge::screenshot_full,
      commands::bridge::screenshot_region,
      commands::bridge::ocr_recognize,
      commands::bridge::word_generate,
      commands::bridge::excel_generate,
      commands::bridge::ppt_generate,
      commands::capture::capture_region,
      commands::image_process::visual_diff,
      commands::image_process::ocr_text_diff,
      commands::image_process::crop_image,
      commands::image_process::compress_to_jpeg,
      commands::image_process::extract_motion_region,
      commands::image_process::compress_uia_tree,
      commands::file_util::save_llm_images,
      commands::file_util::read_file_as_data_url,
      commands::global_listener::start_global_listener,
      commands::global_listener::stop_global_listener,
      commands::global_listener::is_global_listener_running,
      commands::bridge::global_listener_start,
      commands::bridge::global_listener_stop,
      commands::bridge::global_listener_poll,
    ])
    .setup(|app| {
      // Build app index on startup (background, non-blocking)
      std::thread::spawn(|| {
        commands::app_index::build_and_persist();
      });

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // ── System tray ──
      let toggle_item = MenuItemBuilder::with_id("toggle_float", "Show / Hide Assistant")
        .build(app)?;
      let quit_item = MenuItemBuilder::with_id("quit", "Quit OpenPaw")
        .build(app)?;
      let tray_menu = MenuBuilder::new(app)
        .item(&toggle_item)
        .separator()
        .item(&quit_item)
        .build()?;

      let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&tray_menu)
        .on_menu_event(|app, event| {
          match event.id().as_ref() {
            "toggle_float" => {
              if let Some(main) = app.get_webview_window("main") {
                let _ = main.emit("tray-toggle-float", ());
              }
            }
            "quit" => {
              app.exit(0);
            }
            _ => {}
          }
        })
        .on_tray_icon_event(|tray, event| {
          if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
          } = event
          {
            if let Some(main) = tray.app_handle().get_webview_window("main") {
              let _ = main.emit("tray-toggle-float", ());
            }
          }
        })
        .build(app)?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
