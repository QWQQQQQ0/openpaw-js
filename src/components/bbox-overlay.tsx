'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Extract a bbox JSON from LLM response text. */
export function extractBbox(text: string): Bbox | null {
  const match = text.match(/\{\s*"x"\s*:\s*\d+,\s*"y"\s*:\s*\d+,\s*"width"\s*:\s*\d+,\s*"height"\s*:\s*\d+\s*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.width === 'number' &&
      typeof parsed.height === 'number'
    ) {
      return parsed;
    }
  } catch { /* not valid JSON */ }
  return null;
}

export function BboxOverlay({ imageUrl, bbox }: { imageUrl: string; bbox: Bbox }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState(false);

  const drawBbox = useCallback((canvas: HTMLCanvasElement, img: HTMLImageElement, maxW: number) => {
    const scale = Math.min(1, maxW / img.width);
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);

    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const bx = Math.round(bbox.x * scale);
    const by = Math.round(bbox.y * scale);
    const bw = Math.round(bbox.width * scale);
    const bh = Math.round(bbox.height * scale);

    ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, bw, bh);

    const label = `${bbox.width}×${bbox.height}`;
    ctx.font = '10px monospace';
    const tm = ctx.measureText(label);
    const lx = bx;
    const ly = Math.max(0, by - 6);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.85)';
    ctx.fillRect(lx, ly - 12, tm.width + 6, 14);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, lx + 3, ly);
  }, [bbox]);

  // Inline thumbnail
  useEffect(() => {
    setError(false);
    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      drawBbox(canvas, img, 400);
    };
    img.onerror = () => setError(true);
    img.src = imageUrl;
  }, [imageUrl, bbox, drawBbox]);

  // Preview modal
  useEffect(() => {
    if (!preview) return;
    const img = new Image();
    img.onload = () => {
      const canvas = previewCanvasRef.current;
      if (!canvas) return;
      drawBbox(canvas, img, Math.min(1200, window.innerWidth - 80));
    };
    img.onerror = () => setPreview(false);
    img.src = imageUrl;
  }, [preview, imageUrl, bbox, drawBbox]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  if (error) return null;
  return (
    <>
      <canvas
        ref={canvasRef}
        className="rounded-lg max-w-full mt-2 border border-zinc-200 dark:border-zinc-700 cursor-pointer hover:opacity-90 transition-opacity"
        onClick={() => setPreview(true)}
        title="Click to enlarge"
      />
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setPreview(false)}>
          <canvas
            ref={previewCanvasRef}
            className="rounded-lg max-w-full max-h-[90vh] object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setPreview(false)}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-lg leading-none transition-colors"
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}
