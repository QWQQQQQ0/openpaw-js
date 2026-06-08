// Image processing commands for the multi-stage watcher detection pipeline.
//
// Stage 1: visual_diff  — fast block-level visual change detection
// Stage 2: ocr_text_diff — OCR text semantic comparison
// Stage 3: crop_image / compress_to_jpeg / extract_motion_region — region extraction
// Utility: compress_uia_tree — UIA tree compression for LLM

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{ImageBuffer, Luma};
use serde::{Deserialize, Serialize};

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

/// Slice a UTF-8 string at a byte boundary ≤ `max_len`, avoiding panic
/// when `max_len` falls in the middle of a multi-byte character.
fn utf8_safe_slice(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    let mut end = max_len;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ── Shared types ──

#[derive(Serialize, Deserialize, Clone)]
pub struct DiffBbox {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

// ── Stage 1: visual_diff ──

#[derive(Serialize)]
pub struct VisualDiffResult {
    pub changed: bool,
    pub visual_change_ratio: f64,
    pub changed_blocks: u32,
    pub total_blocks: u32,
    pub diff_pixel_count: u32,
    pub total_pixels: u32,
    pub bbox: Option<DiffBbox>,
    pub confidence: f64,
}

#[tauri::command]
pub fn visual_diff(
    baseline_bmp: String,
    current_bmp: String,
    block_size: u32,
    threshold: u8,
) -> Result<VisualDiffResult, String> {
    let ts = now_str();

    let prev = decode_bmp_to_luma(&baseline_bmp)?;
    let curr = decode_bmp_to_luma(&current_bmp)?;

    let (pw, ph) = prev.dimensions();
    let (cw, ch) = curr.dimensions();
    eprintln!("[{}][rust:visual_diff] 解码后尺寸: prev={}x{}, curr={}x{}", now_str(), pw, ph, cw, ch);

    // Resize to 320×180 for fast comparison
    let target_w = 320u32;
    let target_h = 180u32;

    let prev_small = image::imageops::resize(&prev, target_w, target_h, image::imageops::FilterType::Lanczos3);
    let curr_small = image::imageops::resize(&curr, target_w, target_h, image::imageops::FilterType::Lanczos3);

    // Sample some pixel values to verify images differ visually
    {
        let mut prev_sum: u64 = 0;
        let mut curr_sum: u64 = 0;
        let sample_count = (target_w * target_h).min(1000);
        for i in 0..sample_count {
            let x = (i * 37) % target_w;
            let y = (i * 53) % target_h;
            prev_sum += prev_small.get_pixel(x, y).0[0] as u64;
            curr_sum += curr_small.get_pixel(x, y).0[0] as u64;
        }
        eprintln!("[{}][rust:visual_diff] 缩小后尺寸: {}x{}, 采样{}像素: prev_avg={:.1}, curr_avg={:.1}",
            now_str(), target_w, target_h, sample_count,
            prev_sum as f64 / sample_count as f64,
            curr_sum as f64 / sample_count as f64,
        );
    }

    let blocks_x = target_w / block_size;
    let blocks_y = target_h / block_size;
    let total_blocks = blocks_x * blocks_y;

    let mut changed_blocks = 0u32;
    let mut diff_pixel_count = 0u32;
    let mut total_pixel_count = 0u32;
    let mut min_x = target_w;
    let mut min_y = target_h;
    let mut max_x = 0u32;
    let mut max_y = 0u32;

    for by in 0..blocks_y {
        for bx in 0..blocks_x {
            let x0 = bx * block_size;
            let y0 = by * block_size;
            let x1 = (x0 + block_size).min(target_w);
            let y1 = (y0 + block_size).min(target_h);

            let mut sum_prev: u32 = 0;
            let mut sum_curr: u32 = 0;
            let mut count: u32 = 0;

            for py in y0..y1 {
                for px in x0..x1 {
                    let p = prev_small.get_pixel(px, py).0[0] as u32;
                    let c = curr_small.get_pixel(px, py).0[0] as u32;
                    sum_prev += p;
                    sum_curr += c;
                    count += 1;

                    if (p as i32 - c as i32).unsigned_abs() > threshold as u32 {
                        diff_pixel_count += 1;
                    }
                }
            }

            total_pixel_count += count;

            let avg_diff = if count > 0 {
                ((sum_prev as i64 - sum_curr as i64).unsigned_abs() / count as u64) as u8
            } else {
                0
            };

            if avg_diff > threshold {
                changed_blocks += 1;
                if x0 < min_x { min_x = x0; }
                if y0 < min_y { min_y = y0; }
                if x1 > max_x { max_x = x1; }
                if y1 > max_y { max_y = y1; }
            }
        }
    }

    let visual_change_ratio = if total_blocks > 0 {
        changed_blocks as f64 / total_blocks as f64
    } else {
        0.0
    };

    let changed = visual_change_ratio > 0.02;

    let bbox = if changed && max_x > min_x && max_y > min_y {
        // Scale bbox back to original image dimensions
        let sx = pw as f64 / target_w as f64;
        let sy = ph as f64 / target_h as f64;
        Some(DiffBbox {
            x: (min_x as f64 * sx) as u32,
            y: (min_y as f64 * sy) as u32,
            width: ((max_x - min_x) as f64 * sx) as u32,
            height: ((max_y - min_y) as f64 * sy) as u32,
        })
    } else {
        None
    };

    let confidence = if changed {
        (0.5 + visual_change_ratio * 10.0).min(0.95)
    } else {
        0.99
    };

    let total_pixels = target_w * target_h;

    eprintln!(
        "[{}][rust:visual_diff] 结果: changed={}, ratio={:.4}%, changed_blocks={}/{}, diff_pixels={}/{}, confidence={:.4}, bbox={}",
        now_str(),
        changed,
        visual_change_ratio * 100.0,
        changed_blocks,
        total_blocks,
        diff_pixel_count,
        total_pixel_count,
        confidence,
        if let Some(ref b) = bbox {
            format!("({},{}) {}x{}", b.x, b.y, b.width, b.height)
        } else {
            "none".to_string()
        },
    );

    Ok(VisualDiffResult {
        changed,
        visual_change_ratio,
        changed_blocks,
        total_blocks,
        diff_pixel_count,
        total_pixels,
        bbox,
        confidence,
    })
}

fn decode_bmp_to_luma(data_url: &str) -> Result<ImageBuffer<Luma<u8>, Vec<u8>>, String> {
    let base64_str = data_url
        .strip_prefix("data:image/bmp;base64,")
        .or_else(|| data_url.strip_prefix("data:image/png;base64,"))
        .or_else(|| data_url.strip_prefix("data:image/jpeg;base64,"))
        .or_else(|| data_url.strip_prefix("data:image/jpg;base64,"))
        .unwrap_or(data_url);

    let bytes = BASE64.decode(base64_str).map_err(|e| format!("Base64 decode error: {e}"))?;



    let img = image::load_from_memory(&bytes).map_err(|e| format!("Image decode error: {e}"))?;
    let (w, h) = (img.width(), img.height());
    let color_type = img.color();
    eprintln!("[{}][rust:decode_bmp] 解码成功: {}x{}, color={:?}", now_str(), w, h, color_type);

    let luma = img.to_luma8();
    // Sample corner + center pixels
    let (lw, lh) = luma.dimensions();
    let samples = [
        (0, 0),
        (lw / 2, 0),
        (0, lh / 2),
        (lw / 2, lh / 2),
        (lw - 1, lh - 1),
        (lw / 4, lh / 4),
        (3 * lw / 4, 3 * lh / 4),
    ];
    let mut sample_str = String::new();
    for (sx, sy) in &samples {
        let sx = (*sx).min(lw - 1);
        let sy = (*sy).min(lh - 1);
        sample_str.push_str(&format!("({},{})={} ", sx, sy, luma.get_pixel(sx, sy).0[0]));
    }
    eprintln!("[{}][rust:decode_bmp] luma采样: {}", now_str(), sample_str.trim());

    Ok(luma)
}

// ── Stage 2: ocr_text_diff ──

#[derive(Serialize)]
pub struct OcrTextDiffResult {
    pub changed: bool,
    pub similarity: f64,
    pub prev_line_count: u32,
    pub curr_line_count: u32,
    pub new_lines: Vec<String>,
}

/// Compute a localized text diff between two OCR result JSON strings.
/// This runs in Rust for speed; OCR itself is done via the existing Python bridge.
#[tauri::command]
pub fn ocr_text_diff(
    prev_ocr_json: String,
    curr_ocr_json: String,
) -> Result<OcrTextDiffResult, String> {
    let ts = now_str();
    eprintln!("[{}][rust:ocr_text_diff] ── 调用开始 ──", ts);
    eprintln!("[{}][rust:ocr_text_diff] prev_ocr_json.len={}, curr_ocr_json.len={}", ts, prev_ocr_json.len(), curr_ocr_json.len());
    eprintln!("[{}][rust:ocr_text_diff] prev_ocr_json[..200]={}", ts, &utf8_safe_slice(&prev_ocr_json, 200));
    eprintln!("[{}][rust:ocr_text_diff] curr_ocr_json[..200]={}", ts, &utf8_safe_slice(&curr_ocr_json, 200));

    let prev_lines = extract_text_lines(&prev_ocr_json);
    let curr_lines = extract_text_lines(&curr_ocr_json);
    eprintln!("[{}][rust:ocr_text_diff] prev_lines={}, curr_lines={}", now_str(), prev_lines.len(), curr_lines.len());

    let prev_normalized = normalize_lines(&prev_lines);
    let curr_normalized = normalize_lines(&curr_lines);

    let prev_line_count = prev_normalized.len() as u32;
    let curr_line_count = curr_normalized.len() as u32;

    // Levenshtein on joined normalized text
    let prev_text = prev_normalized.join("\n");
    let curr_text = curr_normalized.join("\n");
    let edit_dist = levenshtein_distance(&prev_text, &curr_text);
    let max_len = prev_text.len().max(curr_text.len()).max(1);
    let similarity = 1.0 - (edit_dist as f64 / max_len as f64);

    let changed = similarity < 0.92;

    // Find new lines (in curr but not in prev)
    let prev_set: std::collections::HashSet<&str> = prev_normalized.iter().map(|s| s.as_str()).collect();
    let new_lines: Vec<String> = curr_lines
        .iter()
        .filter(|l| !prev_set.contains(l.trim()))
        .take(10)
        .cloned()
        .collect();

    eprintln!(
        "[{}][rust:ocr_text_diff] 结果 — edit_dist={}, max_len={}, similarity={:.4}, changed={}, prev_line_count={}, curr_line_count={}, new_lines={:?}",
        now_str(), edit_dist, max_len, similarity, changed, prev_line_count, curr_line_count, new_lines,
    );

    Ok(OcrTextDiffResult {
        changed,
        similarity,
        prev_line_count,
        curr_line_count,
        new_lines,
    })
}

fn extract_text_lines(ocr_json: &str) -> Vec<String> {
    // Parse OCR JSON format: { "texts": [{ "text": "...", ... }], "count": N }
    // or simpler: { "full_text": "..." }
    let parsed: serde_json::Value = match serde_json::from_str(ocr_json) {
        Ok(v) => v,
        Err(_) => return vec![ocr_json.to_string()],
    };

    if let Some(full_text) = parsed.get("full_text").and_then(|v| v.as_str()) {
        return full_text.lines().map(|l| l.to_string()).collect();
    }

    if let Some(texts) = parsed.get("texts").and_then(|v| v.as_array()) {
        return texts
            .iter()
            .filter_map(|t| t.get("text").and_then(|v| v.as_str()))
            .flat_map(|t| t.lines().map(|l| l.to_string()))
            .collect();
    }

    if let Some(text) = parsed.get("text").and_then(|v| v.as_str()) {
        return text.lines().map(|l| l.to_string()).collect();
    }

    vec![]
}

fn normalize_lines(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|l| {
            let mut s = l.trim().to_lowercase();
            // Strip timestamps like 12:34 or 12:34:56
            s = strip_timestamps(&s);
            // Strip common punctuation
            s = strip_punctuation(&s);
            s.trim().to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn strip_timestamps(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        // Check for HH:MM or HH:MM:SS pattern
        if i + 4 < chars.len()
            && chars[i].is_ascii_digit()
            && chars[i + 1].is_ascii_digit()
            && chars[i + 2] == ':'
            && chars[i + 3].is_ascii_digit()
            && chars[i + 4].is_ascii_digit()
        {
            i += 5;
            if i + 2 < chars.len() && chars[i] == ':' && chars[i + 1].is_ascii_digit() && chars[i + 2].is_ascii_digit() {
                i += 3;
            }
            continue;
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

fn strip_punctuation(s: &str) -> String {
    let punct: &[char] = &[
        '，', '。', '！', '？', '、', '；', '：', '"', '"', '\'', '\'',
        '【', '】', '（', '）', '《', '》', ',', '.', '!', '?', ';',
        ':', '\'', '"', '(', ')', '[', ']', '{', '}',
    ];
    s.chars().filter(|c| !punct.contains(c)).collect()
}

fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let n = a_chars.len();
    let m = b_chars.len();

    if n == 0 { return m; }
    if m == 0 { return n; }

    let mut prev: Vec<usize> = (0..=m).collect();
    let mut curr: Vec<usize> = vec![0; m + 1];

    for i in 1..=n {
        curr[0] = i;
        for j in 1..=m {
            let cost = if a_chars[i - 1] == b_chars[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1)
                .min(curr[j - 1] + 1)
                .min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    prev[m]
}

// ── Stage 3: crop_image ──

#[tauri::command]
pub fn crop_image(
    image_bmp: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let base64_str = image_bmp
        .strip_prefix("data:image/bmp;base64,")
        .or_else(|| image_bmp.strip_prefix("data:image/png;base64,"))
        .or_else(|| image_bmp.strip_prefix("data:image/jpeg;base64,"))
        .unwrap_or(&image_bmp);

    let bytes = BASE64.decode(base64_str).map_err(|e| format!("Base64 decode error: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("Image decode error: {e}"))?;

    let w = width.min(img.width() - x);
    let h = height.min(img.height() - y);
    let cropped = image::imageops::crop_imm(&img, x, y, w, h).to_image();
    let raw = cropped.into_raw();

    let mut buf: Vec<u8> = Vec::new();
    let mut encoder = image::codecs::bmp::BmpEncoder::new(&mut buf);
    encoder
        .encode(&raw, w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("BMP encode error: {e}"))?;

    let base64_str = BASE64.encode(&buf);
    Ok(format!("data:image/bmp;base64,{}", base64_str))
}

// ── Stage 3: compress_to_jpeg ──

#[derive(Serialize)]
pub struct CompressedImage {
    pub data_url: String,
    pub original_width: u32,
    pub original_height: u32,
    pub compressed_width: u32,
    pub compressed_height: u32,
}

#[tauri::command]
pub fn compress_to_jpeg(
    image_bmp: String,
    max_dimension: u32,
    quality: u8,
) -> Result<CompressedImage, String> {
    let base64_str = image_bmp
        .strip_prefix("data:image/bmp;base64,")
        .or_else(|| image_bmp.strip_prefix("data:image/png;base64,"))
        .or_else(|| image_bmp.strip_prefix("data:image/jpeg;base64,"))
        .unwrap_or(&image_bmp);

    let bytes = BASE64.decode(base64_str).map_err(|e| format!("Base64 decode error: {e}"))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("Image decode error: {e}"))?;

    let orig_w = img.width();
    let orig_h = img.height();

    // Resize if larger than max_dimension
    let (w, h) = if orig_w > max_dimension || orig_h > max_dimension {
        let ratio = (max_dimension as f64 / orig_w as f64).min(max_dimension as f64 / orig_h as f64);
        ((orig_w as f64 * ratio) as u32, (orig_h as f64 * ratio) as u32)
    } else {
        (orig_w, orig_h)
    };

    let resized = image::imageops::resize(&img, w, h, image::imageops::FilterType::Lanczos3);
    // resize 返回 ImageBuffer<Rgba8>，JPEG 不支持 Alpha → 转 DynamicImage 再 to_rgb8
    let rgb = image::DynamicImage::ImageRgba8(resized).to_rgb8();

    let mut buf: Vec<u8> = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    encoder
        .encode(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("JPEG encode error: {e}"))?;

    let base64_str = BASE64.encode(&buf);
    Ok(CompressedImage {
        data_url: format!("data:image/jpeg;base64,{}", base64_str),
        original_width: orig_w,
        original_height: orig_h,
        compressed_width: w,
        compressed_height: h,
    })
}

// ── Stage 3: extract_motion_region ──

#[tauri::command]
pub fn extract_motion_region(
    baseline_bmp: String,
    current_bmp: String,
    bbox: DiffBbox,
    padding: u32,
) -> Result<(String, String), String> {
    let prev = decode_bmp_bytes(&baseline_bmp)?;
    let curr = decode_bmp_bytes(&current_bmp)?;

    let x = bbox.x.saturating_sub(padding);
    let y = bbox.y.saturating_sub(padding);
    let w = (bbox.width + padding * 2).min(prev.width() - x);
    let h = (bbox.height + padding * 2).min(prev.height() - y);

    let cropped_prev = image::imageops::crop_imm(&prev, x, y, w, h).to_image();
    let cropped_curr = image::imageops::crop_imm(&curr, x, y, w, h).to_image();

    let mut buf_prev: Vec<u8> = Vec::new();
    let mut buf_curr: Vec<u8> = Vec::new();

    let mut enc = image::codecs::bmp::BmpEncoder::new(&mut buf_prev);
    enc.encode(cropped_prev.as_raw(), w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("BMP encode error: {e}"))?;

    let mut enc = image::codecs::bmp::BmpEncoder::new(&mut buf_curr);
    enc.encode(cropped_curr.as_raw(), w, h, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("BMP encode error: {e}"))?;

    Ok((
        format!("data:image/bmp;base64,{}", BASE64.encode(&buf_prev)),
        format!("data:image/bmp;base64,{}", BASE64.encode(&buf_curr)),
    ))
}

fn decode_bmp_bytes(data_url: &str) -> Result<image::DynamicImage, String> {
    let base64_str = data_url
        .strip_prefix("data:image/bmp;base64,")
        .or_else(|| data_url.strip_prefix("data:image/png;base64,"))
        .or_else(|| data_url.strip_prefix("data:image/jpeg;base64,"))
        .unwrap_or(data_url);
    let bytes = BASE64.decode(base64_str).map_err(|e| format!("Base64 decode error: {e}"))?;
    image::load_from_memory(&bytes).map_err(|e| format!("Image decode error: {e}"))
}

// ── Utility: compress_uia_tree ──

#[derive(Serialize)]
struct CompressedNode {
    role: String,
    name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    children: Vec<CompressedNode>,
}

#[tauri::command]
pub fn compress_uia_tree(
    uia_json: String,
    max_depth: u32,
    max_children: u32,
) -> Result<String, String> {
    let root: serde_json::Value =
        serde_json::from_str(&uia_json).map_err(|e| format!("JSON parse error: {e}"))?;

    let compressed = compress_node(&root, 0, max_depth, max_children);
    let result = if let Some(arr) = compressed {
        serde_json::to_string(&arr).map_err(|e| format!("JSON serialize error: {e}"))?
    } else {
        "[]".to_string()
    };

    Ok(result)
}

fn compress_node(
    node: &serde_json::Value,
    depth: u32,
    max_depth: u32,
    max_children: u32,
) -> Option<Vec<CompressedNode>> {
    if depth > max_depth {
        return None;
    }

    // Handle array at top level
    if let Some(arr) = node.as_array() {
        let mut result: Vec<CompressedNode> = Vec::new();
        for item in arr.iter().take(max_children as usize * 2) {
            if let Some(c) = compress_single(item, depth, max_depth, max_children) {
                result.push(c);
                if result.len() >= max_children as usize {
                    break;
                }
            }
        }
        return Some(result);
    }

    // Single node
    compress_single(node, depth, max_depth, max_children)
        .map(|c| vec![c])
}

fn compress_single(
    node: &serde_json::Value,
    depth: u32,
    max_depth: u32,
    max_children: u32,
) -> Option<CompressedNode> {
    let role = node
        .get("controlType")
        .or_else(|| node.get("role"))
        .or_else(|| node.get("ControlType"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let name = node
        .get("name")
        .or_else(|| node.get("Name"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let children: Vec<CompressedNode> = if depth < max_depth {
        node.get("children")
            .or_else(|| node.get("Children"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .take(max_children as usize)
                    .filter_map(|child| compress_single(child, depth + 1, max_depth, max_children))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    Some(CompressedNode { role, name, children })
}
