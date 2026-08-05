// What a private test stream is allowed to do on Facebook.
//
// This module exists because "I checked every call site" turned out not to be good enough: the first
// implementation gated the two announcement-post paths and the go-live publish, but missed
// retryPlatformLive, which would have published a test broadcast to the Page on a "Retry go-live"
// click. Enumerating the publicity-causing actions as a TYPE means a new one can't be added without
// coming through here, and the test suite asserts every member of that type is refused for a test
// stream.

/**
 * Every Facebook action that can make content visible to people other than the Page admins.
 *
 * Adding a new way to publish to the Page? Add it here. The exhaustive test in
 * testStreamPolicy.test.ts will then require it to be refused for test streams, and TypeScript will
 * point at any switch that doesn't handle it.
 */
export type FacebookPublicAction =
  /** POST /{page}/feed with a future publish time — the advance reminder posts. */
  | 'schedule_announcements'
  /** POST /{page}/feed — the "we're live now" post. */
  | 'golive_post'
  /** POST /{live-video-id} status=LIVE_NOW — makes the live video visible on the Page. */
  | 'publish_live_now';

/** All members of FacebookPublicAction, so tests can enumerate them exhaustively. */
export const FACEBOOK_PUBLIC_ACTIONS: readonly FacebookPublicAction[] = [
  'schedule_announcements',
  'golive_post',
  'publish_live_now',
] as const;

/**
 * May this stream perform a publicity-causing Facebook action?
 *
 * A test stream may never do any of them — that is the entire meaning of the flag. Note the argument
 * is the raw 0/1 column: callers pass `stream.is_test` directly so there's no chance of a truthiness
 * mistake on the way in.
 */
export function mayPublishToFacebook(isTest: number | boolean, _action: FacebookPublicAction): boolean {
  return !(isTest === 1 || isTest === true);
}

/**
 * How should a test stream's Facebook live video be cleaned up when the stream ends?
 *
 * Ending an unpublished broadcast leaves it unpublished (owner-only), but "invisible" and "absent" are
 * different promises, and only one of them is easy to verify by looking at the Page. So a test
 * stream's video is DELETED rather than ended, leaving no residue at all.
 */
export function shouldDeleteFacebookVideoOnEnd(isTest: number | boolean): boolean {
  return isTest === 1 || isTest === true;
}
