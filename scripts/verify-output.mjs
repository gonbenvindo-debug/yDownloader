import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ALL_FORMATS, EncodedPacketSink, FilePathSource, Input } from 'mediabunny';
import { inspectMedia } from '../src/media-merge.js';

const filePath = resolve(
  process.argv[2] ||
    '../../outputs/test-4k/Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film.webm',
);
const expectedDuration = Number(process.env.EXPECTED_DURATION || 634.581);
const input = new Input({ source: new FilePathSource(filePath), formats: ALL_FORMATS });
const packetCounts = {};
let details;
try {
  const { video, audio, ...metadata } = await inspectMedia(input, input, {
    width: 3840,
    height: 2160,
    durationSeconds: expectedDuration,
  });
  for (const [name, track] of [
    ['video', video],
    ['audio', audio],
  ]) {
    let count = 0;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      assert.ok(packet.data.length > 0);
      count++;
    }
    assert.ok(count > 0);
    packetCounts[name] = count;
  }
  details = metadata;
} finally {
  input.dispose();
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(filePath)) hash.update(chunk);
const report = {
  verifiedAt: new Date().toISOString(),
  file: filePath,
  size: (await stat(filePath)).size,
  sha256: hash.digest('hex'),
  ...details,
  packetCounts,
};
await writeFile(
  resolve('../../outputs/test-4k/verification.json'),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
