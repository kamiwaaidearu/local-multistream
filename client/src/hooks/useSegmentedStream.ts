import { useEffect, useRef, useState } from 'react';
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

export type SegmentStatus = 'idle' | 'loading' | 'active' | 'error';

interface UseSegmentedStreamOptions {
  /** Raw camera stream to process. Its tracks are NOT stopped here — the caller owns them. */
  sourceStream: MediaStream | null;
  /** When false, the hook passes `sourceStream` straight through with zero processing overhead. */
  enabled: boolean;
  /** Gaussian blur radius applied to the background, in canvas pixels. */
  blurAmount?: number;
  /** Processing/output frame rate. */
  fps?: number;
}

interface UseSegmentedStreamResult {
  /** Feed this to the compositor. Equals `sourceStream` when disabled, else the blurred output. */
  outputStream: MediaStream | null;
  status: SegmentStatus;
  error: string | null;
}

// Where the self-hosted MediaPipe assets live (copied into client/public — see public/mediapipe).
// Self-hosting keeps segmentation working with no external CDN dependency at stream time.
const WASM_PATH = '/mediapipe/wasm';
const MODEL_PATH = '/mediapipe/selfie_segmenter.tflite';

/**
 * Background blur for a camera stream, using MediaPipe's Selfie Segmentation — the same model
 * Google Meet uses. Each frame: the model predicts a per-pixel "person" mask; we draw a blurred
 * copy of the frame as the background and composite the sharp, masked person on top.
 *
 * The processing loop is driven by a Web Worker timer (not requestAnimationFrame) for the same
 * reason the compositor is: rAF throttles to ~1fps when the studio tab is backgrounded (which it
 * is whenever the operator is on their slides tab), which would freeze the camera. A worker timer
 * is not throttled, so the blurred feed stays smooth.
 *
 * Segmentation runs on the operator's own machine, so this is opt-in per the caller.
 */
export function useSegmentedStream({
  sourceStream,
  enabled,
  blurAmount = 14,
  fps = 30,
}: UseSegmentedStreamOptions): UseSegmentedStreamResult {
  const [processedStream, setProcessedStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<SegmentStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Latest blur amount without re-initialising the segmenter.
  const blurRef = useRef(blurAmount);
  blurRef.current = blurAmount;

  useEffect(() => {
    if (!enabled || !sourceStream) {
      setProcessedStream(null);
      setStatus('idle');
      setError(null);
      return;
    }

    let cancelled = false;
    let segmenter: ImageSegmenter | null = null;
    let ticker: Worker | null = null;
    let outStream: MediaStream | null = null;
    let inFlight = false;
    let inFlightSince = 0;
    let lastTs = -1;
    // Reused across frames so we don't allocate a full-frame ImageData 30×/sec.
    let maskImage: ImageData | null = null;

    // Hidden <video> the model reads from.
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream(sourceStream.getVideoTracks());

    // Output canvas (captured into the stream) + scratch canvases for the person layer and mask.
    const outCanvas = document.createElement('canvas');
    const personCanvas = document.createElement('canvas');
    const maskCanvas = document.createElement('canvas');
    const outCtx = outCanvas.getContext('2d');
    const personCtx = personCanvas.getContext('2d');
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });

    setStatus('loading');
    setError(null);

    async function init() {
      try {
        await video.play().catch(() => {});

        const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
        if (cancelled) return;

        // Prefer the GPU delegate; fall back to CPU if the GPU path won't initialise.
        try {
          segmenter = await ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
            runningMode: 'VIDEO',
            outputCategoryMask: false,
            outputConfidenceMasks: true,
          });
        } catch {
          segmenter = await ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'CPU' },
            runningMode: 'VIDEO',
            outputCategoryMask: false,
            outputConfidenceMasks: true,
          });
        }
        if (cancelled) {
          segmenter?.close();
          segmenter = null;
          return;
        }

        // captureStream(0): frames are emitted only when we call requestFrame() on each tick,
        // matching the compositor's manual-capture approach.
        outStream = outCanvas.captureStream(0);
        const track = outStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;

        // Revoke the blob URL as soon as the Worker has loaded from it, so each blur on/off
        // cycle doesn't leak a blob URL for the lifetime of the page.
        const workerUrl = URL.createObjectURL(
          new Blob(
            ['let t=null;onmessage=(e)=>{if(e.data&&e.data.stop){if(t)clearInterval(t);t=null;return;}if(t)clearInterval(t);t=setInterval(()=>postMessage(0),e.data.interval);};'],
            { type: 'application/javascript' },
          ),
        );
        ticker = new Worker(workerUrl);
        URL.revokeObjectURL(workerUrl);
        ticker.onmessage = () => {
          renderFrame();
          try { track?.requestFrame(); } catch { /* ignore */ }
        };
        ticker.postMessage({ interval: 1000 / fps });

        if (!cancelled) {
          setProcessedStream(outStream);
          setStatus('active');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        }
      }
    }

    function renderFrame() {
      if (!segmenter || !outCtx || !personCtx || !maskCtx) return;
      if (video.readyState < 2 || video.videoWidth === 0) return;

      const w = video.videoWidth;
      const h = video.videoHeight;
      if (outCanvas.width !== w || outCanvas.height !== h) {
        outCanvas.width = personCanvas.width = w;
        outCanvas.height = personCanvas.height = h;
      }

      // Never overlap two inferences. The flag is cleared by the callback's finally; if an
      // inference ever returns without calling back (dropped frame, API change), self-heal after
      // ~1s so the feed can never freeze permanently on a stuck flag.
      if (inFlight) {
        if (performance.now() - inFlightSince < 1000) return;
        inFlight = false;
      }
      // segmentForVideo needs strictly increasing timestamps.
      const ts = Math.max(performance.now(), lastTs + 1);
      lastTs = ts;
      inFlight = true;
      inFlightSince = performance.now();

      try {
        segmenter.segmentForVideo(video, ts, (result) => {
          try {
            const mask = result.confidenceMasks?.[0];
            if (!mask) return;

            const mw = mask.width;
            const mh = mask.height;
            const conf = mask.getAsUint8Array(); // 0..255 person probability per pixel

            // Build an image whose ALPHA channel is the person probability. Drawn with
            // destination-in, it erases the background from the sharp person layer.
            if (maskCanvas.width !== mw || maskCanvas.height !== mh || !maskImage) {
              maskCanvas.width = mw;
              maskCanvas.height = mh;
              maskImage = maskCtx.createImageData(mw, mh);
              // RGB stays white for every pixel; only the alpha channel changes per frame.
              const d = maskImage.data;
              for (let o = 0; o < d.length; o += 4) { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; }
            }
            const data = maskImage.data;
            for (let i = 0; i < conf.length; i++) {
              data[i * 4 + 3] = conf[i];
            }
            maskCtx.putImageData(maskImage, 0, 0);

            // Person layer: sharp frame, then keep only the masked (person) pixels.
            personCtx.globalCompositeOperation = 'source-over';
            personCtx.filter = 'none';
            personCtx.clearRect(0, 0, w, h);
            personCtx.drawImage(video, 0, 0, w, h);
            personCtx.globalCompositeOperation = 'destination-in';
            // A light blur on the upscaled mask feathers the person's edge (esp. hair) so the
            // cutout doesn't show a hard line.
            personCtx.filter = 'blur(2px)';
            personCtx.drawImage(maskCanvas, 0, 0, w, h);
            personCtx.globalCompositeOperation = 'source-over';
            personCtx.filter = 'none';

            // Output: blurred background, then the sharp person composited on top.
            // Overscan the background: a canvas blur samples beyond the drawn image into
            // transparent pixels, which fades/darkens the frame edges. Drawing the video enlarged
            // so it overflows the canvas keeps the kernel on real pixels, so the blurred background
            // reaches the edges cleanly (the slight zoom is unnoticeable). `blur(n)` is a Gaussian
            // with std-dev n whose tail runs ~3× the radius, so we overscan by 3× to fully cover it.
            const blur = blurRef.current;
            const pad = Math.ceil(blur * 3);
            outCtx.globalCompositeOperation = 'source-over';
            outCtx.filter = `blur(${blur}px)`;
            outCtx.drawImage(video, -pad, -pad, w + pad * 2, h + pad * 2);
            outCtx.filter = 'none';
            outCtx.drawImage(personCanvas, 0, 0, w, h);
          } finally {
            inFlight = false;
          }
        });
      } catch {
        inFlight = false;
      }
    }

    init();

    return () => {
      cancelled = true;
      try { ticker?.postMessage({ stop: true }); } catch { /* ignore */ }
      ticker?.terminate();
      // Stop only OUR captured output tracks — never the caller-owned source tracks.
      outStream?.getTracks().forEach((t) => t.stop());
      segmenter?.close();
      video.srcObject = null;
      setProcessedStream(null);
    };
  }, [enabled, sourceStream, fps]);

  return {
    // While the model loads (or if it fails), fall back to the raw camera so the feed is never
    // black — blur just isn't applied until/unless the processed stream is ready.
    outputStream: enabled ? (processedStream ?? sourceStream) : sourceStream,
    status: enabled ? status : 'idle',
    error,
  };
}
