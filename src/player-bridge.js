import { PLAYER_REQUEST, PLAYER_RESPONSE } from './player-protocol.js';
import { collectPlayerSnapshot } from './player-snapshot.js';

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  const request = event.data;
  if (request?.type !== PLAYER_REQUEST || !/^[\w-]{36}$/.test(request.requestId ?? '')
    || !/^[\w-]{11}$/.test(request.videoId ?? '')) return;
  const currentId = new URL(location.href).searchParams.get('v')
    ?? /^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/.exec(location.pathname)?.[1];
  if (currentId !== request.videoId) return;
  let playerData = null;
  try { playerData = collectPlayerSnapshot({ window, document }, currentId); } catch {}
  window.postMessage({ type: PLAYER_RESPONSE, requestId: request.requestId, playerData }, location.origin);
});
