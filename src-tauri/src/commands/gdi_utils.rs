// Shared GDI RAII guards + BMP encoding utilities.
// Used by capture.rs, screenshot.rs, and image_process.rs.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{DynamicImage, ImageBuffer, Rgba};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HDC, HBITMAP,
};

pub struct ScopedDC(pub HDC);
impl Drop for ScopedDC {
    fn drop(&mut self) {
        unsafe { let _ = DeleteDC(self.0); }
    }
}

pub struct ScopedBitmap(pub HBITMAP);
impl Drop for ScopedBitmap {
    fn drop(&mut self) {
        unsafe { let _ = DeleteObject(self.0); }
    }
}

pub struct ScopedScreenDC(pub HDC);
impl Drop for ScopedScreenDC {
    fn drop(&mut self) {
        unsafe { let _ = ReleaseDC(None, self.0); }
    }
}

/// Get desktop screen DC (caller owns release via ScopedScreenDC)
pub fn get_screen_dc() -> Result<(HDC, ScopedScreenDC), String> {
    let hdc = unsafe { GetDC(None) };
    if hdc.is_invalid() {
        return Err("Failed to get desktop DC".into());
    }
    Ok((hdc, ScopedScreenDC(hdc)))
}

/// Create a compatible memory DC + bitmap for the given dimensions
pub fn create_mem_dc(hdc: HDC, width: i32, height: i32) -> Result<(HDC, ScopedDC, HBITMAP, ScopedBitmap), String> {
    let h_bitmap = unsafe { CreateCompatibleBitmap(hdc, width, height) };
    if h_bitmap.is_invalid() {
        return Err("Failed to create compatible bitmap".into());
    }
    let h_mem_dc = unsafe { CreateCompatibleDC(hdc) };
    Ok((h_mem_dc, ScopedDC(h_mem_dc), h_bitmap, ScopedBitmap(h_bitmap)))
}

/// Extract pixel data from a bitmap into a BGRA Vec<u8>
pub fn get_bitmap_pixels(h_mem_dc: HDC, h_bitmap: HBITMAP, width: i32, height: i32) -> Vec<u8> {
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default()],
    };

    let buffer_size = (width * height * 4) as usize;
    let mut pixels: Vec<u8> = vec![0u8; buffer_size];

    unsafe {
        GetDIBits(
            h_mem_dc,
            h_bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bi,
            DIB_RGB_COLORS,
        );
    }

    pixels
}

/// Check if pixel data is approximately uniform (all gray / blank).
/// Samples N random-ish positions and checks if all channels are within tolerance.
pub fn is_uniform_pixels(pixels: &[u8], width: i32, height: i32) -> bool {
    let total_pixels = (width * height) as usize;
    if total_pixels < 4 { return false; }

    // Sample ~20 evenly-spaced pixels
    let step = (total_pixels / 20).max(1);
    let mut first_r = 0u8;
    let mut first_g = 0u8;
    let mut first_b = 0u8;
    let mut first = true;
    let tolerance = 8u8; // channels within ±8 of each other

    for i in (0..total_pixels).step_by(step) {
        let offset = i * 4;
        if offset + 3 >= pixels.len() { break; }
        let r = pixels[offset];
        let g = pixels[offset + 1];
        let b = pixels[offset + 2];

        if first {
            first_r = r; first_g = g; first_b = b;
            first = false;
            // Check if this pixel itself is gray (R≈G≈B)
            let max_diff = (r as i16 - g as i16).abs().max((g as i16 - b as i16).abs()).max((r as i16 - b as i16).abs());
            if max_diff > tolerance as i16 {
                return false; // Not gray at all
            }
        } else {
            // Check if this pixel is similar to the first pixel
            let diff = (r as i16 - first_r as i16).abs().max((g as i16 - first_g as i16).abs()).max((b as i16 - first_b as i16).abs());
            if diff > tolerance as i16 {
                return false;
            }
        }
    }
    true
}

/// Encode BGRA pixel data as a base64 BMP data URL.
/// Pixels from GetDIBits are in top-down order. BMP positive biHeight expects bottom-up,
/// so we flip the rows to produce a correctly oriented BMP for all decoders (browsers + image crate).
pub fn encode_bmp_data_url(pixels: &[u8], width: i32, height: i32) -> String {
    let row_bytes = (width * 4) as usize;
    let total = pixels.len();

    // Flip rows: GetDIBits gives top-down → BMP bottom-up needs reversed
    let mut flipped: Vec<u8> = Vec::with_capacity(total);
    for row in (0..height as usize).rev() {
        let start = row * row_bytes;
        let end = (start + row_bytes).min(total);
        flipped.extend_from_slice(&pixels[start..end]);
    }

    let file_size = 54 + flipped.len() as u32;
    let mut bmp_data: Vec<u8> = Vec::with_capacity(file_size as usize);

    bmp_data.extend_from_slice(&[b'B', b'M']);
    bmp_data.extend_from_slice(&file_size.to_le_bytes());
    bmp_data.extend_from_slice(&[0u8; 4]);       // reserved
    bmp_data.extend_from_slice(&54u32.to_le_bytes()); // data offset
    bmp_data.extend_from_slice(&40u32.to_le_bytes()); // DIB header size
    bmp_data.extend_from_slice(&width.to_le_bytes());
    bmp_data.extend_from_slice(&height.to_le_bytes()); // positive = bottom-up
    bmp_data.extend_from_slice(&1u16.to_le_bytes());  // planes
    bmp_data.extend_from_slice(&32u16.to_le_bytes()); // bpp
    bmp_data.extend_from_slice(&0u32.to_le_bytes());  // compression
    bmp_data.extend_from_slice(&(flipped.len() as u32).to_le_bytes()); // image size
    bmp_data.extend_from_slice(&[0u8; 16]);           // remaining DIB fields
    bmp_data.extend_from_slice(&flipped);

    let base64_str = BASE64.encode(&bmp_data);
    format!("data:image/bmp;base64,{}", base64_str)
}

/// Encode BGRA pixel data as a JPEG data URL (smaller than BMP, avoids browser BMP decode issues).
/// quality: 0-100, recommended 70-85.
pub fn encode_jpeg_data_url(pixels: &[u8], width: i32, height: i32, quality: u8) -> String {

    // BGRA → RGBA
    let mut rgba = Vec::with_capacity(pixels.len());
    for i in (0..pixels.len()).step_by(4) {
        rgba.push(pixels[i + 2]); // R
        rgba.push(pixels[i + 1]); // G
        rgba.push(pixels[i]);     // B
        rgba.push(255);           // A
    }

    let img: DynamicImage = DynamicImage::ImageRgba8(
        ImageBuffer::<Rgba<u8>, _>::from_raw(width as u32, height as u32, rgba)
            .expect("Failed to create image buffer"),
    );

    let mut buf: Vec<u8> = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
        .expect("Failed to encode JPEG");

    let base64_str = BASE64.encode(&buf);
    format!("data:image/jpeg;base64,{}", base64_str)
}
