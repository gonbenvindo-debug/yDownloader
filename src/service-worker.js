import { Innertube, Platform } from 'youtubei.js/web';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { buildSabrFormat } from 'googlevideo/utils';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';
import QUICKJS_RELEASE from '@jitl/quickjs-wasmfile-release-sync';

const videoIdPattern = /^[\w-]{11}$/;
const clientTypes = ['ANDROID_VR', 'VISIONOS', 'WEB'];
const infoCache = new Map();
const clients = new Map();
const sabrInfoCache = new Map();
const sabrSessionPrefix = 'sabr-session:';
const sabrTaskPrefix = 'sabr-task:';
const sabrOffscreenUrl = chrome.runtime.getURL('sabr.html');
const sabrOriginRuleId = 1;
let quickJsPromise;
let offscreenCreation;

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function youtubeVideoIdFromTab(tab) {
  return tab?.url ? extractVideoId(tab.url) : null;
}

async function captureSabrPlayerSession(details) {
  if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
  try {
    const initiator = new URL(details.initiator ?? details.documentUrl ?? details.originUrl ?? '');
    if (initiator.hostname !== 'youtube.com' && !initiator.hostname.endsWith('.youtube.com')) return;

    const raw = details.requestBody?.raw;
    if (!raw?.length) return;
    const chunks = raw.flatMap(part => part.bytes ? [new Uint8Array(part.bytes)] : []);
    if (!chunks.length) return;
    const bodyLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const body = new Uint8Array(bodyLength);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }

    const request = VideoPlaybackAbrRequest.decode(body);
    const poToken = request.streamerContext?.poToken;
    const ustreamerConfig = request.videoPlaybackUstreamerConfig;
    if (!poToken || poToken.byteLength < 32 || !ustreamerConfig?.byteLength) return;

    const tab = await chrome.tabs.get(details.tabId).catch(() => null);
    const videoId = youtubeVideoIdFromTab(tab);
    if (!videoId) return;

    const serverAbrStreamingUrl = new URL(details.url);
    if (serverAbrStreamingUrl.protocol !== 'https:' || !serverAbrStreamingUrl.hostname.endsWith('.googlevideo.com')) return;
    serverAbrStreamingUrl.searchParams.delete('rn');
    const client = request.streamerContext?.clientInfo ?? {};
    const session = {
      videoId,
      serverAbrStreamingUrl: serverAbrStreamingUrl.href,
      videoPlaybackUstreamerConfig: bytesToBase64(ustreamerConfig),
      poToken: bytesToBase64(poToken),
      clientInfo: JSON.parse(JSON.stringify(client)),
      capturedAt: Date.now(),
    };
    await chrome.storage.session.set({ [`${sabrSessionPrefix}${details.tabId}`]: session });
  } catch {
    // Ignore unrelated or incomplete SABR requests while YouTube playback continues.
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  captureSabrPlayerSession,
  { urls: ['https://*.googlevideo.com/videoplayback*'] },
  ['requestBody'],
);
chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(`${sabrSessionPrefix}${tabId}`);
});

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
    const pending = Innertube.create({ client_type: clientType, lang: 'pt', location: 'PT' });
    clients.set(clientType, pending);
    pending.catch(() => {
      if (clients.get(clientType) === pending) clients.delete(clientType);
    });
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

async function getSabrVideoInfo(videoId) {
  const cached = sabrInfoCache.get(videoId);
  if (cached && Date.now() - cached.savedAt < 45_000) return cached.result;

  const client = await getClient('WEB');
  const info = await client.getBasicInfo(videoId);
  if (!info.streaming_data?.server_abr_streaming_url) {
    throw new Error('O player não forneceu streams SABR para este vídeo.');
  }
  const result = { info, client };
  sabrInfoCache.clear();
  sabrInfoCache.set(videoId, { result, savedAt: Date.now() });
  return result;
}

async function getSabrSession(tabId, videoId) {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  const key = `${sabrSessionPrefix}${tabId}`;
  const stored = await chrome.storage.session.get(key);
  const session = stored[key];
  if (!session || session.videoId !== videoId || Date.now() - session.capturedAt > 60 * 60 * 1000) return null;
  return session;
}

function toSabrFormat(format) {
  return buildSabrFormat({
    itag: format.itag,
    lastModified: String(format.last_modified_ms ?? format.last_modified ?? format.lastModified ?? '0'),
    xtags: format.xtags,
    width: format.width,
    height: format.height,
    mimeType: format.mime_type,
    audioQuality: format.audio_quality,
    bitrate: format.bitrate ?? 0,
    averageBitrate: format.average_bitrate,
    quality: format.quality,
    qualityLabel: format.quality_label,
    audioTrackId: format.audio_track?.id,
    approxDurationMs: format.approx_duration_ms ?? 0,
    contentLength: format.content_length,
    isDrc: format.is_drc,
    isAutoDubbed: format.is_auto_dubbed,
    isDescriptive: format.is_descriptive,
    isDubbed: format.is_dubbed,
    language: format.language,
    isOriginal: format.is_original,
    isSecondary: format.is_secondary,
  });
}

function getSabrQualityPlan(info, height) {
  const formats = info.streaming_data?.adaptive_formats ?? [];
  const videoFormats = formats.filter(format => format.height === height && format.has_video
    && !format.has_audio && !format.has_text && !hasDrm(format));
  const audioFormats = formats.filter(format => format.has_audio && !format.has_video
    && !format.has_text && !hasDrm(format));
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
    return preferredAudio || ((b.video.bitrate ?? 0) + (b.audio.bitrate ?? 0))
      - ((a.video.bitrate ?? 0) + (a.audio.bitrate ?? 0));
  });
  if (!pairs.length) return null;

  const pair = pairs[0];
  return {
    mode: 'sabr',
    extension: pair.extension,
    videoFormat: toSabrFormat(pair.video),
    audioFormat: toSabrFormat(pair.audio),
    durationMs: Math.round((info.basic_info.duration ?? 0) * 1000),
  };
}

async function getResolutionsForTab(videoId, tabId) {
  let resolutions = [];
  let directError;
  try {
    const { info } = await getVideoInfo(videoId);
    resolutions = getAvailableResolutions(info).map(resolution => ({ ...resolution, mode: resolution.mode }));
  } catch (error) {
    directError = error;
  }

  let session = null;
  try {
    session = await getSabrSession(tabId, videoId);
  } catch {
    // SABR is an optional route; storage/session issues must not hide direct formats.
  }
  if (!session) {
    if (resolutions.length) return resolutions;
    throw directError ?? new Error('Reproduz o vídeo neste separador para ativar a transferência SABR.');
  }

  try {
    const { info } = await getSabrVideoInfo(videoId);
    const heights = new Set((info.streaming_data.adaptive_formats ?? [])
      .map(format => format.height)
      .filter(height => Number.isInteger(height) && height > 0));
    const sabrResolutions = [...heights].sort((a, b) => a - b).map(height => {
      const plan = getSabrQualityPlan(info, height);
      return plan && { height, mode: 'sabr', extension: plan.extension };
    }).filter(Boolean);
    resolutions.push(...sabrResolutions);
  } catch (error) {
    if (!resolutions.length) throw error;
  }
  return resolutions.sort((a, b) => a.height - b.height
    || Number(a.mode === 'sabr') - Number(b.mode === 'sabr'));
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

async function ensureSabrOffscreenDocument() {
  if (offscreenCreation) return offscreenCreation;
  offscreenCreation = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [sabrOffscreenUrl],
    });
    if (contexts.length) return;
    await chrome.offscreen.createDocument({
      url: 'sabr.html',
      reasons: ['BLOBS'],
      justification: 'Transferir streams SABR para ficheiros temporários no armazenamento local e uni-los no browser.',
    });
  })();
  try {
    await offscreenCreation;
  } finally {
    offscreenCreation = null;
  }
}

async function registerSabrOriginRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [sabrOriginRuleId],
    addRules: [{
      id: sabrOriginRuleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'cross-site' },
          { header: 'Sec-Fetch-Storage-Access', operation: 'set', value: 'active' },
        ],
      },
      condition: {
        urlFilter: '||googlevideo.com/videoplayback',
        requestMethods: ['post'],
        tabIds: [-1],
      },
    }],
  });
}

async function removeSabrOriginRuleIfIdle() {
  const entries = await chrome.storage.session.get(null);
  const hasActiveJob = Object.entries(entries).some(([key, value]) =>
    key.startsWith(sabrTaskPrefix) && value?.status === 'running');
  if (!hasActiveJob) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [sabrOriginRuleId] });
  }
}

async function startOffscreenSabrTask(taskId, task) {
  await ensureSabrOffscreenDocument();
  await registerSabrOriginRule();
  const stateKey = `${sabrTaskPrefix}${taskId}`;
  await chrome.storage.session.set({ [stateKey]: { status: 'running', bytes: 0, startedAt: Date.now() } });
  try {
    const response = await chrome.runtime.sendMessage({
      target: 'sabr-offscreen',
      type: 'start-sabr-download',
      taskId,
      sabr: task.sabr,
    });
    if (!response?.accepted) throw new Error(response?.error || 'A página local de transferência não iniciou.');
  } catch (error) {
    await chrome.storage.session.set({ [stateKey]: {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Não foi possível iniciar o transporte SABR.',
    } });
    await removeSabrOriginRuleIfIdle();
    throw error;
  }
}

async function cancelOffscreenSabrTask(taskId) {
  try {
    await chrome.runtime.sendMessage({ target: 'sabr-offscreen', type: 'cancel-sabr-download', taskId });
  } catch { /* the job may already be finished */ }
}

async function startDownload(videoId, videoTitle, height, mode, tabId) {
  if (mode === 'sabr') {
    const session = await getSabrSession(tabId, videoId);
    if (!session) throw new Error('A sessão do player expirou. Reproduz o vídeo e volta a tentar.');
    const { info } = await getSabrVideoInfo(videoId);
    const plan = getSabrQualityPlan(info, height);
    if (!plan) throw new Error('Esta resolução não está disponível num formato SABR compatível.');

    const filename = safeFilename(videoTitle, videoId);
    const taskId = crypto.randomUUID();
    const suggestedFilename = `${filename}.${plan.extension}`;
    const sabr = {
      serverAbrStreamingUrl: session.serverAbrStreamingUrl,
      videoPlaybackUstreamerConfig: session.videoPlaybackUstreamerConfig,
      poToken: session.poToken,
      clientInfo: session.clientInfo,
      durationMs: plan.durationMs,
      videoFormat: plan.videoFormat,
      audioFormat: plan.audioFormat,
    };
    const pendingKey = `pending:${taskId}`;
    await chrome.storage.session.set({
      [pendingKey]: {
        taskId,
        mode: 'sabr',
        videoId,
        title: info.basic_info.title || filename,
        resolution: height,
        extension: plan.extension,
        suggestedFilename,
      },
    });

    try {
      await startOffscreenSabrTask(taskId, { sabr });
      await chrome.tabs.create({ url: `${chrome.runtime.getURL('download.html')}?task=${taskId}` });
    } catch (error) {
      await cancelOffscreenSabrTask(taskId);
      await chrome.storage.session.remove(pendingKey);
      throw error;
    }
    return { opened: true };
  }

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
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Falhou a ligação ao YouTube ao procurar as resoluções. Recarrega a yDownloader em chrome://extensions, atualiza a página do vídeo e tenta novamente.';
  }
  if (/login|required|private|unavailable|unplayable|not available/i.test(message)) {
    return 'Este vídeo não está disponível para extração. Verifica se é público e tenta novamente.';
  }
  return message || 'Não foi possível preparar o download.';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'sabr-job-state') {
    if (sender.url !== sabrOffscreenUrl || !/^[\w-]{36}$/.test(message.taskId ?? '')) return;
    const status = ['running', 'complete', 'failed', 'cancelled'].includes(message.status)
      ? message.status
      : 'failed';
    const key = `${sabrTaskPrefix}${message.taskId}`;
    chrome.storage.session.get(key).then(async stored => {
      const previous = stored[key] ?? {};
      await chrome.storage.session.set({
        [key]: {
          ...previous,
          status,
          ...(Number.isFinite(message.bytes) && { bytes: message.bytes }),
          ...(typeof message.error === 'string' && { error: message.error.slice(0, 300) }),
          ...(status === 'complete' && { completedAt: Date.now() }),
        },
      });
      if (status !== 'running') await removeSabrOriginRuleIfIdle();
      sendResponse({ accepted: true });
    }).catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'sabr-task-state') {
    const extensionPage = chrome.runtime.getURL('download.html');
    const taskId = typeof message.taskId === 'string' ? message.taskId : '';
    if (!sender.url?.startsWith(extensionPage) || !/^[\w-]{36}$/.test(taskId)) return;
    chrome.storage.session.get(`${sabrTaskPrefix}${taskId}`).then(stored => {
      sendResponse({ state: stored[`${sabrTaskPrefix}${taskId}`] ?? null });
    }).catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'cancel-sabr-task') {
    const extensionPage = chrome.runtime.getURL('download.html');
    const taskId = typeof message.taskId === 'string' ? message.taskId : '';
    if (!sender.url?.startsWith(extensionPage) || !/^[\w-]{36}$/.test(taskId)) return;
    cancelOffscreenSabrTask(taskId).then(() => sendResponse({ accepted: true }))
      .catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

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
    getResolutionsForTab(currentId, sender.tab?.id)
      .then(resolutions => sendResponse({ resolutions }))
      .catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'download' && Number.isInteger(message.resolution) && message.resolution > 0) {
    startDownload(currentId, message.videoTitle, message.resolution, message.mode, sender.tab?.id)
      .then(sendResponse)
      .catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }
});
