// Copies the MediaPipe wasm runtime out of node_modules into public/mediapipe/wasm so the app
// self-hosts it (no CDN dependency at stream time) without committing ~22MB of vendored binaries.
// Runs automatically before `dev` and `build` (see predev/prebuild in package.json).
//
// The .tflite model is NOT copied here — it isn't shipped in the npm package, so it lives in the
// repo at public/mediapipe/selfie_segmenter.tflite (small, ~249KB).
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, '..');
const srcDir = join(clientRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const destDir = join(clientRoot, 'public', 'mediapipe', 'wasm');

// Only the two variants FilesetResolver actually loads: SIMD, plus the no-SIMD fallback.
const files = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

if (!existsSync(srcDir)) {
  console.error(`[copy-mediapipe-wasm] source not found: ${srcDir}\nRun "npm install" first.`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
for (const f of files) {
  const from = join(srcDir, f);
  if (!existsSync(from)) {
    console.error(`[copy-mediapipe-wasm] missing expected file: ${from}`);
    process.exit(1);
  }
  copyFileSync(from, join(destDir, f));
}
console.log(`[copy-mediapipe-wasm] copied ${files.length} files -> public/mediapipe/wasm`);
