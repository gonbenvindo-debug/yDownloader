import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = import.meta.dirname;
const extension = join(root, 'extension');
const licenses = join(extension, 'third-party-licenses');
const outputsRoot = resolve(root, '..', '..', 'outputs');
const unpackedOutput = resolve(outputsRoot, 'yDownloader');
const outputRelativePath = relative(outputsRoot, unpackedOutput);
if (outputRelativePath === '..' || outputRelativePath.startsWith(`..${sep}`) || isAbsolute(outputRelativePath)) {
  throw new Error('O destino da extensão tem de ficar dentro da pasta outputs.');
}

await mkdir(licenses, { recursive: true });
const common = {
  bundle: true,
  minify: true,
  legalComments: 'none',
  platform: 'browser',
  target: 'chrome116',
};

await Promise.all([
  build({
    ...common,
    entryPoints: [join(root, 'src', 'content.js')],
    outfile: join(extension, 'content.js'),
    format: 'iife',
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src', 'player-bridge.js')],
    outfile: join(extension, 'player-bridge.js'),
    format: 'iife',
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src', 'service-worker.js')],
    outfile: join(extension, 'service-worker.js'),
    format: 'esm',
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src', 'sabr-offscreen.js')],
    outfile: join(extension, 'sabr-offscreen.js'),
    format: 'iife',
  }),
  copyFile(
    join(root, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm'),
    join(extension, 'emscripten-module.wasm'),
  ),
  copyFile(join(root, 'node_modules', 'youtubei.js', 'LICENSE'), join(licenses, 'youtubei.js-MIT.txt')),
  copyFile(join(root, 'node_modules', 'googlevideo', 'LICENSE'), join(licenses, 'googlevideo-MIT.txt')),
  copyFile(join(root, 'node_modules', 'mediabunny', 'LICENSE'), join(licenses, 'mediabunny-MPL-2.0.txt')),
  copyFile(join(root, 'node_modules', 'quickjs-emscripten-core', 'LICENSE'), join(licenses, 'quickjs-emscripten-core-MIT.txt')),
  copyFile(join(root, 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'LICENSE'), join(licenses, 'quickjs-wasmfile-release-sync-MIT.txt')),
  copyFile(join(root, 'node_modules', '@jitl', 'quickjs-ffi-types', 'LICENSE'), join(licenses, 'quickjs-ffi-types-MIT.txt')),
  copyFile(join(root, 'third-party-licenses', 'bufbuild-protobuf-2.16.0.txt'), join(licenses, 'bufbuild-protobuf-2.16.0.txt')),
  copyFile(join(root, 'node_modules', 'fflate', 'LICENSE'), join(licenses, 'fflate-MIT.txt')),
  copyFile(join(root, 'node_modules', 'meriyah', 'LICENSE.md'), join(licenses, 'meriyah-ISC.txt')),
]);

await rm(unpackedOutput, { recursive: true, force: true });
await mkdir(dirname(unpackedOutput), { recursive: true });
await cp(extension, unpackedOutput, { recursive: true });

console.log(`Extensão compilada em extension/ e atualizada em ${unpackedOutput}.`);
