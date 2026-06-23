import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { handleBandwidthProbe, type BandwidthProbeOptions } from './bandwidthProbe.js';

/** Spin up a probe server on an ephemeral port, run `fn` with a connected client, then tear down. */
async function withProbeServer(
  fn: (client: WebSocket) => Promise<void>,
  opts?: BandwidthProbeOptions,
): Promise<void> {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
  wss.on('connection', (ws) => handleBandwidthProbe(ws, opts));
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as { port: number };

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    await fn(client);
  } finally {
    client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

/** Resolve with the byte count from the first ack reporting at least `target` bytes. */
function waitForBytes(client: WebSocket, target: number, timeoutMs = 3000): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onMessage = (data: Buffer) => {
      const ack = JSON.parse(data.toString()) as { bytes: number };
      if (ack.bytes >= target) {
        clearTimeout(timer);
        client.off('message', onMessage);
        resolve(ack.bytes);
      }
    };
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error(`timed out waiting for ${target} bytes`));
    }, timeoutMs);
    client.on('message', onMessage);
  });
}

test('acks report the exact number of bytes received', async () => {
  await withProbeServer(async (client) => {
    const chunk = Buffer.alloc(64 * 1024, 7); // 65536 bytes of non-zero data
    const count = 5;
    for (let i = 0; i < count; i++) client.send(chunk);
    const reported = await waitForBytes(client, chunk.length * count);
    assert.equal(reported, chunk.length * count);
  });
});

test('acks are valid JSON with a numeric bytes field, even before any data arrives', async () => {
  await withProbeServer(async (client) => {
    const ack = await new Promise<{ bytes: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ack within timeout')), 3000);
      client.once('message', (data: Buffer) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    });
    assert.equal(typeof ack.bytes, 'number');
    assert.ok(ack.bytes >= 0);
  });
});

test('the byte total is cumulative across multiple messages', async () => {
  await withProbeServer(async (client) => {
    const chunk = Buffer.alloc(10_000, 1);
    client.send(chunk);
    assert.equal(await waitForBytes(client, 10_000), 10_000);
    client.send(chunk);
    client.send(chunk);
    assert.equal(await waitForBytes(client, 30_000), 30_000);
  });
});

test('refuses the probe with code 4002 when a stream is live', async () => {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
  wss.on('connection', (ws) => handleBandwidthProbe(ws, { isBusy: () => true }));
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as { port: number };

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  client.on('error', () => { /* a refusal can surface as an error before close; ignore */ });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe was not refused')), 3000);
      client.on('close', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 4002);
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

test('closes the socket once the byte cap is exceeded', async () => {
  await withProbeServer(async (client) => {
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('byte cap was not enforced')), 3000);
      client.on('close', () => { clearTimeout(timer); resolve(); });
    });
    const chunk = Buffer.alloc(16 * 1024, 9);
    const pump = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) client.send(chunk);
    }, 5);
    await closed;
    clearInterval(pump);
  }, { maxBytes: 64 * 1024 });
});
