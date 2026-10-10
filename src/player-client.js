import { PLAYER_REQUEST, PLAYER_RESPONSE } from './player-protocol.js';

export function requestPlayerSnapshot(videoId, pageWindow = window, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const finish = (error, data) => {
      clearTimeout(timeout);
      pageWindow.removeEventListener('message', onMessage);
      if (error) reject(error);
      else resolve(data);
    };
    const onMessage = event => {
      if (event.source !== pageWindow || event.origin !== pageWindow.location.origin) return;
      if (event.data?.type !== PLAYER_RESPONSE || event.data.requestId !== requestId) return;
      const snapshot = event.data.playerData;
      finish(null, snapshot?.videoId === videoId ? snapshot : null);
    };
    const timeout = setTimeout(() => finish(new Error('O player demorou a responder.')), timeoutMs);
    pageWindow.addEventListener('message', onMessage);
    pageWindow.postMessage({ type: PLAYER_REQUEST, requestId, videoId }, pageWindow.location.origin);
  });
}
