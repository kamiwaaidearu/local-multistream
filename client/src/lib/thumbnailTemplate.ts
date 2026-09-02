// Thumbnail template system — text laid onto a pre-rendered brand plate.
//
// The plate (background photo, logo lockup, eyebrow, divider, cross) is a flat image exported once
// from Figma. Everything that changes week to week is text, so a template is just that plate plus a
// list of positioned text elements. That keeps a month of thumbnails a matter of typing titles
// instead of re-exporting a design file four or five times.
//
// All geometry is stored NORMALISED (0..1 of the canvas box) rather than in pixels, so one template
// renders identically at 1280x720 for a YouTube upload and at 1920x1080 if a larger asset is ever
// wanted. Font sizes are a fraction of HEIGHT; positions are fractions of their own axis.

/** Base render size. 1280x720 is YouTube's recommended thumbnail size and well under its 2MB cap. */
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

export type ThumbnailAlign = 'left' | 'center' | 'right';
/** Which edge of the text block `y` pins. 'bottom' keeps a block anchored to the lower third even
 *  as it grows from one line to two — which is what the RosaryMen layout needs. */
export type ThumbnailVAlign = 'top' | 'middle' | 'bottom';

export interface ThumbnailTextElement {
  id: string;
  /** Shown as the field label in the fill-in form. */
  label: string;
  /** Literal text, optionally containing {{title}}, {{date}}, {{date:long|short|weekday}} tokens. */
  text: string;
  /** When true this element gets an input in the quick fill-in form; when false it is fixed
   *  branding that only the template designer touches. */
  editable: boolean;
  /** Anchor, as a fraction of width/height. */
  x: number;
  y: number;
  /** Maximum text width, as a fraction of canvas width. Text wraps, then shrinks, to fit. */
  maxWidth: number;
  /** Lines the block may grow to before the font shrinks instead. */
  maxLines: number;
  align: ThumbnailAlign;
  vAlign: ThumbnailVAlign;
  /** Fraction of canvas height. 0.1 at 720px tall = 72px. */
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  uppercase: boolean;
  color: string;
  /** Baseline-to-baseline distance as a multiple of font size. */
  lineHeight: number;
  /** Extra tracking, in em. */
  letterSpacing: number;
  /**
   * Id of another element whose shrink-to-fit this element follows.
   *
   * Without it, a long title that shrank to fit its box would leave the date at full size, so the
   * date ends up with more visual prominence than the title — the type hierarchy inverts. Pointing
   * the date at the title keeps the ratio between them fixed however much the title has to give up.
   *
   * Chains are followed; a cycle or a dangling id degrades to "no linkage" rather than throwing.
   */
  scaleWith?: string | null;
}

export interface ThumbnailTemplate {
  id: string;
  name: string;
  /** Flat colour painted first, and the fallback if the plate image is missing or fails to load. */
  backgroundColor: string;
  /** URL of the brand plate image, e.g. /uploads/thumbnails/<hash>. Null renders on flat colour. */
  plate: string | null;
  elements: ThumbnailTextElement[];
}

/** The values a caller substitutes into {{tokens}} — normally a stream's title and start time. */
export interface ThumbnailVars {
  title?: string;
  date?: Date | null;
}

// --- Token substitution ---

const ORDINAL_SUFFIXES = ['th', 'st', 'nd', 'rd'];

/** "19th", "21st", "3rd" — including the 11/12/13 exceptions. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${ORDINAL_SUFFIXES[n % 10] ?? 'th'}`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export type ThumbnailDateStyle = 'long' | 'short' | 'weekday';

/**
 * Formats a date the way the existing thumbnails read: "August 19th, 2026".
 *
 * Deliberately hand-rolled rather than Intl — Intl has no ordinal-day format, and the ordinal is
 * part of the visual signature of these thumbnails.
 */
export function formatThumbnailDate(date: Date, style: ThumbnailDateStyle = 'long'): string {
  const month = MONTHS[date.getMonth()];
  const day = ordinal(date.getDate());
  if (style === 'short') return `${month.slice(0, 3)} ${day}`;
  if (style === 'weekday') return `${WEEKDAYS[date.getDay()]}, ${month} ${day}`;
  return `${month} ${day}, ${date.getFullYear()}`;
}

/**
 * Replaces {{title}} and {{date}} / {{date:style}} tokens. An unknown token is left verbatim so a
 * typo shows up in the preview rather than silently blanking a line.
 */
export function applyTokens(text: string, vars: ThumbnailVars): string {
  return text.replace(
    /\{\{\s*([a-zA-Z]+)(?::([a-zA-Z]+))?\s*\}\}/g,
    (whole: string, name: string, arg?: string) => {
      if (name === 'title') return vars.title ?? '';
      if (name === 'date') {
        if (!vars.date) return '';
        const style: ThumbnailDateStyle =
          arg === 'short' || arg === 'weekday' || arg === 'long' ? arg : 'long';
        return formatThumbnailDate(vars.date, style);
      }
      return whole;
    },
  );
}

// --- Layout ---

/** Measures the rendered width of a string at a given CSS font shorthand + tracking. */
export type MeasureText = (text: string, font: string, letterSpacingEm: number) => number;

export function fontShorthand(el: ThumbnailTextElement, sizePx: number): string {
  return `${el.italic ? 'italic ' : ''}${el.fontWeight} ${sizePx}px "Source Sans 3", sans-serif`;
}

/**
 * Greedy word wrap. Explicit newlines in the source are hard breaks and are always honoured; a
 * single word longer than maxWidth is left overflowing on its own line, which the shrink pass then
 * deals with.
 */
export function wrapText(text: string, maxWidthPx: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (measure(candidate) <= maxWidthPx) {
        line = candidate;
      } else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
  }
  return out;
}

export interface LaidOutLine {
  text: string;
  /** Anchor x in pixels; how it reads depends on the element's align (canvas textAlign matches). */
  x: number;
  /** Baseline y in pixels. */
  y: number;
}

export interface LaidOutElement {
  element: ThumbnailTextElement;
  /** Font size actually used, after shrink-to-fit. */
  fontSizePx: number;
  font: string;
  lines: LaidOutLine[];
  /** True when THIS element's own text had to shrink to fit — surfaced in the editor so an
   *  over-long title is an obvious, fixable warning rather than a silent visual regression.
   *  Following a linked element down (see `scaleWith`) does not count: that is the design working,
   *  and warning about it would bury the one element the operator actually needs to shorten. */
  shrunk: boolean;
  /** Final size as a fraction of the element's designed size, including any inherited scaling.
   *  This is what a linked element follows. */
  fitScale: number;
}

/** Floor on shrink-to-fit. Below this the text is too small to read on a phone-sized thumbnail, so
 *  we stop shrinking, let it overflow, and flag it rather than produce an unreadable image. */
const MIN_SHRINK_SCALE = 0.55;
const SHRINK_STEP = 0.96;

/**
 * Resolves one element to concrete pixel lines: substitutes tokens, wraps, shrinks to fit, and
 * positions. Pure and measurement-injected, so the geometry is unit-testable without a canvas.
 */
export function layoutElement(
  el: ThumbnailTextElement,
  vars: ThumbnailVars,
  canvasW: number,
  canvasH: number,
  measure: MeasureText,
  /** Scale inherited from a linked element (see `scaleWith`). 1 means "no linkage". */
  inheritedScale = 1,
): LaidOutElement {
  let text = applyTokens(el.text, vars);
  if (el.uppercase) text = text.toUpperCase();

  const maxWidthPx = el.maxWidth * canvasW;
  const designSizePx = el.fontSize * canvasH;
  // The inherited scale moves the starting point; this element can still shrink further from there
  // if its own text does not fit, and the floor stays relative to its own design size.
  const startSizePx = designSizePx * inheritedScale;

  let sizePx = startSizePx;
  let lines: string[] = [];
  for (;;) {
    const font = fontShorthand(el, sizePx);
    const m = (s: string) => measure(s, font, el.letterSpacing);
    lines = wrapText(text, maxWidthPx, m);
    const fits = lines.length <= el.maxLines && lines.every((l) => m(l) <= maxWidthPx + 0.5);
    if (fits || sizePx <= designSizePx * MIN_SHRINK_SCALE) break;
    sizePx = Math.max(designSizePx * MIN_SHRINK_SCALE, sizePx * SHRINK_STEP);
  }

  const font = fontShorthand(el, sizePx);
  const lineStep = sizePx * el.lineHeight;
  const blockHeight = lineStep * lines.length;

  // `y` pins an edge of the block; convert it to the baseline of the first line. The 0.78 factor
  // approximates the ascent of Source Sans 3, so a 'top' anchor sits roughly where the caps start
  // rather than where the em box does.
  const anchorY = el.y * canvasH;
  let firstBaseline: number;
  if (el.vAlign === 'top') firstBaseline = anchorY + sizePx * 0.78;
  else if (el.vAlign === 'middle') firstBaseline = anchorY - blockHeight / 2 + sizePx * 0.78;
  else firstBaseline = anchorY - blockHeight + sizePx * 0.78;

  const x = el.x * canvasW;

  return {
    element: el,
    fontSizePx: sizePx,
    font,
    shrunk: sizePx < startSizePx - 0.01,
    fitScale: designSizePx > 0 ? sizePx / designSizePx : 1,
    lines: lines.map((line, i) => ({ text: line, x, y: firstBaseline + i * lineStep })),
  };
}

export function layoutThumbnail(
  tpl: ThumbnailTemplate,
  vars: ThumbnailVars,
  canvasW: number,
  canvasH: number,
  measure: MeasureText,
): LaidOutElement[] {
  const byId = new Map(tpl.elements.map((el) => [el.id, el]));
  const done = new Map<string, LaidOutElement>();

  // `stack` carries the ids currently being resolved, so a template whose elements point at each
  // other in a loop settles on "no linkage" instead of recursing forever.
  function resolve(el: ThumbnailTextElement, stack: ReadonlySet<string>): LaidOutElement {
    const already = done.get(el.id);
    if (already) return already;

    let inherited = 1;
    const leaderId = el.scaleWith;
    if (leaderId && leaderId !== el.id && !stack.has(leaderId)) {
      const leader = byId.get(leaderId);
      if (leader) inherited = resolve(leader, new Set([...stack, el.id])).fitScale;
    }

    const laid = layoutElement(el, vars, canvasW, canvasH, measure, inherited);
    done.set(el.id, laid);
    return laid;
  }

  return tpl.elements.map((el) => resolve(el, new Set()));
}

// --- Canvas drawing ---

/** Measurement backed by a real 2D context, for use in the browser. */
export function canvasMeasurer(ctx: CanvasRenderingContext2D): MeasureText {
  return (text, font, letterSpacingEm) => {
    ctx.save();
    ctx.font = font;
    setLetterSpacing(ctx, font, letterSpacingEm);
    const w = ctx.measureText(text).width;
    ctx.restore();
    return w;
  };
}

/** `ctx.letterSpacing` takes a CSS length, so em has to be resolved against the font size first.
 *  Guarded because it is a comparatively recent canvas property. */
function setLetterSpacing(ctx: CanvasRenderingContext2D, font: string, em: number): void {
  if (!('letterSpacing' in ctx)) return;
  const target = ctx as CanvasRenderingContext2D & { letterSpacing: string };
  if (!em) {
    target.letterSpacing = '0px';
    return;
  }
  const sizeMatch = /(\d+(?:\.\d+)?)px/.exec(font);
  const sizePx = sizeMatch ? parseFloat(sizeMatch[1]) : 16;
  target.letterSpacing = `${em * sizePx}px`;
}

/**
 * Renders a complete thumbnail into a 2D context sized canvasW x canvasH.
 *
 * `plateImage` arrives already decoded rather than being fetched here: the same image is reused
 * across a whole batch of weekly thumbnails, and drawing has to be synchronous so callers can
 * export immediately afterwards without racing the image load.
 */
export function drawThumbnail(
  ctx: CanvasRenderingContext2D,
  tpl: ThumbnailTemplate,
  vars: ThumbnailVars,
  plateImage: CanvasImageSource | null,
  canvasW: number = THUMBNAIL_WIDTH,
  canvasH: number = THUMBNAIL_HEIGHT,
): LaidOutElement[] {
  ctx.save();
  ctx.fillStyle = tpl.backgroundColor;
  ctx.fillRect(0, 0, canvasW, canvasH);
  if (plateImage) ctx.drawImage(plateImage, 0, 0, canvasW, canvasH);
  ctx.restore();

  const laid = layoutThumbnail(tpl, vars, canvasW, canvasH, canvasMeasurer(ctx));

  for (const item of laid) {
    ctx.save();
    ctx.font = item.font;
    ctx.fillStyle = item.element.color;
    ctx.textAlign = item.element.align;
    ctx.textBaseline = 'alphabetic';
    setLetterSpacing(ctx, item.font, item.element.letterSpacing);
    for (const line of item.lines) {
      if (line.text) ctx.fillText(line.text, line.x, line.y);
    }
    ctx.restore();
  }

  return laid;
}

/** Loads the template's plate image, or null when the template has none or it fails to load. */
export function loadPlate(src: string | null): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * Renders a template to a JPEG File, ready to hand straight to the existing thumbnail upload field.
 * JPEG at q0.92 lands around 150-250KB for these images — comfortably inside the server's 2MB cap
 * and YouTube's own limit, where a PNG of the same photograph would not be.
 */
export async function renderThumbnailFile(
  tpl: ThumbnailTemplate,
  vars: ThumbnailVars,
  plateImage: CanvasImageSource | null,
  filename: string,
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  drawThumbnail(ctx, tpl, vars, plateImage);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.92),
  );
  if (!blob) throw new Error('Could not encode the thumbnail');
  return new File([blob], filename, { type: 'image/jpeg' });
}

/**
 * Parses a numeric design field, returning null for anything that is not a real number.
 *
 * Mantine's NumberInput emits `''` while a field is empty, and `Number('')` is 0 — so coercing
 * directly meant clearing "Font size" to retype it wrote 0, blanked the line out of the preview, and
 * persisted that on the next Save. Returning null lets the caller hold the last good value until a
 * usable number is typed.
 */
export function parseNumericField(
  value: string | number | null | undefined,
  min: number,
  max: number,
): number | null {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Makes a filename-safe slug from a stream title, for downloaded or attached thumbnails. */
export function thumbnailFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'thumbnail'}.jpg`;
}

/**
 * A probe string that forces BOTH declared subsets to download.
 *
 * `document.fonts.load(font)` with no text uses an ASCII default, which only matches the `latin`
 * @font-face's unicode-range — the `latin-ext` face is never requested, stays un-pending, and so
 * `document.fonts.ready` resolves without it. A title using a latin-ext glyph (a macron in a Latin
 * title, a name with ō/ś/ż) would then draw in a system sans with nothing to trigger a redraw.
 * 'A' covers latin; 'Ā' (U+0100) is the first codepoint of the latin-ext range.
 */
const FONT_PROBE = 'AĀ';

/**
 * Decodes the bundled webfont before anything is drawn. Canvas silently falls back to a system sans
 * if a face is not yet loaded, which would ship an off-brand image with no error anywhere.
 *
 * Resolves to false when one or more faces failed rather than throwing: a missing font file should
 * downgrade the typeface and warn, not take the whole generator down with it.
 */
export async function ensureThumbnailFont(): Promise<boolean> {
  if (typeof document === 'undefined' || !document.fonts) return false;
  const results = await Promise.allSettled([
    document.fonts.load('700 100px "Source Sans 3"', FONT_PROBE),
    document.fonts.load('600 100px "Source Sans 3"', FONT_PROBE),
    document.fonts.load('italic 600 100px "Source Sans 3"', FONT_PROBE),
  ]);
  await document.fonts.ready;
  // A face that resolves to an empty array matched no @font-face rule at all — i.e. the stylesheet
  // never loaded — which is just as broken as a network error, and equally silent.
  return results.every((r) => r.status === 'fulfilled' && r.value.length > 0);
}
