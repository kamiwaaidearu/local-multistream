import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mayPublishToFacebook,
  shouldDeleteFacebookVideoOnEnd,
  FACEBOOK_PUBLIC_ACTIONS,
} from './testStreamPolicy.js';

describe('mayPublishToFacebook', () => {
  it('refuses EVERY publicity-causing action for a test stream', () => {
    // Exhaustive by construction: a new FacebookPublicAction must be added to
    // FACEBOOK_PUBLIC_ACTIONS, and this assertion then covers it automatically.
    for (const action of FACEBOOK_PUBLIC_ACTIONS) {
      assert.equal(mayPublishToFacebook(1, action), false, `test stream must refuse ${action}`);
    }
  });

  it('allows every action for a real stream', () => {
    for (const action of FACEBOOK_PUBLIC_ACTIONS) {
      assert.equal(mayPublishToFacebook(0, action), true, `real stream must allow ${action}`);
    }
  });

  it('covers the three known Page-visible actions', () => {
    // Guards against someone quietly shrinking the list rather than gating a new path.
    assert.deepEqual([...FACEBOOK_PUBLIC_ACTIONS].sort(), [
      'golive_post',
      'publish_live_now',
      'schedule_announcements',
    ]);
  });

  it('treats only 1/true as a test stream, not arbitrary truthiness', () => {
    assert.equal(mayPublishToFacebook(true, 'golive_post'), false);
    assert.equal(mayPublishToFacebook(false, 'golive_post'), true);
    assert.equal(mayPublishToFacebook(0, 'golive_post'), true);
  });
});

describe('shouldDeleteFacebookVideoOnEnd', () => {
  it('deletes a test stream’s video so nothing lingers on the Page', () => {
    assert.equal(shouldDeleteFacebookVideoOnEnd(1), true);
    assert.equal(shouldDeleteFacebookVideoOnEnd(true), true);
  });

  it('never deletes a real broadcast — its VOD is the recording', () => {
    assert.equal(shouldDeleteFacebookVideoOnEnd(0), false);
    assert.equal(shouldDeleteFacebookVideoOnEnd(false), false);
  });
});
