const backend = 'http://127.0.0.1:3000';
const videoIdPattern = /^[\w-]{11}$/;

function getVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['https:', 'http:'].includes(url.protocol) || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
    return url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1];
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  const currentId = getVideoId(sender.url);
  if (!currentId || !videoIdPattern.test(currentId)) return;

  if (message.type === 'download-state' && Number.isInteger(message.downloadId) && message.downloadId > 0) {
    chrome.downloads.search({ id: message.downloadId }, items => {
      if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
      else sendResponse({ state: items[0]?.state ?? 'interrupted' });
    });
    return true;
  }

  if (message.videoId !== currentId) return;

  if (message.type === 'download' && Number.isInteger(message.resolution) && message.resolution > 0) {
    const url = 'https://www.youtube.com/watch?v=' + currentId;
    const filename = (typeof message.videoTitle === 'string' ? message.videoTitle : '')
      .replace(/[<>:"\\|?*\u0000-\u001f]/g, ' ')
      .replaceAll('/', ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
      .replace(/[. ]+$/, '') || currentId;
    chrome.downloads.download({
      url: `${backend}/download`,
      method: 'POST',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Download-Stream', value: '1' },
      ],
      body: JSON.stringify({ url, resolution: message.resolution }),
      filename: `${filename}.mp4`,
      saveAs: false,
      conflictAction: 'uniquify'
    }, downloadId => {
      if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
      else sendResponse({ downloadId });
    });
    return true;
  }
});
