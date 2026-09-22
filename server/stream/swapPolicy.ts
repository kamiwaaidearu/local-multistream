// Swapping the content of two events while leaving their dates alone.
//
// The use case: a series is scheduled out for a month, then the order of the topics needs to
// change. Re-typing two titles/descriptions and re-uploading two thumbnails is error-prone —
// especially since each event already has live YouTube/Facebook destinations and scheduled
// Facebook announcement posts pointing at it, all of which have to follow the content.
//
// What swaps is the CONTENT: name, description, thumbnail. What stays put is everything tied to the
// slot rather than the topic: the scheduled date/time, the series, the per-stream Facebook reminder
// toggle, the test flag, and the platform destinations themselves (a YouTube broadcast keeps its id
// and its date and simply gets re-titled — it is not torn down and recreated).

/** The subset of a stream row a swap reads. */
export interface SwappableStream {
  id: string;
  name: string;
  description: string | null;
  thumbnail_path: string | null;
  status: string;
}

/**
 * The fields a swap exchanges. Adding a content field to `streams` that should travel with the
 * topic? Add it here and to SwappableStream — the swap route writes exactly this list.
 */
export const SWAPPED_FIELDS = ['name', 'description', 'thumbnail_path'] as const;
export type SwappedField = (typeof SWAPPED_FIELDS)[number];

/** Statuses whose content may still be edited — the same rule PATCH /streams/:id enforces. */
const EDITABLE_STATUSES = ['draft', 'ready'];

export function isSwappable(status: string): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/**
 * Why these two events can't be swapped, or null if they can.
 *
 * Kept separate from the route so the rules are testable without a database, and so the operator
 * gets one specific sentence instead of a generic 400.
 */
export function swapRefusalReason(a: SwappableStream, b: SwappableStream): string | null {
  if (a.id === b.id) return 'Pick two different events to swap.';
  for (const s of [a, b]) {
    if (!isSwappable(s.status)) {
      return `Can only swap draft or ready events — "${s.name}" is ${s.status}.`;
    }
  }
  return null;
}

/** One event's post-swap content. */
export interface SwapAssignment {
  id: string;
  name: string;
  description: string | null;
  thumbnail_path: string | null;
}

/**
 * The content each event ends up with: a takes b's, b takes a's. Dates are absent by construction —
 * this function cannot move an event, which is the property the whole feature rests on.
 */
export function planSwap(a: SwappableStream, b: SwappableStream): [SwapAssignment, SwapAssignment] {
  return [
    { id: a.id, name: b.name, description: b.description, thumbnail_path: b.thumbnail_path },
    { id: b.id, name: a.name, description: a.description, thumbnail_path: a.thumbnail_path },
  ];
}
