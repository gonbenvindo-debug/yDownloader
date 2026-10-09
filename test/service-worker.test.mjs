import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const videoId = 'jNQXAC9IVRw';
const sender = {url:`https://www.youtube.com/watch?v=${videoId}`,tab:{id:42}};
const events = {};
const stored = {};
let fetchCalls = 0;
let storageReads = 0;
let downloaded;
let sabrJob;
let opened;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { fetchCalls++; throw new TypeError('Failed to fetch'); };
const event = name => ({addListener: listener => { events[name] = listener; }});
globalThis.chrome = {
  runtime: {
    getURL: path => `chrome-extension://test/${path}`,
    onMessage: event('message'),
    getContexts: async () => [],
    sendMessage: async message => { sabrJob = message; return {accepted:true}; },
  },
  webRequest: {onBeforeRequest:event('request')},
  tabs: {onRemoved:event('removed'),get:async()=>sender.tab,create:async options=>{opened=options;return{id:43};}},
  storage: {session:{
    get: async key => { storageReads++; return key === null ? {...stored} : {[key]:stored[key]}; },
    set: async data => Object.assign(stored,data),
    remove: async key => { delete stored[key]; },
  }},
  downloads: {download:(options,callback)=>{downloaded=options;callback(123);}},
  offscreen: {createDocument:async()=>{}},
  declarativeNetRequest: {updateSessionRules:async()=>{}},
};
// Exercise the packaged worker, with network access blocked as in the reported failure.
await import('../extension/service-worker.js');
after(() => { globalThis.fetch = originalFetch; delete globalThis.chrome; });
beforeEach(() => {
  fetchCalls=0; storageReads=0; downloaded=undefined; sabrJob=undefined; opened=undefined;
  for (const key of Object.keys(stored)) delete stored[key];
});

function message(payload) {
  return new Promise((resolve,reject) => {
    const timeout=setTimeout(()=>reject(new Error('No response from the service worker')),2000);
    const keepAlive=events.message({videoId,...payload},sender,result=>{clearTimeout(timeout);resolve(result);});
    if (keepAlive!==true) { clearTimeout(timeout); reject(new Error('Message was not accepted')); }
  });
}
const sabrSnapshot = () => ({
  videoId,title:'Me at the zoo',durationSeconds:19,qualities:[],
  streamingData: {adaptiveFormats:[
    {itag:133,mimeType:'video/mp4; codecs="avc1.4D400C"',width:320,height:240,qualityLabel:'240p',bitrate:150000,lastModified:'123456',approxDurationMs:'19000'},
    {itag:160,mimeType:'video/mp4; codecs="avc1.4D400B"',width:192,height:144,qualityLabel:'144p',bitrate:50000,lastModified:'123456',approxDurationMs:'19000'},
    {itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',audioQuality:'AUDIO_QUALITY_MEDIUM',bitrate:128000,lastModified:'123456',approxDurationMs:'19000'},
  ]},
});

test('resolutions from the page remain available when every fetch is blocked', async () => {
  const result=await message({type:'get-resolutions',playerData:sabrSnapshot()});
  assert.equal(result.source,'player');
  assert.deepEqual(result.resolutions,[
    {height:144,mode:'sabr',extension:'mp4'},
    {height:240,mode:'sabr',extension:'mp4'},
  ]);
  assert.equal(fetchCalls,0);
  assert.equal(storageReads,0);
});

test('native-only qualities are shown without requiring stream extraction', async () => {
  const result=await message({type:'get-resolutions',playerData:{videoId,qualities:[{height:1080},{height:360},{height:1080}]}});
  assert.deepEqual(result.resolutions,[{height:360,mode:'player',extension:null},{height:1080,mode:'player',extension:null}]);
  assert.equal(fetchCalls,0);
});

test('stale metadata cannot return resolutions for another video', async () => {
  const result=await message({type:'get-resolutions',playerData:{...sabrSnapshot(),videoId:'dQw4w9WgXcQ'}});
  assert.match(result.error,/ler este vídeo/);
  assert.equal(fetchCalls,0);
});

test('DRM formats are excluded even when the native selector reports that height', async () => {
  const snapshot=sabrSnapshot();
  snapshot.qualities=[{height:240}];
  snapshot.streamingData.adaptiveFormats[0].drmFamilies=['WIDEVINE'];
  const result=await message({type:'get-resolutions',playerData:snapshot});
  assert.deepEqual(result.resolutions,[{height:144,mode:'sabr',extension:'mp4'}]);
});

test('direct playback URLs reuse the page formats without a new player request', async () => {
  const playerData={videoId,streamingData:{formats:[
    {itag:18,mimeType:'video/mp4; codecs="avc1.42001E, mp4a.40.2"',height:360,qualityLabel:'360p',url:'https://r1.test.googlevideo.com/videoplayback?itag=18'},
  ]}};
  const list=await message({type:'get-resolutions',playerData});
  assert.deepEqual(list.resolutions,[{height:360,mode:'direct',extension:'mp4'}]);
  const result=await message({type:'download',resolution:360,mode:'direct',playerData});
  assert.equal(result.downloadId,123);
  assert.equal(downloaded.url,playerData.streamingData.formats[0].url);
  assert.equal(fetchCalls,0);
});

test('SABR transfer preparation reuses page metadata and the captured playback session', async () => {
  stored['sabr-session:42']={videoId,capturedAt:Date.now(),serverAbrStreamingUrl:'https://r1.test.googlevideo.com/videoplayback?sabr=1',poToken:'test-token',videoPlaybackUstreamerConfig:'test-config',clientInfo:{clientName:1}};
  const result=await message({type:'download',resolution:240,mode:'sabr',playerData:sabrSnapshot()});
  assert.deepEqual(result,{opened:true});
  assert.equal(sabrJob.type,'start-sabr-download');
  assert.equal(sabrJob.sabr.videoFormat.itag,133);
  assert.equal(sabrJob.sabr.audioFormat.itag,140);
  assert.equal(sabrJob.sabr.durationMs,19000);
  assert.ok(opened.url.startsWith('chrome-extension://test/download.html?task='));
  assert.equal(fetchCalls,0);
});

test('SABR without a playback session asks for playback and does not retry the failing API', async () => {
  const result=await message({type:'download',resolution:240,mode:'sabr',playerData:sabrSnapshot()});
  assert.match(result.error,/Reproduz o vídeo/);
  assert.equal(fetchCalls,0);
});
