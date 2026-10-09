import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { collectPlayerSnapshot, parseInlinePlayerResponse } from '../src/player-snapshot.js';
import { normalizePlayerSnapshot, resolutionHeight } from '../src/player-data.js';
import { requestPlayerSnapshot } from '../src/player-client.js';
import { PLAYER_REQUEST, PLAYER_RESPONSE } from '../src/player-protocol.js';

const videoId = 'jNQXAC9IVRw';
const otherId = 'dQw4w9WgXcQ';
const response = id => ({
  videoDetails: { videoId: id, title: 'Current video', lengthSeconds: '19' },
  streamingData: { adaptiveFormats: [
    { itag: 133, mimeType: 'video/mp4; codecs="avc1.4D400C"', height: 240, qualityLabel: '240p' },
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', audioQuality: 'AUDIO_QUALITY_MEDIUM' },
  ] },
  trackingParams: 'Must not cross the bridge',
});
function environment({ player, initial, ytd, scripts = [] } = {}) {
  return {
    window: { ytInitialPlayerResponse: initial },
    document: {
      getElementById: () => player,
      querySelector: selector => selector === 'ytd-player, ytm-player' ? ytd : null,
      scripts: scripts.map(textContent => ({ textContent })),
    },
  };
}

test('reads the current player response and native quality data without forwarding tracking data', () => {
  const snapshot = collectPlayerSnapshot(environment({ player: {
    getPlayerResponse: () => response(videoId),
    getVideoData: () => ({ video_id: videoId }),
    getAvailableQualityData: () => [
      { quality: 'hd1080', qualityLabel: '1080p60' },
      { quality: 'hd1080', qualityLabel: '1080p Premium' },
      { quality: 'auto', qualityLabel: 'Automática' },
    ],
    getAvailableQualityLevels: () => ['small', 'medium', 'auto'],
  } }), videoId);
  assert.deepEqual(snapshot.qualities.map(value => value.height), [240, 360, 1080]);
  assert.equal(snapshot.streamingData.adaptiveFormats[0].itag, 133);
  assert.equal(snapshot.durationSeconds, 19);
  assert.equal(snapshot.trackingParams, undefined);
});

test('SPA navigation uses the new response and rejects the previous player and initial response', () => {
  const oldPlayer = {
    getPlayerResponse: () => response(videoId),
    getVideoData: () => ({ video_id: videoId }),
    getAvailableQualityLevels: () => ['hd2160'],
  };
  const env = environment({ player: oldPlayer, initial: response(videoId), ytd: { playerResponse: response(otherId) } });
  const snapshot = collectPlayerSnapshot(env, otherId);
  assert.equal(snapshot.videoId, otherId);
  assert.deepEqual(snapshot.qualities, []);
  assert.equal(collectPlayerSnapshot(environment({ player: oldPlayer, initial: response(videoId) }), otherId), null);
  assert.equal(normalizePlayerSnapshot(snapshot, videoId), null);
});

test('parses inline JSON with escaped quotes and braces without executing the rest of the script', () => {
  const raw = response(videoId);
  raw.videoDetails.title = 'A title with }; and a "quoted" \\ brace }';
  const text = `var ytInitialPlayerResponse = ${JSON.stringify(raw)}; throw new Error('do not execute');`;
  assert.deepEqual(parseInlinePlayerResponse(text), raw);
  assert.equal(collectPlayerSnapshot(environment({ scripts: [text] }), videoId).title, raw.videoDetails.title);
  assert.equal(parseInlinePlayerResponse('var ytInitialPlayerResponse = {broken};'), null);
});

test('native quality levels work when the raw response is not exposed', () => {
  const snapshot = collectPlayerSnapshot(environment({ player: {
    getPlayerResponse: () => { throw new Error('unsupported method'); },
    getVideoData: () => ({ video_id: videoId, title: 'Native only' }),
    getAvailableQualityLevels: () => ['hd2160', 'hd1080', 'medium', 'auto', 'highres'],
  } }), videoId);
  assert.deepEqual(snapshot.qualities.map(value => value.height), [360, 1080, 2160]);
  assert.deepEqual(snapshot.streamingData.adaptiveFormats, []);
});

test('portrait labels select 1080p while preserving the true dimensions for SABR', () => {
  const snapshot = normalizePlayerSnapshot({videoId, streamingData:{adaptiveFormats:[
    {itag:137,mimeType:'video/mp4; codecs="avc1.640028"',width:1080,height:1920,qualityLabel:'1080p'},
  ]}}, videoId);
  const format = snapshot.info.streaming_data.adaptive_formats[0];
  assert.equal(format.height, 1920);
  assert.equal(resolutionHeight(format), 1080);
});

test('untrusted page formats cannot supply foreign download URLs or ciphers', () => {
  const snapshot = normalizePlayerSnapshot({videoId, streamingData:{formats:[
    {itag:18,mimeType:'video/mp4; codecs="avc1.42001E, mp4a.40.2"',height:360,url:'https://example.com/file',signatureCipher:'url=https%3A%2F%2Fexample.com%2Ffile&s=example'},
  ]}}, videoId);
  const format = snapshot.info.streaming_data.formats[0];
  assert.equal(format.url, undefined);
  assert.equal(format.signature_cipher, undefined);
});

test('bridge client accepts only the matching response and removes its listener', async () => {
  const listeners = new Set();
  const page = {
    location: { origin: 'https://www.youtube.com' },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    postMessage(request, origin) {
      assert.equal(request.type, PLAYER_REQUEST);
      assert.equal(origin, page.location.origin);
      queueMicrotask(() => {
        const reply = {type:PLAYER_RESPONSE,requestId:request.requestId,playerData:{videoId}};
        for (const listener of [...listeners]) {
          listener({source:page,origin:'https://example.com',data:reply});
          listener({source:page,origin,data:{...reply,requestId:crypto.randomUUID()}});
          listener({source:page,origin,data:reply});
        }
      });
    },
  };
  assert.deepEqual(await requestPlayerSnapshot(videoId, page), {videoId});
  assert.equal(listeners.size, 0);
});

test('the compiled MAIN bridge and isolated client exchange current page formats with fetch blocked', async () => {
  const env = environment({initial:response(videoId),player:{
    getVideoData:()=>({video_id:videoId}),getAvailableQualityLevels:()=>['small'],
  }});
  const listeners = new Set();
  const location = {origin:'https://www.youtube.com',href:`https://www.youtube.com/watch?v=${videoId}`,pathname:'/watch'};
  Object.assign(env.window, {
    location,
    addEventListener:(_type,listener)=>listeners.add(listener),
    removeEventListener:(_type,listener)=>listeners.delete(listener),
    postMessage(data,origin) {
      assert.equal(origin,location.origin);
      queueMicrotask(()=>{for(const listener of [...listeners])listener({source:env.window,origin,data});});
    },
  });
  const bridge = await readFile(new URL('../extension/player-bridge.js',import.meta.url),'utf8');
  runInNewContext(bridge,{...env,location,URL,fetch:()=>{throw new Error('network blocked');}});
  const snapshot=await requestPlayerSnapshot(videoId,env.window);
  assert.equal(snapshot.streamingData.adaptiveFormats.length,2);
  assert.equal(snapshot.qualities[0].height,240);
  assert.equal(listeners.size,1); // Only the persistent MAIN listener remains.
});
