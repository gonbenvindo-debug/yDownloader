import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDuration, inspectMedia, mergeMedia } from '../src/media-merge.js';

function inputs({ width = 3840, height = 2160, videoDuration = 10, audioDuration = 10 } = {}) {
  const video = {
    getDisplayWidth: () => width,
    getDisplayHeight: () => height,
    computeDuration: () => videoDuration,
    getCodec: () => 'vp9',
  };
  const audio = { computeDuration: () => audioDuration, getCodec: () => 'opus' };
  const videoInput = {
    disposed: false,
    dispose() {
      this.disposed = true;
    },
    getPrimaryVideoTrack: async () => video,
  };
  const audioInput = {
    disposed: false,
    dispose() {
      this.disposed = true;
    },
    getPrimaryAudioTrack: async () => audio,
  };
  return { videoInput, audioInput };
}

test('duration validation rejects empty, invalid and truncated streams', () => {
  for (const value of [0, -1, NaN, Infinity])
    assert.throws(() => checkDuration(value, 10, 'vídeo'));
  assert.throws(() => checkDuration(40, 634, 'vídeo'), /incompleto/);
  assert.doesNotThrow(() => checkDuration(633.9, 634, 'vídeo'));
});

test('media inspection checks both tracks and actual dimensions', async () => {
  const { videoInput, audioInput } = inputs();
  const media = await inspectMedia(videoInput, audioInput, {
    width: 3840,
    height: 2160,
    durationSeconds: 10,
  });
  assert.equal(media.height, 2160);
  assert.equal(media.audioCodec, 'opus');
  await assert.rejects(inspectMedia(videoInput, audioInput, { height: 1080 }), /resolução/);
  await assert.rejects(
    inspectMedia(videoInput, { getPrimaryAudioTrack: async () => null }),
    /áudio/,
  );
  const truncated = inputs({ audioDuration: 2 });
  await assert.rejects(
    inspectMedia(truncated.videoInput, truncated.audioInput, { durationSeconds: 10 }),
    /áudio.*incompleto/,
  );
});

test('failed input validation aborts the output and disposes both inputs', async () => {
  const media = inputs({ videoDuration: 2 });
  let aborted = false;
  let closed = false;
  await assert.rejects(
    mergeMedia({
      ...media,
      writable: {
        abort: async () => {
          aborted = true;
        },
        close: async () => {
          closed = true;
        },
      },
      extension: 'webm',
      expected: { durationSeconds: 10 },
    }),
    /incompleto/,
  );
  assert.ok(aborted);
  assert.equal(closed, false);
  assert.ok(media.videoInput.disposed && media.audioInput.disposed);
});

test('cancellation before muxing aborts the atomic write without committing a file', async () => {
  const media = inputs();
  const controller = new AbortController();
  controller.abort(new DOMException('Cancelled', 'AbortError'));
  let aborted = false;
  await assert.rejects(
    mergeMedia({
      ...media,
      writable: {
        abort: async () => {
          aborted = true;
        },
      },
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.ok(aborted && media.videoInput.disposed && media.audioInput.disposed);
});
