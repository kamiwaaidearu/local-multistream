import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CERT_PATH = path.join(DATA_DIR, 'localhost.cert');
const KEY_PATH = path.join(DATA_DIR, 'localhost.key');

export async function getOrCreateCert(): Promise<{ private: string; cert: string }> {
  // Return existing cert if available
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return {
      private: fs.readFileSync(KEY_PATH, 'utf-8'),
      cert: fs.readFileSync(CERT_PATH, 'utf-8'),
    };
  }

  // Generate a new self-signed cert valid for 365 days
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = await (selfsigned as any).generate(attrs, {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ]},
    ],
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_PATH, pems.private);
  fs.writeFileSync(CERT_PATH, pems.cert);
  console.log('[cert] Generated self-signed certificate for localhost');

  return { private: pems.private, cert: pems.cert };
}
