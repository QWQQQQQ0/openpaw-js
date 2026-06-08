// Full-screen capture (deprecated — use Python mss via screenshot_full).
// Kept for backwards compatibility.

use super::gdi_utils::{self, encode_bmp_data_url, is_uniform_pixels};
use windows::Win32::Graphics::Gdi::{BitBlt, GetDC, GetWindowDC, ReleaseDC, SelectObject, SRCCOPY};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, GetWindowRect, SM_CXSCREEN, SM_CYSCREEN};

// PrintWindow is not exposed by the `windows` crate; declare via raw FFI.
// PW_RENDERFULLCONTENT = 0x00000002
extern "system" {
    fn PrintWindow(hwnd: *mut core::ffi::c_void, hdc: *mut core::ffi::c_void, nFlags: u32) -> i32;
}

#[tauri::command]
pub fn desktop_screenshot() -> Result<String, String> {
    let (width, height) = unsafe {
        (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN))
    };

    let (hdc, _screen_dc) = gdi_utils::get_screen_dc()?;
    let (h_mem_dc, _mem_dc, h_bitmap, _bitmap) = gdi_utils::create_mem_dc(hdc, width, height)?;

    let old_bitmap = unsafe { SelectObject(h_mem_dc, h_bitmap) };
    let _ = unsafe { BitBlt(h_mem_dc, 0, 0, width, height, hdc, 0, 0, SRCCOPY) };

    let mut pixels = gdi_utils::get_bitmap_pixels(h_mem_dc, h_bitmap, width, height);

    unsafe { SelectObject(h_mem_dc, old_bitmap) };
    // Guards clean up: h_mem_dc, h_bitmap, hdc

    // BMP 32bpp 原生格式为 BGRA，保持 BGRA 不做通道互换，只确保 alpha=255
    for i in (0..pixels.len()).step_by(4) {
        pixels[i + 3] = 255;
    }

    Ok(encode_bmp_data_url(&pixels, width, height))
}

/// Screenshot a specific window by HWND, ignoring other windows that may be on top.
#[tauri::command]
pub fn screenshot_window(hwnd: i64) -> Result<String, String> {
    let win_hwnd = windows::Win32::Foundation::HWND(hwnd as isize as *mut std::ffi::c_void);

    // Get window rect
    let mut rect = windows::Win32::Foundation::RECT::default();
    unsafe { GetWindowRect(win_hwnd, &mut rect) }
        .map_err(|e| format!("GetWindowRect failed: {e}"))?;

    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;

    if width <= 0 || height <= 0 {
        return Err("Window has zero size".into());
    }

    // Get window DC
    let hdc = unsafe { GetWindowDC(win_hwnd) };
    if hdc.is_invalid() {
        return Err("Failed to get window DC".into());
    }

    let (h_mem_dc, _mem_dc, h_bitmap, _bitmap) = gdi_utils::create_mem_dc(hdc, width, height)?;

    let old_bitmap = unsafe { SelectObject(h_mem_dc, h_bitmap) };

    // Use PrintWindow to capture the window content even if it's occluded
    // PW_RENDERFULLCONTENT = 0x00000002
    let result = unsafe { PrintWindow(win_hwnd.0 as *mut core::ffi::c_void, h_mem_dc.0 as *mut core::ffi::c_void, 0x00000002) };
    if result == 0 {
        // Fallback to BitBlt if PrintWindow fails
        let _ = unsafe { BitBlt(h_mem_dc, 0, 0, width, height, hdc, 0, 0, SRCCOPY) };
    }

    let mut pixels = gdi_utils::get_bitmap_pixels(h_mem_dc, h_bitmap, width, height);

    unsafe { SelectObject(h_mem_dc, old_bitmap) };
    unsafe { let _ = ReleaseDC(win_hwnd, hdc); }

    // BMP 32bpp 原生格式为 BGRA，保持 BGRA 不做通道互换，只确保 alpha=255
    for i in (0..pixels.len()).step_by(4) {
        pixels[i + 3] = 255;
    }

    // Check if PrintWindow returned blank/gray content
    if gdi_utils::is_uniform_pixels(&pixels, width, height) {
        eprintln!("[screenshot] PrintWindow 返回全灰，回退到屏幕 BitBlt");
        let screen_hdc = unsafe { GetDC(None) };
        if !screen_hdc.is_invalid() {
            let (h_mem_dc2, _mem_dc2, h_bitmap2, _bitmap2) = gdi_utils::create_mem_dc(screen_hdc, width, height)?;
            let old_bmp2 = unsafe { SelectObject(h_mem_dc2, h_bitmap2) };
            let _ = unsafe { BitBlt(h_mem_dc2, 0, 0, width, height, screen_hdc, rect.left, rect.top, SRCCOPY) };
            pixels = gdi_utils::get_bitmap_pixels(h_mem_dc2, h_bitmap2, width, height);
            unsafe { SelectObject(h_mem_dc2, old_bmp2) };
            unsafe { let _ = ReleaseDC(None, screen_hdc); }
        }
    }

    Ok(encode_bmp_data_url(&pixels, width, height))
}

/// Screenshot a sub-region of a window using PrintWindow (occlusion-resistant).
/// Crops the specified region from the full window capture.
/// region_x/y are relative to the window's top-left corner (in pixels).
#[tauri::command]
pub fn screenshot_window_region(hwnd: i64, region_x: i32, region_y: i32, region_w: i32, region_h: i32) -> Result<String, String> {
    let win_hwnd = windows::Win32::Foundation::HWND(hwnd as isize as *mut std::ffi::c_void);

    // Get window rect
    let mut rect = windows::Win32::Foundation::RECT::default();
    unsafe { GetWindowRect(win_hwnd, &mut rect) }
        .map_err(|e| format!("GetWindowRect failed: {e}"))?;

    let win_w = rect.right - rect.left;
    let win_h = rect.bottom - rect.top;

    if win_w <= 0 || win_h <= 0 {
        return Err("Window has zero size".into());
    }

    // Clamp region to window bounds
    // region_w/h == 0 means "full window"
    let rx = region_x.max(0).min(win_w);
    let ry = region_y.max(0).min(win_h);
    let rw = if region_w <= 0 { win_w - rx } else { region_w.min(win_w - rx) };
    let rh = if region_h <= 0 { win_h - ry } else { region_h.min(win_h - ry) };
    let rw = rw.max(1);
    let rh = rh.max(1);

    // Get window DC
    let hdc = unsafe { GetWindowDC(win_hwnd) };
    if hdc.is_invalid() {
        return Err("Failed to get window DC".into());
    }

    // Capture full window via PrintWindow
    let (h_mem_dc, _mem_dc, h_bitmap, _bitmap) = gdi_utils::create_mem_dc(hdc, win_w, win_h)?;
    let old_bitmap = unsafe { SelectObject(h_mem_dc, h_bitmap) };

    // PW_RENDERFULLCONTENT = 0x00000002
    let result = unsafe { PrintWindow(win_hwnd.0 as *mut core::ffi::c_void, h_mem_dc.0 as *mut core::ffi::c_void, 0x00000002) };
    if result == 0 {
        let _ = unsafe { BitBlt(h_mem_dc, 0, 0, win_w, win_h, hdc, 0, 0, SRCCOPY) };
    }

    let full_pixels = gdi_utils::get_bitmap_pixels(h_mem_dc, h_bitmap, win_w, win_h);

    unsafe { SelectObject(h_mem_dc, old_bitmap) };
    unsafe { let _ = ReleaseDC(win_hwnd, hdc); }

    // Check if PrintWindow returned blank/gray content
    // Many modern windows (Electron, UWP, hardware-accelerated) return gray with PrintWindow
    let print_failed = gdi_utils::is_uniform_pixels(&full_pixels, win_w, win_h);
    if print_failed {
        eprintln!("[screenshot] PrintWindow 返回全灰，回退到屏幕 BitBlt");
        // Fall back to screen BitBlt using window's absolute coordinates
        let screen_hdc = unsafe { GetDC(None) };
        if !screen_hdc.is_invalid() {
            let (h_mem_dc2, _mem_dc2, h_bitmap2, _bitmap2) = gdi_utils::create_mem_dc(screen_hdc, rw, rh)?;
            let old_bmp2 = unsafe { SelectObject(h_mem_dc2, h_bitmap2) };
            let _ = unsafe { BitBlt(h_mem_dc2, 0, 0, rw, rh, screen_hdc, rect.left + rx, rect.top + ry, SRCCOPY) };
            let mut fallback_pixels = gdi_utils::get_bitmap_pixels(h_mem_dc2, h_bitmap2, rw, rh);
            unsafe { SelectObject(h_mem_dc2, old_bmp2) };
            unsafe { let _ = ReleaseDC(None, screen_hdc); }

            // encode_jpeg_data_url 内部会做 BGRA→RGBA 转换，此处只确保 alpha=255
            for i in (0..fallback_pixels.len()).step_by(4) {
                fallback_pixels[i + 3] = 255;
            }
            let result = gdi_utils::encode_jpeg_data_url(&fallback_pixels, rw, rh, 80);
            return Ok(result);
        }
    }

    // Crop sub-region from full window pixels (BGRA, top-down, 4 bytes per pixel)
    let row_bytes = (win_w * 4) as usize;
    let mut cropped: Vec<u8> = Vec::with_capacity((rw * rh * 4) as usize);
    for row in ry..(ry + rh) {
        let src_start = (row as usize) * row_bytes + (rx as usize) * 4;
        let src_end = src_start + (rw as usize) * 4;
        if src_end <= full_pixels.len() {
            cropped.extend_from_slice(&full_pixels[src_start..src_end]);
        } else {
            cropped.extend(std::iter::repeat(0u8).take((rw as usize) * 4));
        }
    }

    let result = gdi_utils::encode_jpeg_data_url(&cropped, rw, rh, 80);
    Ok(result)
}
