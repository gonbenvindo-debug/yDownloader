import { Innertube, Platform } from 'youtubei.js/web';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';
import QUICKJS_RELEASE from '@jitl/quickjs-wasmfile-release-sync';

const videoIdPattern = /^[\w-]{11}$/;
const clientTypes = ['ANDROID_VR', 'VISIONOS', 'WEB'];
const infoCache = new Map();
const clients = new Map();
let quickJsPromise;

Platform.shim.eval = async data => {
  quickJsPromise ??= newQuickJSWASMModuleFromVariant(QUICKJS_RELEASE);
  const quickJs = await quickJsPromise;
  return quickJs.evalCode(`(function(){\n${data.output}\n})()`, {
    memoryLimitBytes: 32 * 1024 * 1024,
    shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + 5000),
  });
};

function extractVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['https:', 'http:'].includes(url.protocol)
      || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
    return url.searchParams.get('v')
      ?? /^(?:\/shorts|\/embed|\/live)\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1]
      ?? null;
  } catch {
    return null;
  }
}

function getClient(clientType) {
  if (!clients.has(clientType)) {
    clients.set(clientType, Innertube.create({ client_type: clientType, lang: 'pt', location: 'PT' }));
  }
  return clients.get(clientType);
}

async function getVideoInfo(videoId) {
  const cached = infoCache.get(videoId);
  if (cached && Date.now() - cached.savedAt < 45_000) return cached.result;

  let lastError;
  for (const clientType of clientTypes) {
    try {
      const client = await getClient(clientType);
      const info = await client.getBasicInfo(videoId);
      const result = { info, client };
      if (getAvailableResolutions(info).length) {
        infoCache.clear();
        infoCache.set(videoId, { result, savedAt: Date.now() });
        return result;
      }
      lastError = new Error('Este vídeo não tem streams disponíveis para download.');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Este vídeo não tem streams disponíveis para download.');
}

function codecFamilies(format) {
  const codecs = /codecs="([^"]+)"/i.exec(format.mime_type)?.[1]?.split(',').map(codec => codec.trim().toLowerCase());
  if (!codecs) return [];
  return codecs.map(codec => {
    if (codec.startsWith('avc1')) return 'avc';
    if (codec.startsWith('hvc1') || codec.startsWith('hev1')) return 'hevc';
    if (codec.startsWith('av01')) return 'av1';
    if (codec.startsWith('vp09') || codec === 'vp9') return 'vp9';
    if (codec.startsWith('vp08') || codec === 'vp8') return 'vp8';
    if (codec.startsWith('mp4a')) return 'aac';
    if (codec.startsWith('opus')) return 'opus';
    if (codec.startsWith('vorbis')) return 'vorbis';
    return null;
  });
}

function codecFamily(format) {
  return codecFamilies(format)[0] ?? null;
}

function hasDrm(format) {
  const drmTrackType = String(format.drm_track_type ?? '').toLowerCase();
  return Boolean(format.drm_families?.length || (drmTrackType && !drmTrackType.endsWith('_none')) || format.fair_play_key_uri);
}

function hasMediaReference(format) {
  return Boolean(format.url || format.signature_cipher || format.cipher);
}

function getContainer(videoFormat, audioFormat) {
  const videoMime = videoFormat.mime_type.split(';')[0].toLowerCase();
  const combined = videoFormat === audioFormat;
  const audioMime = combined ? videoMime.replace(/^video\//, 'audio/') : audioFormat.mime_type.split(';')[0].toLowerCase();
  const videoCodecs = codecFamilies(videoFormat);
  const audioCodecs = combined ? videoCodecs.slice(1) : codecFamilies(audioFormat);
  const videoCodec = videoCodecs.find(codec => ['avc', 'hevc', 'av1', 'vp9', 'vp8'].includes(codec));
  const audioCodec = audioCodecs.find(codec => ['aac', 'opus', 'vorbis'].includes(codec));

  if (videoMime === 'video/mp4' && audioMime === 'audio/mp4'
    && ['avc', 'hevc', 'av1'].includes(videoCodec) && audioCodec === 'aac') return 'mp4';
  if (videoMime === 'video/webm' && audioMime === 'audio/webm'
    && ['vp8', 'vp9', 'av1'].includes(videoCodec) && ['opus', 'vorbis'].includes(audioCodec)) return 'webm';
  return null;
}

function isProgressive(format) {
  return format.has_video && format.has_audio && !format.has_text && !hasDrm(format)
    && hasMediaReference(format) && Boolean(getContainer(format, format));
}

function getQualityPlan(info, height) {
  const streamData = info.streaming_data;
  const combined = (streamData.formats ?? [])
    .filter(format => format.height === height && isProgressive(format))
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (combined.length) {
    const format = combined[0];
    return { mode: 'direct', extension: getContainer(format, format), format };
  }

  const videoFormats = (streamData.adaptive_formats ?? [])
    .filter(format => format.height === height && format.has_video && !format.has_audio
      && !format.has_text && !hasDrm(format) && hasMediaReference(format));
  const audioFormats = (streamData.adaptive_formats ?? [])
    .filter(format => format.has_audio && !format.has_video
      && !format.has_text && !hasDrm(format) && hasMediaReference(format));
  const pairs = [];

  for (const video of videoFormats) {
    for (const audio of audioFormats) {
      const extension = getContainer(video, audio);
      if (extension) pairs.push({ video, audio, extension });
    }
  }

  pairs.sort((a, b) => {
    const preferredAudio = Number(Boolean(b.audio.audio_track?.audio_is_default))
      - Number(Boolean(a.audio.audio_track?.audio_is_default));
    return preferredAudio || (b.video.bitrate + b.audio.bitrate) - (a.video.bitrate + a.audio.bitrate);
  });
  if (!pairs.length) return null;
  return { mode: 'merge', ...pairs[0] };
}

function getAvailableResolutions(info) {
  const streamData = info.streaming_data;
  const heights = new Set([
    ...(streamData.formats ?? []).map(format => format.height),
    ...(streamData.adaptive_formats ?? []).map(format => format.height),
  ].filter(height => Number.isInteger(height) && height > 0));

  return [...heights]
    .sort((a, b) => a - b)
    .map(height => {
      const plan = getQualityPlan(info, height);
      return plan && { height, mode: plan.mode, extension: plan.extension };
    })
    .filter(Boolean);
}

function safeFilename(value, fallback) {
  return (typeof value === 'string' ? value : '')
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, ' ')
    .replaceAll('/', ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
    .replace(/[. ]+$/, '') || fallback;
}

async function decipher(format, client) {
  const value = new URL(await format.decipher(client.session.player));
  if (value.protocol !== 'https:' || !value.hostname.endsWith('.googlevideo.com')) {
    throw new Error('O YouTube devolveu um stream inválido.');
  }
  return value.href;
}

function startBrowserDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, downloadId => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(downloadId);
    });
  });
}

async function startDownload(videoId, videoTitle, height) {
  const { info, client } = await getVideoInfo(videoId);
  const plan = getQualityPlan(info, height);
  if (!plan) throw new Error('Esta resolução não está disponível num formato compatível.');

  const filename = safeFilename(videoTitle, videoId);
  if (plan.mode === 'direct') {
    const url = await decipher(plan.format, client);
    const downloadId = await startBrowserDownload({
      url,
      headers: [{ name: 'Referer', value: `https://www.youtube.com/watch?v=${videoId}` }],
      filename: `${filename}.${plan.extension}`,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    return { downloadId };
  }

  const [videoUrl, audioUrl] = await Promise.all([
    decipher(plan.video, client),
    decipher(plan.audio, client),
  ]);
  const taskId = crypto.randomUUID();
  const key = `pending:${taskId}`;
  const suggestedFilename = `${filename}.${plan.extension}`;
  await chrome.storage.session.set({
    [key]: {
      videoId,
      title: info.basic_info.title || filename,
      resolution: height,
      extension: plan.extension,
      suggestedFilename,
      videoUrl,
      audioUrl,
    },
  });

  try {
    await chrome.tabs.create({ url: `${chrome.runtime.getURL('download.html')}?task=${taskId}` });
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
  return { opened: true };
}

function messageError(error) {
  const message = error instanceof Error ? error.message : '';
  if (/login|required|private|unavailable|unplayable|not available/i.test(message)) {
    return 'Este vídeo não está disponível para extração. Verifica se é público e tenta novamente.';
  }
  return message || 'Não foi possível preparar o download.';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'consume-pending-download') {
    const extensionPage = chrome.runtime.getURL('download.html');
    const taskId = typeof message.taskId === 'string' ? message.taskId : '';
    if (!sender.url?.startsWith(extensionPage) || !/^[\w-]{36}$/.test(taskId)) return;
    const key = `pending:${taskId}`;
    chrome.storage.session.get(key).then(async stored => {
      const task = stored[key];
      if (task) await chrome.storage.session.remove(key);
      sendResponse(task ? { task } : { error: 'O pedido de download expirou. Volta ao vídeo e tenta novamente.' });
    }).catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  const currentId = extractVideoId(sender.url);
  if (!currentId || !videoIdPattern.test(currentId)) return;

  if (message.type === 'download-state' && Number.isInteger(message.downloadId) && message.downloadId > 0) {
    chrome.downloads.search({ id: message.downloadId }, items => {
      if (chrome.runtime.lastError) sendResponse({ error: chrome.runtime.lastError.message });
      else sendResponse({ state: items[0]?.state ?? 'interrupted' });
    });
    return true;
  }

  if (message.videoId !== currentId) return;

  if (message.type === 'get-resolutions') {
    getVideoInfo(currentId)
      .then(({ info }) => sendResponse({ resolutions: getAvailableResolutions(info) }))
      .catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'download' && Number.isInteger(message.resolution) && message.resolution > 0) {
    startDownload(currentId, message.videoTitle, message.resolution)
      .then(sendResponse)
      .catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }
});
