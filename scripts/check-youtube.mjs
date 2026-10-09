import assert from 'node:assert/strict';
import { createPlayerReader } from '../src/player-reader.js';
import { parseInlinePlayerResponse } from '../src/player-snapshot.js';
import { hasDrm, resolutionHeight } from '../src/player-data.js';

// Check the public YouTube HTML fallback and the packaged worker together.
// This checks extraction and menu selection; it is not a Chrome download test.
let onMessage;
const ignoreEvent = { addListener() {} };
globalThis.chrome = {
  runtime: {getURL:path=>`chrome-extension://check/${path}`,onMessage:{addListener:listener=>{onMessage=listener;}}},
  webRequest:{onBeforeRequest:ignoreEvent},tabs:{onRemoved:ignoreEvent},
};
await import('../extension/service-worker.js');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('The worker must not fetch to list resolutions'); };
try {
  for (const videoId of ['aqz-KE-bpKQ', 'jNQXAC9IVRw', 'dQw4w9WgXcQ']) {
    let raw;
    const read = createPlayerReader({
      pageWindow:{location:{origin:'https://www.youtube.com'}},
      pageDocument:{getElementById:()=>null,querySelector:()=>null,scripts:[]},
      readBridge:async()=>{throw new Error('Force HTML fallback');},
      fetchImpl:async(url,options)=>{
        const response=await realFetch(url,{
          ...options,headers:{'User-Agent':'Mozilla/5.0','Accept-Language':'en-US,en;q=0.9'},
        });
        const html=await response.text();
        raw=parseInlinePlayerResponse(html);
        return {ok:response.ok,status:response.status,url:response.url,text:async()=>html};
      },
    });
    const playerData=await read(videoId);
    assert.equal(raw.videoDetails.videoId,videoId);
    const expected=[...new Set([...(raw.streamingData.formats??[]),...(raw.streamingData.adaptiveFormats??[])]
      .filter(format=>format.mimeType.startsWith('video/')&&!hasDrm(format))
      .map(resolutionHeight).filter(Boolean))].sort((a,b)=>a-b);
    const result=await new Promise((resolve,reject)=>{
      const accepted=onMessage({type:'get-resolutions',videoId,playerData},
        {url:`https://www.youtube.com/watch?v=${videoId}`,tab:{id:1}},resolve);
      if(!accepted)reject(new Error('Worker rejected the message'));
    });
    assert.equal(result.error,undefined);
    assert.ok(result.resolutions.length>0);
    assert.deepEqual(result.resolutions.map(format=>format.height),expected);
    assert.ok(result.resolutions.every(format=>format.mode!=='player'), 'Public test videos should have complete download metadata');
    console.log(JSON.stringify({videoId,title:raw.videoDetails.title,resolutions:expected,modes:[...new Set(result.resolutions.map(format=>format.mode))]}));
  }
} finally {
  globalThis.fetch=realFetch;
  delete globalThis.chrome;
}
