import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { VideoPlaybackAbrRequest, StreamerContext, ClientInfo } from 'googlevideo/protos';

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
    id: 'test',
    getURL: path => `chrome-extension://test/${path}`,
    onMessage: event('message'),
    getContexts: async () => [],
    sendMessage: async message => { sabrJob = message; return {accepted:true}; },
  },
  webRequest: {onBeforeRequest:event('request')},
  tabs: {
    onRemoved:event('removed'),get:async()=>({...sender.tab,url:sender.url}),
    create:async options=>{opened=options;throw new Error('The extension must never open a download tab.');},sendMessage:async()=>{},remove:async()=>{},
  },
  storage: {session:{
    get: async key => {
      storageReads++;
      if (key === null) return {...stored};
      if (Array.isArray(key)) return Object.fromEntries(key.map(name => [name, stored[name]]));
      return {[key]:stored[key]};
    },
    set: async data => Object.assign(stored,data),
    remove: async key => { delete stored[key]; },
  }},
  downloads: {
    onCreated:event('download-created'),onChanged:event('download-changed'),
    download:(options,callback)=>{downloaded=options;callback(123);},
  },
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

function message(payload, from = sender) {
  return new Promise((resolve,reject) => {
    const timeout=setTimeout(()=>reject(new Error('No response from the service worker')),7000);
    const keepAlive=events.message({videoId,...payload},from,result=>{clearTimeout(timeout);resolve(result);});
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

test('the original menu contract lists video resolutions before an audio pair exists', async () => {
  const snapshot={videoId,qualities:[],streamingData:{adaptiveFormats:[
    {itag:'137',height:'1080',qualityLabel:'1080p',mimeType:'video/mp4'},
    {itag:'136',height:720,qualityLabel:'720p',mimeType:'video/mp4; codecs="avc1.64001F"'},
  ]}};
  const result=await message({type:'get-resolutions',playerData:snapshot});
  assert.deepEqual(result.resolutions,[
    {height:720,mode:'player',extension:null},{height:1080,mode:'player',extension:null},
  ]);
  assert.equal(fetchCalls,0);
});

test('a protected format does not suppress an unprotected format at the same height', async () => {
  const snapshot=sabrSnapshot();
  snapshot.streamingData.adaptiveFormats.push({...snapshot.streamingData.adaptiveFormats[0],itag:999,drmFamilies:['WIDEVINE']});
  const result=await message({type:'get-resolutions',playerData:snapshot});
  assert.deepEqual(result.resolutions.map(value=>value.height),[144,240]);
});

test('stale metadata cannot return resolutions for another video', async () => {
  const result=await message({type:'get-resolutions',playerData:{...sabrSnapshot(),videoId:'dQw4w9WgXcQ'}});
  assert.match(result.error,/sincronizar este vídeo/);
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
  assert.equal(downloaded.headers, undefined);
  assert.equal(fetchCalls,0);
});

test('a crashed offscreen transfer stops waiting after missing heartbeats', async () => {
  const taskId = crypto.randomUUID();
  stored[`sabr-task:${taskId}`] = {status:'running',bytes:10,updatedAt:Date.now()-100000};
  stored[`pending:${taskId}`] = {taskId,tabId:42,status:'transferring'};
  const result = await message({type:'download-task-state',taskId});
  assert.equal(result.state.status,'failed');
  assert.match(result.state.error,/deixou de responder/);
  assert.equal(sabrJob.type,'cancel-sabr-download');
});

test('SABR transfer preparation reuses page metadata and the captured playback session', async () => {
  stored['sabr-session:42']={videoId,capturedAt:Date.now(),serverAbrStreamingUrl:'https://r1.test.googlevideo.com/videoplayback?sabr=1',poToken:'test-token',videoPlaybackUstreamerConfig:'test-config',clientInfo:{clientName:1}};
  const result=await message({type:'download',resolution:240,mode:'sabr',playerData:sabrSnapshot()});
  assert.equal(typeof result.taskId,'string');
  assert.equal(sabrJob.type,'start-sabr-download');
  assert.equal(sabrJob.sabr.videoFormat.itag,133);
  assert.equal(sabrJob.sabr.audioFormat.itag,140);
  assert.equal(sabrJob.sabr.durationMs,19000);
  assert.equal(opened,undefined);
  assert.equal(stored[`pending:${result.taskId}`].tabId,42);
  assert.equal(fetchCalls,0);
});

test('SABR waits briefly for the player session when playback starts at the same time', async () => {
  setTimeout(() => {
    stored['sabr-session:42']={videoId,capturedAt:Date.now(),serverAbrStreamingUrl:'https://r1.test.googlevideo.com/videoplayback?sabr=1',poToken:'test-token',videoPlaybackUstreamerConfig:'test-config',clientInfo:{clientName:1}};
  }, 50);
  const result=await message({type:'download',resolution:240,mode:'sabr',playerData:sabrSnapshot()});
  assert.equal(typeof result.taskId,'string');
  assert.equal(sabrJob.type,'start-sabr-download');
});

test('a fresh progressive stream is used when the menu SABR session is not ready', async () => {
  const snapshot=sabrSnapshot();
  snapshot.streamingData.formats=[{
    itag:18,height:240,qualityLabel:'240p',mimeType:'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
    url:'https://r1.test.googlevideo.com/videoplayback?itag=18',
  }];
  stored['sabr-session:42']={
    videoId,capturedAt:Date.now(),
    serverAbrStreamingUrl:`https://r1.test.googlevideo.com/videoplayback?expire=${Math.floor(Date.now()/1000)-1}`,
    poToken:'expired-token',videoPlaybackUstreamerConfig:'expired-config',clientInfo:{clientName:1},
  };
  const result=await message({type:'download',resolution:240,mode:'sabr',playerData:snapshot});
  assert.equal(result.downloadId,123);
  assert.equal(downloaded.url,snapshot.streamingData.formats[0].url);
});

test('separate audio and video are processed offscreen without opening a tab', async () => {
  const snapshot={videoId,title:'Me at the zoo',durationSeconds:19,qualities:[],streamingData:{adaptiveFormats:[
    {itag:137,mimeType:'video/mp4; codecs="avc1.640028"',width:1920,height:1080,qualityLabel:'1080p',bitrate:2500000,url:'https://r1.test.googlevideo.com/videoplayback?itag=137'},
    {itag:140,mimeType:'audio/mp4; codecs="mp4a.40.2"',audioQuality:'AUDIO_QUALITY_MEDIUM',bitrate:128000,url:'https://r1.test.googlevideo.com/videoplayback?itag=140'},
  ]}};
  const result=await message({type:'download',resolution:1080,mode:'merge',playerData:snapshot});
  assert.equal(typeof result.taskId,'string');
  assert.equal(sabrJob.type,'start-merge-download');
  assert.equal(sabrJob.task.mode,'merge');
  assert.equal(opened,undefined);
  assert.equal(stored[`pending:${result.taskId}`].tabId,42);
  assert.equal(fetchCalls,0);
});

test('a real protobuf playback request provides the session used for download preparation', async () => {
  const request=VideoPlaybackAbrRequest.decode(new Uint8Array());
  request.videoPlaybackUstreamerConfig=new Uint8Array([1,2,3]);
  request.streamerContext=StreamerContext.decode(new Uint8Array());
  request.streamerContext.poToken=new Uint8Array(32).fill(7);
  request.streamerContext.clientInfo=ClientInfo.decode(new Uint8Array());
  Object.assign(request.streamerContext.clientInfo,{clientName:1,clientVersion:'2.20261009.00.00'});
  const body=VideoPlaybackAbrRequest.encode(request).finish();
  await events.request({
    tabId:42,initiator:'https://www.youtube.com',
    url:'https://r1.test.googlevideo.com/videoplayback?sabr=1&rn=10',
    requestBody:{raw:[{bytes:body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength)}]},
  });
  assert.equal(stored['sabr-session:42'].videoId,videoId);
  assert.ok(!stored['sabr-session:42'].serverAbrStreamingUrl.includes('rn='));
  const result=await message({type:'download',resolution:240,mode:'sabr',playerData:sabrSnapshot()});
  assert.equal(typeof result.taskId,'string');
  assert.equal(sabrJob.sabr.poToken,stored['sabr-session:42'].poToken);
  assert.equal(fetchCalls,0);
});

test('a ciphered progressive format can reuse SABR instead of the failing extraction API', async () => {
  const snapshot=sabrSnapshot();
  snapshot.streamingData.formats=[{
    itag:18,height:240,qualityLabel:'240p',mimeType:'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
    signatureCipher:'url=https%3A%2F%2Fr1.test.googlevideo.com%2Fvideoplayback%3Fitag%3D18&s=test',
  }];
  stored['sabr-session:42']={videoId,capturedAt:Date.now(),serverAbrStreamingUrl:'https://r1.test.googlevideo.com/videoplayback?sabr=1',poToken:'test-token',videoPlaybackUstreamerConfig:'test-config',clientInfo:{clientName:1}};
  const result=await message({type:'download',resolution:240,mode:'direct',playerData:snapshot});
  assert.equal(typeof result.taskId,'string');
  assert.equal(sabrJob.sabr.videoFormat.itag,133);
  assert.equal(fetchCalls,0);
});

test('SABR without a playback session asks for playback and does not retry the failing API', async () => {
  const result=await message({type:'download',resolution:240,mode:'sabr',playerData:sabrSnapshot()});
  assert.match(result.error,/Deixa o vídeo reproduzir/);
  assert.equal(fetchCalls,0);
});
