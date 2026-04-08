import { useRef, useEffect, useState, useCallback } from 'react';

export type TemplateLayer =
  | { type: 'screenShare'; x: number; y: number; width: number; height: number }
  | { type: 'webcam'; x: number; y: number; width: number; height: number }
  | { type: 'image'; src: string; x: number; y: number; width: number; height: number }
  | { type: 'text'; content: string; x: number; y: number; font: string; color: string; align?: CanvasTextAlign }
  | { type: 'rect'; x: number; y: number; width: number; height: number; color: string };

export interface CanvasTemplate {
  width: number;
  height: number;
  backgroundColor: string;
  layers: TemplateLayer[];
}

interface UseCanvasCompositorOptions {
  template: CanvasTemplate;
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

  // Hidden video elements for media streams
  const webcamVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const preloadedImages = useRef<Map<string, HTMLImageElement>>(new Map());
  const animFrameRef = useRef<number>(0);
  const lastFrameTime = useRef<number>(0);

  // Preload overlay images from the template
  const preloadImages = useCallback((layers: TemplateLayer[]) => {
    const imageLayers = layers.filter((l): l is Extract<TemplateLayer, { type: 'image' }> => l.type === 'image');
    for (const layer of imageLayers) {
      if (!preloadedImages.current.has(layer.src)) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = layer.src;
        preloadedImages.current.set(layer.src, img);
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

    preloadImages(template.layers);
    setIsRendering(true);

    // Capture stream from canvas
    const stream = canvas.captureStream(fps);
    setCompositeStream(stream);

    const frameInterval = 1000 / fps;

    function render(timestamp: number) {
      // Throttle to target FPS
      if (timestamp - lastFrameTime.current < frameInterval) {
        animFrameRef.current = requestAnimationFrame(render);
        return;
      }
      lastFrameTime.current = timestamp;

      if (!ctx) return;

      // Clear canvas
      ctx.fillStyle = template.backgroundColor;
      ctx.fillRect(0, 0, template.width, template.height);

      // Draw layers in order
      for (const layer of template.layers) {
        switch (layer.type) {
          case 'rect':
            ctx.fillStyle = layer.color;
            ctx.fillRect(layer.x, layer.y, layer.width, layer.height);
            break;

          case 'image': {
            const img = preloadedImages.current.get(layer.src);
            if (img?.complete && img.naturalWidth > 0) {
              ctx.drawImage(img, layer.x, layer.y, layer.width, layer.height);
            }
            break;
          }

          case 'text':
            ctx.font = layer.font;
            ctx.fillStyle = layer.color;
            ctx.textAlign = layer.align ?? 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(layer.content, layer.x, layer.y);
            break;

          case 'screenShare': {
            const video = screenVideoRef.current;
            if (video && video.readyState >= 2 && video.videoWidth > 0) {
              ctx.drawImage(video, layer.x, layer.y, layer.width, layer.height);
            }
            break;
          }

          case 'webcam': {
            const video = webcamVideoRef.current;
            if (video && video.readyState >= 2 && video.videoWidth > 0) {
              ctx.drawImage(video, layer.x, layer.y, layer.width, layer.height);
            }
            break;
          }
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
  }, [template, fps, preloadImages]);

  return { canvasRef, compositeStream, isRendering };
}
