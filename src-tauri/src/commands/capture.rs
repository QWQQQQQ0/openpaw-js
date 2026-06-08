// Native region capture — BitBlt a small screen region, return base64 BMP.
// Much faster than full-screen capture + crop: ~50KB vs ~6MB for typical watcher regions.

use super::gdi_utils::{self, encode_bmp_data_url};
use windows::Win32::Graphics::Gdi::{BitBlt, SelectObject, SRCCOPY};

fn now_str() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let ms = now.as_millis() % 1000;
    let secs = (now.as_secs() + 8 * 3600) % 86400; // UTC+8 北京时间
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}.{:03}", h, m, s, ms)
}

#[tauri::command]
pub fn capture_region(x: i32, y: i32, width: i32, height: i32) -> Result<String, String> {
    if width <= 0 || height <= 0 {
        return Err(format!("Invalid region size: {}x{}", width, height));
    }

    let (hdc, _screen_dc) = gdi_utils::get_screen_dc()?;
    let (h_mem_dc, _mem_dc, h_bitmap, _bitmap) = gdi_utils::create_mem_dc(hdc, width, height)?;

    let old_bitmap = unsafe { SelectObject(h_mem_dc, h_bitmap) };
    let blt_result = unsafe { BitBlt(h_mem_dc, 0, 0, width, height, hdc, x, y, SRCCOPY) };
    eprintln!("[{}][rust:capture] BitBlt({},{}, {}x{}) result={:?}", now_str(), x, y, width, height, blt_result);

    let mut pixels = gdi_utils::get_bitmap_pixels(h_mem_dc, h_bitmap, width, height);

    unsafe { SelectObject(h_mem_dc, old_bitmap) };
    // Guards clean up: h_mem_dc, h_bitmap, hdc

    // Sample corner pixels before conversion (raw BGRA from GDI)
    {
        let len = pixels.len();
        let samples = [
            (0usize, "top-left"),
            ((width as usize * 2 + 10) * 4, "row2-col10"),
            (len - 4, "bottom-right"),
        ];
        for (idx, label) in &samples {
            let i = (*idx).min(len.saturating_sub(4));
            eprintln!("[{}][rust:capture] raw BGRA {}: B={} G={} R={} A={}",
                now_str(), label, pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]);
        }
    }

    // BMP 32bpp 原生格式为 BGRA，保持 BGRA 不做通道互换，只确保 alpha=255
    for i in (0..pixels.len()).step_by(4) {
        pixels[i + 3] = 255;
    }

    let result = encode_bmp_data_url(&pixels, width, height);
    eprintln!("[{}][rust:capture] 完成: bmp_data_url.len={}", now_str(), result.len());
    Ok(result)
}
