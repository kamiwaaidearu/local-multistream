import { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Watches the studio's capture tracks for death or silence.
//
// This closes a blind spot that every other health signal shares: a dead capture device does not look
// like a fault anywhere downstream. If the camera is unplugged or the microphone is claimed by another
// app, the compositor keeps painting its last frame, the encoder keeps producing a full-bitrate CBR
// stream, and Facebook/YouTube keep reporting a perfectly healthy ingest at 6000 kbps and 30 fps.
// The broadcast looks flawless from every angle except the one that matters.
//
// A MediaStreamTrack tells us directly:
//   'ended' — the device is gone (unplugged, permission revoked, screen-share stopped).
//   'mute'  — the track is live but producing nothing (device claimed elsewhere, hardware mute switch).
// Both are reported to the server so they reach the log and the alert webhook, because the operator is
// on camera and cannot be watching a banner.

export interface WatchedSource {
  /** Operator-facing name, e.g. 'Camera' or 'Shure MV7'. */
  label: string;
  stream: MediaStream | null;
}

export interface DeadTrack {
  label: string;
  kind: 'audio' | 'video';
  /** 'ended' is terminal; 'muted' can recover on its own. */
  problem: 'ended' | 'muted';
}

/**
 * Report any capture track that has ended or gone silent.
 *
 * `active` gates reporting: we only want to shout about this while it matters (connected or live), not
 * while the operator is still assembling their sources and legitimately toggling devices on and off.
 */
export function useTrackWatch(sources: WatchedSource[], active: boolean): DeadTrack[] {
  const [dead, setDead] = useState<DeadTrack[]>([]);

  // Identity of the watched set, so the effect re-subscribes when sources change but not on every
  // render (a MediaStream array is a new object each time even when its contents are identical).
  const key = sources
    .map((s) => `${s.label}:${s.stream?.getTracks().map((t) => t.id).join(',') ?? 'none'}`)
    .join('|');

  useEffect(() => {
    if (!active) {
      setDead([]);
      return;
    }

    const cleanups: (() => void)[] = [];

    const recompute = () => {
      const problems: DeadTrack[] = [];
      for (const source of sources) {
        for (const track of source.stream?.getTracks() ?? []) {
          // readyState 'ended' also covers tracks that died before we attached a listener.
          if (track.readyState === 'ended') {
            problems.push({ label: source.label, kind: track.kind as 'audio' | 'video', problem: 'ended' });
          } else if (track.muted) {
            problems.push({ label: source.label, kind: track.kind as 'audio' | 'video', problem: 'muted' });
          }
        }
      }
      setDead(problems);
      return problems;
    };

    // Report only transitions. A track that is dead stays dead, and we must not re-alert every event.
    let reported = new Set<string>();
    const idOf = (d: DeadTrack) => `${d.label}:${d.kind}:${d.problem}`;

    const onChange = () => {
      const problems = recompute();
      const now = new Set(problems.map(idOf));

      for (const d of problems) {
        if (reported.has(idOf(d))) continue;
        const what = d.kind === 'audio' ? 'Audio' : 'Video';
        void api.reportStudioAlert({
          kind: 'track_ended',
          subject: d.label,
          message: d.problem === 'ended'
            ? `${what} from "${d.label}" has STOPPED (device disconnected or permission revoked). ` +
              'The stream is still running but this source is dead.'
            : `${what} from "${d.label}" has gone silent (the device is muted or in use by another app).`,
        }).catch(() => { /* never disturb a live stream */ });
      }

      for (const gone of reported) {
        if (!now.has(gone)) {
          const [label] = gone.split(':');
          void api.reportStudioAlert({
            kind: 'track_ended', subject: label, message: `"${label}" is working again.`, resolved: true,
          }).catch(() => { /* ignore */ });
        }
      }
      reported = now;
    };

    for (const source of sources) {
      for (const track of source.stream?.getTracks() ?? []) {
        track.addEventListener('ended', onChange);
        track.addEventListener('mute', onChange);
        track.addEventListener('unmute', onChange);
        cleanups.push(() => {
          track.removeEventListener('ended', onChange);
          track.removeEventListener('mute', onChange);
          track.removeEventListener('unmute', onChange);
        });
      }
    }

    // Catch anything already broken at subscribe time, then poll slowly as a backstop: `muted` is not
    // reliably accompanied by an event on every browser/OS combination.
    onChange();
    const poll = window.setInterval(onChange, 5000);
    cleanups.push(() => window.clearInterval(poll));

    return () => cleanups.forEach((fn) => fn());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  return dead;
}
