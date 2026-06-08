import { useRef, useEffect, useState, useCallback } from 'react';
import type { ScreenRegion } from '@/types/watcher';

interface RegionSelectorProps {
  imageBase64: string;
  originalWidth: number;
  originalHeight: number;
  initialRegion?: ScreenRegion;
  onRegionChange: (region: ScreenRegion) => void;
  compact?: boolean;
}

export function RegionSelector({
  imageBase64,
  originalWidth,
  originalHeight,
  initialRegion,
  onRegionChange,
  compact,
}: RegionSelectorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const scaleRef = useRef(1);

  const maxH = compact ? 180 : 300;

  // Load image and draw
  useEffect(() => {
    if (!imageBase64 || !canvasRef.current || !containerRef.current) return;

    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const containerW = containerRef.current!.clientWidth;
      const scale = Math.min(containerW / originalWidth, maxH / originalHeight, 1);
      scaleRef.current = scale;

      const canvas = canvasRef.current!;
      const cw = Math.round(originalWidth * scale);
      const ch = Math.round(originalHeight * scale);
      canvas.width = cw;
      canvas.height = ch;
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;

      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, cw, ch);

      // Draw initial region if provided
      if (initialRegion && initialRegion.width > 0 && initialRegion.height > 0) {
        const s = scale;
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2;
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
        ctx.fillRect(initialRegion.x * s, initialRegion.y * s, initialRegion.width * s, initialRegion.height * s);
        ctx.strokeRect(initialRegion.x * s, initialRegion.y * s, initialRegion.width * s, initialRegion.height * s);
      }

      setImageLoaded(true);
    };
    img.src = imageBase64.startsWith('data:') ? imageBase64 : `data:image/bmp;base64,${imageBase64}`;
  }, [imageBase64, originalWidth, originalHeight, maxH, initialRegion]);

  const redraw = useCallback((rect: { x: number; y: number; w: number; h: number } | null) => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    if (rect) {
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
      const x = Math.min(rect.x, rect.x + rect.w);
      const y = Math.min(rect.y, rect.y + rect.h);
      const w = Math.abs(rect.w);
      const h = Math.abs(rect.h);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
  }, []);

  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasPos(e);
    setIsDragging(true);
    setStartPos(pos);
    setCurrentRect(null);
  }, [getCanvasPos]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    const pos = getCanvasPos(e);
    const rect = { x: startPos.x, y: startPos.y, w: pos.x - startPos.x, h: pos.y - startPos.y };
    setCurrentRect(rect);
    redraw(rect);
  }, [isDragging, startPos, getCanvasPos, redraw]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    setIsDragging(false);
    const pos = getCanvasPos(e);
    const s = scaleRef.current;

    const canvasX = Math.min(startPos.x, pos.x);
    const canvasY = Math.min(startPos.y, pos.y);
    const canvasW = Math.abs(pos.x - startPos.x);
    const canvasH = Math.abs(pos.y - startPos.y);

    if (canvasW < 5 || canvasH < 5) return; // ignore tiny accidental clicks

    onRegionChange({
      x: Math.round(canvasX / s),
      y: Math.round(canvasY / s),
      width: Math.round(canvasW / s),
      height: Math.round(canvasH / s),
    });
  }, [isDragging, startPos, getCanvasPos, onRegionChange]);

  return (
    <div ref={containerRef} className="w-full">
      <div
        className="relative border border-zinc-200 dark:border-zinc-700 rounded overflow-hidden bg-zinc-100 dark:bg-zinc-800"
        style={{ maxHeight: maxH }}
      >
        {!imageLoaded && (
          <div className="flex items-center justify-center h-20 text-zinc-400 text-xs">
            加载截图中...
          </div>
        )}
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { if (isDragging) { setIsDragging(false); redraw(null); } }}
          className="cursor-crosshair"
          style={{ display: imageLoaded ? 'block' : 'none' }}
        />
      </div>
      {initialRegion && initialRegion.width > 0 && (
        <div className="flex gap-2 mt-1 text-[10px] text-zinc-500">
          <span>X:{initialRegion.x}</span>
          <span>Y:{initialRegion.y}</span>
          <span>W:{initialRegion.width}</span>
          <span>H:{initialRegion.height}</span>
        </div>
      )}
    </div>
  );
}
