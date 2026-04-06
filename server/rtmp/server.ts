// @ts-expect-error node-media-server doesn't have types
import NodeMediaServer from 'node-media-server';
import { config } from '../config.js';

let nms: InstanceType<typeof NodeMediaServer> | null = null;
let obsConnected = false;

export function isObsConnected(): boolean {
  return obsConnected;
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

  nms.on('prePublish', (_id: string, streamPath: string) => {
    const expectedPath = `/live/${config.localStreamKey}`;
    if (streamPath === expectedPath) {
      obsConnected = true;
      console.log(`[rtmp] OBS connected: ${streamPath}`);
    } else {
      console.warn(`[rtmp] Rejected stream with unexpected key: ${streamPath}`);
    }
  });

  nms.on('donePublish', (_id: string, streamPath: string) => {
    const expectedPath = `/live/${config.localStreamKey}`;
    if (streamPath === expectedPath) {
      obsConnected = false;
      console.log('[rtmp] OBS disconnected');
    }
  });

  nms.run();
  console.log(`[rtmp] RTMP server listening on port ${config.rtmpPort}`);
}

export function stopRtmpServer(): void {
  if (nms) {
    nms.stop();
    nms = null;
    obsConnected = false;
    console.log('[rtmp] RTMP server stopped');
  }
}
