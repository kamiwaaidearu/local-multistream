// Grid-based canvas template system
// Replaces the old absolute-positioning layer system with a CSS Grid-like model.

// --- Size Units ---
export type GridTrackSize =
  | { unit: 'fr'; value: number }
  | { unit: 'px'; value: number };

// --- Cell Content Types ---
export type CellContent =
  | { type: 'screenShare'; objectFit?: 'cover' | 'contain' | 'fill' }
  | { type: 'webcam'; objectFit?: 'cover' | 'contain' | 'fill' }
  | { type: 'image'; src: string; objectFit?: 'cover' | 'contain' | 'fill' }
  | {
      type: 'text';
      content: string;
      fontSize: number;
      fontFamily: string;
      fontWeight?: string;
      color: string;
      align?: 'left' | 'center' | 'right';
      verticalAlign?: 'top' | 'middle' | 'bottom';
    }
  | { type: 'empty' };

// --- Grid Cell ---
export interface GridCell {
  id: string;
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  content: CellContent;
  backgroundColor?: string;
  padding?: number;
  aspectRatio?: string; // e.g. '16:9' — locks row tracks to maintain ratio
}

// --- Grid Template ---
export interface GridTemplate {
  width: number;
  height: number;
  backgroundColor: string;
  columns: GridTrackSize[];
  rows: GridTrackSize[];
  gap?: number;
  cells: GridCell[];
}

// --- Default Template ---
// Keep in sync with server/db/index.ts DEFAULT_GRID_TEMPLATE
export const DEFAULT_GRID_TEMPLATE: GridTemplate = {
  width: 1920,
  height: 1080,
  backgroundColor: '#1a3a5c',
  columns: [
    { unit: 'fr', value: 4 },
    { unit: 'fr', value: 1 },
  ],
  rows: [
    { unit: 'fr', value: 1 },
    { unit: 'px', value: 200 },
  ],
  gap: 0,
  cells: [
    {
      id: 'screen',
      row: 0,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
      content: { type: 'screenShare' },
    },
    {
      id: 'camera',
      row: 1,
      col: 1,
      rowSpan: 1,
      colSpan: 1,
      content: { type: 'webcam' },
      backgroundColor: '#0d2137',
    },
    {
      id: 'footer',
      row: 1,
      col: 0,
      rowSpan: 1,
      colSpan: 1,
      content: { type: 'image', src: '/uploads/overlays/rm-logo.png', objectFit: 'contain' },
      backgroundColor: '#0d2137',
      padding: 10,
    },
    {
      id: 'branding',
      row: 0,
      col: 1,
      rowSpan: 1,
      colSpan: 1,
      content: {
        type: 'text',
        content: 'Join us at\nRosaryMen.com',
        fontSize: 36,
        fontFamily: 'sans-serif',
        fontWeight: 'bold',
        color: '#f0b429',
        align: 'center',
        verticalAlign: 'top',
      },
      padding: 15,
    },
  ],
};

// --- Grid Layout Utilities ---

/**
 * Resolves an array of track sizes (fr/px) into pixel values.
 * Mirrors CSS Grid track sizing: px tracks get exact size, fr tracks share remaining space.
 */
export function resolveTrackSizes(
  tracks: GridTrackSize[],
  totalPx: number,
  gap: number,
): number[] {
  if (tracks.length === 0) return [];

  const totalGap = gap * (tracks.length - 1);
  let available = totalPx - totalGap;
  if (available < 0) available = 0;

  // Sum fixed (px) tracks
  let pxTotal = 0;
  for (const t of tracks) {
    if (t.unit === 'px') pxTotal += t.value;
  }

  // If px tracks exceed available space, scale them down proportionally
  const pxScale = pxTotal > available && pxTotal > 0 ? available / pxTotal : 1;
  const frSpace = Math.max(0, available - pxTotal * pxScale);

  // Sum fr values
  let frTotal = 0;
  for (const t of tracks) {
    if (t.unit === 'fr') frTotal += t.value;
  }

  return tracks.map((t) => {
    if (t.unit === 'px') return t.value * pxScale;
    if (frTotal === 0) return 0;
    return (t.value / frTotal) * frSpace;
  });
}

/**
 * Computes the pixel bounds for a grid cell given resolved track sizes.
 */
export function getCellBounds(
  cell: GridCell,
  colSizes: number[],
  rowSizes: number[],
  gap: number,
): { x: number; y: number; width: number; height: number } {
  const rowSpan = cell.rowSpan ?? 1;
  const colSpan = cell.colSpan ?? 1;

  // x = sum of columns before this cell + their gaps
  let x = 0;
  for (let i = 0; i < cell.col; i++) {
    x += (colSizes[i] ?? 0) + gap;
  }

  // y = sum of rows before this cell + their gaps
  let y = 0;
  for (let i = 0; i < cell.row; i++) {
    y += (rowSizes[i] ?? 0) + gap;
  }

  // width = sum of spanned columns + gaps between them
  let width = 0;
  for (let i = cell.col; i < cell.col + colSpan && i < colSizes.length; i++) {
    width += colSizes[i] ?? 0;
    if (i > cell.col) width += gap;
  }

  // height = sum of spanned rows + gaps between them
  let height = 0;
  for (let i = cell.row; i < cell.row + rowSpan && i < rowSizes.length; i++) {
    height += rowSizes[i] ?? 0;
    if (i > cell.row) height += gap;
  }

  return { x, y, width, height };
}

/**
 * Computes draw dimensions for an image within an area, respecting objectFit.
 */
export function fitImageInArea(
  imgW: number,
  imgH: number,
  areaX: number,
  areaY: number,
  areaW: number,
  areaH: number,
  fit: 'cover' | 'contain' | 'fill' = 'fill',
): { x: number; y: number; width: number; height: number } {
  if (fit === 'fill') {
    return { x: areaX, y: areaY, width: areaW, height: areaH };
  }

  if (imgW === 0 || imgH === 0) {
    return { x: areaX, y: areaY, width: areaW, height: areaH };
  }

  const scale =
    fit === 'contain'
      ? Math.min(areaW / imgW, areaH / imgH)
      : Math.max(areaW / imgW, areaH / imgH);

  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const drawX = areaX + (areaW - drawW) / 2;
  const drawY = areaY + (areaH - drawH) / 2;

  return { x: drawX, y: drawY, width: drawW, height: drawH };
}

/**
 * Enforces aspect ratio constraints on locked cells by adjusting row tracks.
 * Column sizes are independent of rows, so this is stable (no circular dependency).
 * Returns the template unchanged if no adjustments are needed.
 */
export function applyAspectRatioConstraints(tpl: GridTemplate): GridTemplate {
  const g = tpl.gap ?? 0;
  const colPx = resolveTrackSizes(tpl.columns, tpl.width, g);
  const newRows = [...tpl.rows];
  let changed = false;

  for (const cell of tpl.cells) {
    if (!cell.aspectRatio) continue;
    const parts = cell.aspectRatio.split(':').map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) continue;
    const [aw, ah] = parts;

    const colSpan = cell.colSpan ?? 1;
    const rowSpan = cell.rowSpan ?? 1;

    // Compute cell width from column tracks
    let cellWidth = 0;
    for (let i = cell.col; i < cell.col + colSpan && i < colPx.length; i++) {
      cellWidth += colPx[i];
    }
    cellWidth += g * (colSpan - 1);

    // Target row height per spanned row
    const targetHeight = cellWidth * ah / aw;
    const gapSpace = g * (rowSpan - 1);
    const perRow = Math.round((targetHeight - gapSpace) / rowSpan);

    for (let i = cell.row; i < cell.row + rowSpan && i < newRows.length; i++) {
      if (newRows[i].unit !== 'px' || newRows[i].value !== perRow) {
        newRows[i] = { unit: 'px', value: perRow };
        changed = true;
      }
    }
  }

  return changed ? { ...tpl, rows: newRows } : tpl;
}
