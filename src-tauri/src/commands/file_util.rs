use base64::{Engine as _, engine::general_purpose::STANDARD};
use tauri::Manager;

/// Save base64-encoded images to disk under the app's data directory.
/// Each item should be { data: "data:image/jpeg;base64,/9j/...", filename: "llm_img_0_1716384000000.jpg" }.
/// Returns the list of saved file paths.
#[tauri::command]
pub async fn save_llm_images(
    app: tauri::AppHandle,
    images: Vec<serde_json::Value>,
) -> Result<Vec<String>, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?
        .join("public")
        .join("llm_images");

    std::fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Failed to create directory {:?}: {}", base_dir, e))?;

    let mut saved = Vec::new();

    for img in images {
        let data_url = img["data"]
            .as_str()
            .ok_or_else(|| "Missing 'data' field".to_string())?;
        let filename = img["filename"]
            .as_str()
            .ok_or_else(|| "Missing 'filename' field".to_string())?;

        // Strip data URL prefix: "data:image/jpeg;base64,<actual>"
        let base64_part = data_url
            .find(',')
            .map(|i| &data_url[i + 1..])
            .unwrap_or(data_url);

        let bytes = STANDARD
            .decode(base64_part)
            .map_err(|e| format!("Base64 decode failed for {}: {}", filename, e))?;

        let path = base_dir.join(filename);
        std::fs::write(&path, &bytes)
            .map_err(|e| format!("Failed to write {:?}: {}", path, e))?;

        saved.push(path.to_string_lossy().to_string());
    }

    Ok(saved)
}

/// Read a file and return its content as a base64-encoded data URL.
/// This is used to load images when asset protocol is not available.
#[tauri::command]
pub async fn read_file_as_data_url(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("Failed to read file {}: {}", path, e))?;

    // Detect MIME type from extension
    let mime = if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    };

    let base64 = STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, base64))
}
