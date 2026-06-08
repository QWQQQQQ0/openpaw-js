import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/utils/platform';
import type { LLMMessage } from '@/types/message';

/**
 * Extract image data URLs from LLM messages and save them to disk
 * before sending to the model.
 * - Tauri (browser): saves via Rust command → <app_data_dir>/public/llm_images/
 * - Node.js (backend): saves via fs → same directory (%APPDATA%/com.openpaw.app/public/llm_images/)
 */
export async function saveImagesBeforeLLMCall(
  messages: LLMMessage[],
): Promise<string[]> {
  const imagesToSave = extractImageUrls(messages);
  if (imagesToSave.length === 0) return [];

  if (isTauri()) {
    // Browser / Tauri webview — delegate to Rust command
    return saveViaTauri(imagesToSave);
  }

  // Node.js backend (Vite middleware) — save using fs
  const saved = await saveViaNodeFs(imagesToSave);
  if (saved.length > 0) {
    console.log(`[saveImages] saved ${saved.length} image(s) via Node.js fs`);
  }
  return saved;
}

// ── Extraction ──

let _saveSeq = 0;

interface ImageToSave {
  data: string;
  filename: string;
}

function extractImageUrls(messages: LLMMessage[]): ImageToSave[] {
  const images: ImageToSave[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;

    let imgIndex = 0;
    for (const part of content) {
      if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url;
        if (url.startsWith('data:')) {
          // 用 base64 内容的简单哈希做文件名，同一张图不重复存
          const base64Part = url.includes(',') ? url.substring(url.indexOf(',') + 1) : url;
          let hash = 0;
          for (let j = 0; j < Math.min(base64Part.length, 8192); j++) {
            hash = ((hash << 5) - hash + base64Part.charCodeAt(j)) | 0;
          }
          const contentHash = Math.abs(hash).toString(36);
          const ext = url.includes('image/png') ? 'png' : 'jpg';
          const filename = `llm_img_${contentHash}.${ext}`;

          if (!seen.has(filename)) {
            seen.add(filename);
            images.push({ data: url, filename });
          }
          imgIndex++;
        }
      }
    }
  }

  return images;
}

// ── Tauri path (browser) ──

async function saveViaTauri(images: ImageToSave[]): Promise<string[]> {
  try {
    return await invoke<string[]>('save_llm_images', { images });
  } catch {
    return [];
  }
}

// ── Node.js path (backend) ──

async function saveViaNodeFs(images: ImageToSave[]): Promise<string[]> {
  try {
    const [fs, nodePath] = await Promise.all([
      import('node:fs'),
      import('node:path'),
    ]);

    const appData = process.env.APPDATA
      || (process.env.HOME ? nodePath.join(process.env.HOME, '.local', 'share') : '');
    const dir = nodePath.join(appData, 'com.openpaw.app', 'public', 'llm_images');

    fs.mkdirSync(dir, { recursive: true });

    const saved: string[] = [];
    for (const img of images) {
      const filePath = nodePath.join(dir, img.filename);
      const base64 = img.data.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
      saved.push(filePath);
    }

    console.log(`[saveImages] 💾 saved ${saved.length} image(s) via Node.js fs → ${dir}`);
    return saved;
  } catch (e) {
    console.error(`[saveImages] ✗ saveViaNodeFs FAILED:`, e);
    return [];
  }
}
