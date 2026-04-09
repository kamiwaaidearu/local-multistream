import { useRef, useEffect, useState, useCallback } from 'react';
import {
  type GridTemplate,
  type GridCell,
  type CellContent,
  resolveTrackSizes,
  getCellBounds,
  fitImageInArea,
} from '../lib/gridTemplate';

export type { GridTemplate };

interface UseCanvasCompositorOptions {
  template: GridTemplate;
  webcamStream: MediaStream | null;
  screenStream: MediaStream | null;
  fps?: number;
}

interface UseCanvasCompositorResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  compositeStream: MediaStream | null;
  isRendering: boolean;
}

export function useCanvasCompositor({
  template,
  webcamStream,
  screenStream,
  fps = 30,
}: UseCanvasCompositorOptions): UseCanvasCompositorResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [compositeStream, setCompositeStream] = useState<MediaStream | null>(null);
  const [isRendering, setIsRendering] = useState(false);

  // Template ref so the render loop reads the latest without tearing down the stream
  const templateRef = useRef(template);
  templateRef.current = template;

  // Cached grid sizes - recompute when template changes, not per frame
  const gridRef = useRef({ colSizes: [] as number[], rowSizes: [] as number[], gap: 0, cells: [] as GridCell[] });
  useEffect(() => {
    const cols = template.columns ?? [];
    const rows = template.rows ?? [];
    const gap = template.gap ?? 0;
    gridRef.current = {
      colSizes: resolveTrackSizes(cols, template.width, gap),
      rowSizes: resolveTrackSizes(rows, template.height, gap),
      gap,
      cells: template.cells ?? [],
    };
  }, [template]);

  // Hidden video elements for media streams
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const preloadedImages = useRef<Map<string, HTMLImageElement>>(new Map());
  const animFrameRef = useRef<number>(0);
  const lastFrameTime = useRef<number>(0);

  // Preload overlay images from grid cells
  const preloadImages = useCallback((cells: GridCell[]) => {
    for (const cell of cells) {
      if (cell.content.type === 'image') {
        const src = cell.content.src;
        if (!preloadedImages.current.has(src)) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = src;
          preloadedImages.current.set(src, img);
        }
      }
    }
  }, []);

  // Set up hidden video elements for streams
  useEffect(() => {
    if (!webcamVideoRef.current) {
      webcamVideoRef.current = document.createElement('video');
      webcamVideoRef.current.autoplay = true;
      webcamVideoRef.current.muted = true;
      webcamVideoRef.current.playsInline = true;
    }
    webcamVideoRef.current.srcObject = webcamStream;
    if (webcamStream) webcamVideoRef.current.play().catch(() => {});
  }, [webcamStream]);

  useEffect(() => {
    if (!screenVideoRef.current) {
      screenVideoRef.current = document.createElement('video');
      screenVideoRef.current.autoplay = true;
      screenVideoRef.current.muted = true;
      screenVideoRef.current.playsInline = true;
    }
    screenVideoRef.current.srcObject = screenStream;
    if (screenStream) screenVideoRef.current.play().catch(() => {});
  }, [screenStream]);

  // Main render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = template.width;
    canvas.height = template.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    preloadImages(template.cells ?? []);
    setIsRendering(true);

    // Capture stream from canvas
    const stream = canvas.captureStream(fps);
    setCompositeStream(stream);

    const frameInterval = 1000 / fps;

    function drawText(
      ctx: CanvasRenderingContext2D,
      content: Extract<CellContent, { type: 'text' }>,
      x: number,
      y: number,
      w: number,
      h: number,
    ) {
      const weight = content.fontWeight ?? 'normal';
      ctx.font = `${weight} ${content.fontSize}px ${content.fontFamily}`;
      ctx.fillStyle = content.color;
      ctx.textAlign = content.align ?? 'left';

      const lines = content.content.split('\n');
      const lineHeight = content.fontSize * 1.2;
      const totalTextHeight = lines.length * lineHeight;

      const vAlign = content.verticalAlign ?? 'top';
      let textY: number;
      if (vAlign === 'middle') {
        textY = y + (h - totalTextHeight) / 2;
      } else if (vAlign === 'bottom') {
        textY = y + h - totalTextHeight;
      } else {
        textY = y;
      }

      let textX: number;
      if (content.align === 'center') {
        textX = x + w / 2;
      } else if (content.align === 'right') {
        textX = x + w;
      } else {
        textX = x;
      }

      ctx.textBaseline = 'top';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], textX, textY + i * lineHeight);
      }
    }

    function render(timestamp: number) {
      // Throttle to target FPS
      if (timestamp - lastFrameTime.current < frameInterval) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }
      lastFrameTime.current = timestamp;

      if (!ctx) return;

      // Read latest template and grid sizes from refs
      const tpl = templateRef.current;
      const { colSizes, rowSizes, gap, cells } = gridRef.current;

      // Clear canvas with background
      ctx.fillStyle = tpl.backgroundColor;
      ctx.fillRect(0, 0, tpl.width, tpl.height);

      // Preload any new images added via editor
      preloadImages(cells);

      // Draw cells in array order (later = on top)
      for (const cell of cells) {
        const bounds = getCellBounds(cell, colSizes, rowSizes, gap);
        const padding = cell.padding ?? 0;

        // Cell background
        if (cell.backgroundColor) {
          ctx.fillStyle = cell.backgroundColor;
          ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
        }

        // Content area (inset by padding)
        const cx = bounds.x + padding;
        const cy = bounds.y + padding;
        const cw = Math.max(0, bounds.width - padding * 2);
        const ch = Math.max(0, bounds.height - padding * 2);

        if (cw <= 0 || ch <= 0) continue;

        switch (cell.content.type) {
          case 'screenShare': {
            const video = screenVideoRef.current;
            if (video && video.readyState >= 2 && video.videoWidth > 0) {
              const fitMode = cell.content.objectFit ?? 'contain';
              const fit = fitImageInArea(video.videoWidth, video.videoHeight, cx, cy, cw, ch, fitMode);
              if (fitMode === 'cover') {
                ctx.save();
                ctx.beginPath();
                ctx.rect(cx, cy, cw, ch);
                ctx.clip();
              }
              ctx.drawImage(video, fit.x, fit.y, fit.width, fit.height);
              if (fitMode === 'cover') ctx.restore();
            }
            break;
          }

          case 'webcam': {
            const video = webcamVideoRef.current;
            if (video && video.readyState >= 2 && video.videoWidth > 0) {
              const fitMode = cell.content.objectFit ?? 'contain';
              const fit = fitImageInArea(video.videoWidth, video.videoHeight, cx, cy, cw, ch, fitMode);
              if (fitMode === 'cover') {
                ctx.save();
                ctx.beginPath();
                ctx.rect(cx, cy, cw, ch);
                ctx.clip();
              }
              ctx.drawImage(video, fit.x, fit.y, fit.width, fit.height);
              if (fitMode === 'cover') ctx.restore();
            }
            break;
          }

          case 'image': {
            const img = preloadedImages.current.get(cell.content.src);
            if (img?.complete && img.naturalWidth > 0) {
              const imgFitMode = cell.content.objectFit ?? 'fill';
              const fit = fitImageInArea(
                img.naturalWidth,
                img.naturalHeight,
                cx, cy, cw, ch,
                imgFitMode,
              );
              if (imgFitMode === 'cover') {
                ctx.save();
                ctx.beginPath();
                ctx.rect(cx, cy, cw, ch);
                ctx.clip();
              }
              ctx.drawImage(img, fit.x, fit.y, fit.width, fit.height);
              if (imgFitMode === 'cover') ctx.restore();
            }
            break;
          }

          case 'text':
            drawText(ctx, cell.content, cx, cy, cw, ch);
            break;

          case 'empty':
            break;
        }
      }

      animFrameRef.current = requestAnimationFrame(render);
    }

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      setIsRendering(false);
      // Stop all tracks on the captured stream
      stream.getTracks().forEach((t) => t.stop());
      setCompositeStream(null);
    };
    // Only re-create the stream when canvas dimensions or fps change.
    // Cell/track/color edits are picked up via refs without stream teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.width, template.height, fps, preloadImages]);

  return { canvasRef, compositeStream, isRendering };
}
