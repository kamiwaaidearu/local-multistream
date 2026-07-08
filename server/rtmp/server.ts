// @ts-expect-error node-media-server doesn't have types
import NodeMediaServer from 'node-media-server';
import { config } from '../config.js';

let nms: InstanceType<typeof NodeMediaServer> | null = null;
// True while SOMETHING is publishing to the local RTMP key. The RTMP server can't tell who the
// publisher is — it's OBS when the operator points OBS here, or Web Studio's own ingest FFmpeg
// when the browser studio is live (that ingest publishes to this same key). So this is
// deliberately source-agnostic; callers that need to distinguish OBS from Studio check
// isStudioConnected() first (see /api/studio/status).
let rtmpPublishing = false;

export function isRtmpPublishing(): boolean {
  return rtmpPublishing;
}

export function startRtmpServer(): void {
  const nmsConfig = {
    logType: 1, // 0: none, 1: error, 2: debug, 3: ffdebug
    rtmp: {
      port: config.rtmpPort,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
    },
  };

  nms = new NodeMediaServer(nmsConfig);

  nms.on('prePublish', (id: string, streamPath: string) => {
    const expectedPath = `/live/${config.localStreamKey}`;
    if (streamPath === expectedPath) {
      rtmpPublishing = true;
      // Source-agnostic on purpose: this is either OBS or Web Studio's ingest FFmpeg.
      console.log(`[rtmp] Publisher connected: ${streamPath}`);
    } else {
      // Actually drop the session. node-media-server only aborts a publish if a prePublish
      // listener calls session.reject(); the old code merely logged, so a wrong (or absent)
      // key was silently accepted and would still be fanned out to the platforms.
      console.warn(`[rtmp] Rejecting stream with unexpected key: ${streamPath}`);
      nms?.getSession(id)?.reject();
    }
  });

  nms.on('donePublish', (_id: string, streamPath: string) => {
    const expectedPath = `/live/${config.localStreamKey}`;
    if (streamPath === expectedPath) {
      rtmpPublishing = false;
      console.log('[rtmp] Publisher disconnected');
    }
  });

  nms.run();
  console.log(`[rtmp] RTMP server listening on port ${config.rtmpPort}`);
}

export function stopRtmpServer(): void {
  if (nms) {
    nms.stop();
    nms = null;
    rtmpPublishing = false;
    console.log('[rtmp] RTMP server stopped');
  }
}
