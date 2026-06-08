// 来源: 新增 — 图片压缩工具

export interface CompressedImage {
  dataUrl: string;
  originalWidth: number;
  originalHeight: number;
  compressedWidth: number;
  compressedHeight: number;
}

// 截图压缩：更激进的参数，减少 token 消耗
const MAX_DIMENSION = 1024;  // LLM 辨识小元素（色块、图标等）需要足够分辨率
const JPEG_QUALITY = 0.45;  // 提高一点质量配合更高分辨率

/**
 * Compress an image (from data URL or base64) by resizing and converting to JPEG.
 * Returns the compressed data URL and original dimensions.
 * In non-browser environments (Node.js), returns the original without compression.
 */
export function compressImage(
  source: string,
  maxDimension = MAX_DIMENSION,
  quality = JPEG_QUALITY,
): Promise<CompressedImage> {
  return new Promise((resolve, reject) => {
    // Node.js / non-browser: pass through without compression
    if (typeof Image === 'undefined') {
      const dataUrl = source.startsWith('data:')
        ? source
        : `data:image/png;base64,${source}`;
      return resolve({ dataUrl, originalWidth: 0, originalHeight: 0, compressedWidth: 0, compressedHeight: 0 });
    }

    // BMP 格式浏览器不支持 <img> 加载，交给 Rust compress_to_jpeg 处理
    if (source.startsWith('data:image/bmp')) {
      import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke<{ data_url: string; original_width: number; original_height: number; compressed_width: number; compressed_height: number }>('compress_to_jpeg', {
          imageBmp: source,
          maxDimension,
          quality: Math.round(quality * 100),
        })
      ).then(r =>
        resolve({ dataUrl: r.data_url, originalWidth: r.original_width, originalHeight: r.original_height, compressedWidth: r.compressed_width, compressedHeight: r.compressed_height })
      ).catch(reject);
      return;
    }

    const img = new Image();
    img.onload = () => {
      const origW = img.width;
      const origH = img.height;

      let w = origW;
      let h = origH;
      if (w > maxDimension || h > maxDimension) {
        if (w > h) {
          h = Math.round((h * maxDimension) / w);
          w = maxDimension;
        } else {
          w = Math.round((w * maxDimension) / h);
          h = maxDimension;
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);

      const output = canvas.toDataURL('image/jpeg', quality);
      resolve({
        dataUrl: output,
        originalWidth: origW,
        originalHeight: origH,
        compressedWidth: w,
        compressedHeight: h,
      });
    };
    img.onerror = () => reject(new Error('Failed to load image for compression'));

    // Ensure data URL prefix exists so Image can load it
    if (source.startsWith('data:')) {
      img.src = source;
    } else {
      img.src = `data:image/png;base64,${source}`;
    }
  });
}
