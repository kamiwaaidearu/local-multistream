import { useEffect, useRef, useState } from 'react';
import {
  drawThumbnail,
  loadPlate,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  type LaidOutElement,
  type ThumbnailTemplate,
  type ThumbnailVars,
} from '../lib/thumbnailTemplate';

interface ThumbnailPreviewProps {
  template: ThumbnailTemplate;
  vars: ThumbnailVars;
  /** Displayed width in CSS pixels; the canvas always renders at full 1280x720 and is scaled down,
   *  so what you see is exactly what gets uploaded. */
  width?: number;
  /** Fires after every draw, so callers can surface shrink-to-fit warnings. */
  onLaidOut?: (laid: LaidOutElement[]) => void;
}

/** A live canvas rendering of a template. Used both in the editor and as each series row's preview. */
export function ThumbnailPreview({ template, vars, width = 480, onLaidOut }: ThumbnailPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [plateImage, setPlateImage] = useState<HTMLImageElement | null>(null);

  // Decoding the plate is the expensive part, so it is keyed on the URL alone — changing a font
  // size or retyping a title redraws without re-fetching the background.
  useEffect(() => {
    let cancelled = false;
    void loadPlate(template.plate).then((img) => {
      if (!cancelled) setPlateImage(img);
    });
    return () => {
      cancelled = true;
    };
  }, [template.plate]);

  // The callback is held in a ref so a caller passing an inline arrow function does not retrigger
  // the draw effect on every render.
  const onLaidOutRef = useRef(onLaidOut);
  onLaidOutRef.current = onLaidOut;

  const dateKey = vars.date ? vars.date.getTime() : null;
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const laid = drawThumbnail(ctx, template, vars, plateImage);
    onLaidOutRef.current?.(laid);
    // `template` and `vars` are compared by their serialised content: both are rebuilt fresh on
    // every keystroke in the editor, so an identity check would redraw constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(template), vars.title, dateKey, plateImage]);

  return (
    <canvas
      ref={canvasRef}
      width={THUMBNAIL_WIDTH}
      height={THUMBNAIL_HEIGHT}
      style={{
        width,
        height: (width * THUMBNAIL_HEIGHT) / THUMBNAIL_WIDTH,
        display: 'block',
        borderRadius: 4,
        maxWidth: '100%',
      }}
    />
  );
}
