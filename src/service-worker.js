import { Innertube, Platform } from 'youtubei.js/web';
import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import { buildSabrFormat } from 'googlevideo/utils';
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from 'quickjs-emscripten-core';
import QUICKJS_RELEASE from '@jitl/quickjs-wasmfile-release-sync';
import { hasDrm, normalizePlayerSnapshot, resolutionHeight } from './player-data.js';

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
  const videoFormats = formats.filter(format => resolutionHeight(format) === height && format.has_video
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

async function getResolutionsForTab(videoId, playerData) {
  const snapshot = normalizePlayerSnapshot(playerData, videoId);
  if (!snapshot) throw new Error('Não foi possível ler este vídeo no player. Atualiza a página e tenta novamente.');
  const { info, nativeHeights, videoHeights } = snapshot;
  const heights = new Set([...nativeHeights, ...videoHeights]
    .filter(height => Number.isInteger(height) && height >= 72 && height <= 8640));
  // Reading resolutions never makes a new request to YouTube.
  return [...heights].sort((a, b) => a - b).map(height => {
    const directPlan = getQualityPlan(info, height);
    if (directPlan) return { height, mode: directPlan.mode, extension: directPlan.extension };
    const sabrPlan = getSabrQualityPlan(info, height);
    if (sabrPlan) return { height, mode: 'sabr', extension: sabrPlan.extension };
    // Match the original yt-dlp menu: list video heights before choosing the audio pair.
    return { height, mode: 'player', extension: null };
  });
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
  const streamData = info.streaming_data ?? {};
  const combined = (streamData.formats ?? [])
    .filter(format => resolutionHeight(format) === height && isProgressive(format))
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (combined.length) {
    const format = combined[0];
    return { mode: 'direct', extension: getContainer(format, format), format };
  }

  const videoFormats = (streamData.adaptive_formats ?? [])
    .filter(format => resolutionHeight(format) === height && format.has_video && !format.has_audio
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
  const streamData = info.streaming_data ?? {};
  const heights = new Set([
    ...(streamData.formats ?? []).map(resolutionHeight),
    ...(streamData.adaptive_formats ?? []).map(resolutionHeight),
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
  let rawUrl = format.url;
  const needsPlayer = client || format.signature_cipher || format.cipher
    || rawUrl && new URL(rawUrl).searchParams.has('n');
  if (needsPlayer) {
    client ??= await getClient('WEB');
    rawUrl = typeof format.decipher === 'function'
      ? await format.decipher(client.session.player)
      : await client.session.player.decipher(format.url, format.signature_cipher, format.cipher);
  }
  const value = new URL(rawUrl);
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
        initiatorDomains: [chrome.runtime.id],
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
  const stateKey = `${sabrTaskPrefix}${taskId}`;
  await chrome.storage.session.set({ [stateKey]: { status: 'running', bytes: 0, startedAt: Date.now(), updatedAt: Date.now() } });
  try {
    await ensureSabrOffscreenDocument();
    await registerSabrOriginRule();
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

async function startDownload(videoId, videoTitle, height, mode, tabId, playerData) {
  const localInfo = normalizePlayerSnapshot(playerData, videoId)?.info;
  const localDirectPlan = localInfo && getQualityPlan(localInfo, height);
  const localSabrPlan = localInfo && getSabrQualityPlan(localInfo, height);
  const session = localSabrPlan || mode === 'sabr' ? await getSabrSession(tabId, videoId) : null;
  const requiresDecipher = localDirectPlan && [localDirectPlan.format, localDirectPlan.video, localDirectPlan.audio]
    .filter(Boolean).some(format => format.signature_cipher || format.cipher
      || format.url && new URL(format.url).searchParams.has('n'));
  // A signed progressive URL may require a failing API request. The active SABR
  // session already has the authorization needed for the same resolution.
  if (localSabrPlan && (!localDirectPlan || mode === 'sabr' || requiresDecipher && session)
    || mode === 'sabr' && !localDirectPlan) {
    if (!session) throw new Error('A sessão do player expirou. Reproduz o vídeo e volta a tentar.');
    const info = localSabrPlan ? localInfo : (await getSabrVideoInfo(videoId)).info;
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
        tabId,
        mode: 'sabr',
        videoId,
        title: info.basic_info.title || filename,
        resolution: height,
        width: plan.videoFormat.width,
        height: plan.videoFormat.height,
        durationSeconds: plan.durationMs / 1000,
        createdAt: Date.now(),
        extension: plan.extension,
        suggestedFilename,
      },
    });

    try {
      await startOffscreenSabrTask(taskId, { sabr });
      const helper = await chrome.tabs.create({
        url: `${chrome.runtime.getURL('download.html')}?task=${taskId}`,
        active: false,
      });
      await chrome.storage.session.set({ [pendingKey]: {
        ...(await chrome.storage.session.get(pendingKey))[pendingKey],
        helperTabId: helper.id,
      } });
    } catch (error) {
      await cancelOffscreenSabrTask(taskId);
      await chrome.storage.session.remove(pendingKey);
      throw error;
    }
    return { taskId };
  }

  const { info, client } = localDirectPlan
    ? { info: localInfo, client: null }
    : await getVideoInfo(videoId);
  const plan = getQualityPlan(info, height);
  if (!plan) throw new Error('Esta resolução não está disponível num formato compatível.');

  const filename = safeFilename(videoTitle, videoId);
  if (plan.mode === 'direct') {
    const url = await decipher(plan.format, client);
    const downloadId = await startBrowserDownload({
      url,
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
      taskId,
      tabId,
      mode: 'merge',
      videoId,
      title: info.basic_info.title || filename,
      resolution: height,
      width: plan.video.width,
      height: plan.video.height,
      durationSeconds: info.basic_info.duration,
      createdAt: Date.now(),
      extension: plan.extension,
      suggestedFilename,
      videoUrl,
      audioUrl,
    },
  });

  try {
    const helper = await chrome.tabs.create({
      url: `${chrome.runtime.getURL('download.html')}?task=${taskId}`,
      active: false,
    });
    await chrome.storage.session.set({ [key]: { ...((await chrome.storage.session.get(key))[key]), helperTabId: helper.id } });
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
  return { taskId };
}

chrome.downloads.onCreated.addListener(item => {
  if (!item.url?.startsWith(`blob:${chrome.runtime.getURL('')}`)) return;
  chrome.storage.session.get(null).then(entries => {
    const match = Object.entries(entries).find(([key, task]) =>
      key.startsWith('pending:') && task?.objectUrl === item.url,
    );
    if (!match) return;
    const [key, task] = match;
    const updated = { ...task, status: 'downloading', downloadId: item.id, bytes: item.totalBytes };
    return chrome.storage.session.set({ [key]: updated }).then(() =>
      chrome.runtime.sendMessage({ target: 'download-page', type: 'download-started', taskId: task.taskId }).catch(() => {}),
    );
  }).catch(() => {});
});

chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current)) return;
  chrome.storage.session.get(null).then(entries => {
    const match = Object.entries(entries).find(([key, task]) =>
      key.startsWith('pending:') && task?.downloadId === delta.id,
    );
    if (!match) return;
    const [key, task] = match;
    const completed = delta.state.current === 'complete';
    const updated = {
      ...task,
      status: completed ? 'complete' : 'failed',
      ...(delta.error?.current && { error: `O Chrome interrompeu a gravação (${delta.error.current}).` }),
    };
    return chrome.storage.session.set({ [key]: updated }).then(() => Promise.all([
      chrome.runtime.sendMessage({
        target: 'download-page', type: 'download-finished',
        taskId: task.taskId, status: updated.status,
      }).catch(() => {}),
      Number.isInteger(task.tabId) && chrome.tabs.sendMessage(task.tabId, {
        target: 'youtube-download', type: 'download-task-finished',
        taskId: task.taskId, status: updated.status, error: updated.error,
      }).catch(() => {}),
    ]));
  }).catch(() => {});
});

function messageError(error) {
  const message = error instanceof Error ? error.message : '';
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Falhou a ligação ao YouTube ao preparar a transferência. Inicia a reprodução e tenta novamente.';
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
          updatedAt: Date.now(),
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
    if (sender.url?.split(/[?#]/)[0] !== extensionPage || !/^[\w-]{36}$/.test(taskId)) return;
    const key = `${sabrTaskPrefix}${taskId}`;
    chrome.storage.session.get(key).then(async stored => {
      let state = stored[key] ?? null;
      if (state?.status === 'running' && Date.now() - (state.updatedAt ?? state.startedAt ?? 0) > 90_000) {
        await cancelOffscreenSabrTask(taskId);
        state = {...state, status:'failed', error:'A transferência deixou de responder. Volta ao vídeo e tenta novamente.'};
        await chrome.storage.session.set({[key]:state});
        await removeSabrOriginRuleIfIdle();
      }
      sendResponse({ state });
    }).catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'cancel-sabr-task') {
    const extensionPage = chrome.runtime.getURL('download.html');
    const taskId = typeof message.taskId === 'string' ? message.taskId : '';
    if (sender.url?.split(/[?#]/)[0] !== extensionPage || !/^[\w-]{36}$/.test(taskId)) return;
    cancelOffscreenSabrTask(taskId).then(() => sendResponse({ accepted: true }))
      .catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'consume-pending-download') {
    const extensionPage = chrome.runtime.getURL('download.html');
    const taskId = typeof message.taskId === 'string' ? message.taskId : '';
    if (sender.url?.split(/[?#]/)[0] !== extensionPage || !/^[\w-]{36}$/.test(taskId)) return;
    const key = `pending:${taskId}`;
    chrome.storage.session.get(key).then(async stored => {
      let task = stored[key];
      if (task && Number.isInteger(sender.tab?.id)) {
        if (Number.isInteger(task.helperTabId) && task.helperTabId !== sender.tab.id) {
          sendResponse({ error: 'Este pedido já está aberto noutra página.' });
          return;
        }
        if (!Number.isInteger(task.helperTabId)) {
          task = { ...task, helperTabId: sender.tab.id };
          await chrome.storage.session.set({ [key]: task });
        }
      }
      sendResponse(task ? { task } : { error: 'O pedido de download expirou. Volta ao vídeo e tenta novamente.' });
    }).catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'download-page-state') {
    const extensionPage = chrome.runtime.getURL('download.html');
    const taskId = typeof message.taskId === 'string' ? message.taskId : '';
    const allowed = ['preparing', 'transferring', 'muxing', 'ready', 'downloading', 'failed'];
    if (sender.url?.split(/[?#]/)[0] !== extensionPage || !/^[\w-]{36}$/.test(taskId)
      || !allowed.includes(message.status)) return;
    const key = `pending:${taskId}`;
    chrome.storage.session.get(key).then(async stored => {
      const task = stored[key];
      if (!task || task.helperTabId !== sender.tab?.id) {
        sendResponse({ accepted: false });
        return;
      }
      const objectUrl = message.status === 'ready' ? message.objectUrl : undefined;
      if (objectUrl && !objectUrl.startsWith(`blob:${chrome.runtime.getURL('')}`)) {
        sendResponse({ accepted: false });
        return;
      }
      await chrome.storage.session.set({ [key]: {
        ...task,
        status: message.status,
        ...(Number.isFinite(message.bytes) && { bytes: message.bytes }),
        ...(objectUrl && { objectUrl }),
        ...(message.status === 'failed' && typeof message.error === 'string'
          && { error: message.error.slice(0, 300) }),
      } });
      sendResponse({ accepted: true });
      if (message.status === 'failed' && Number.isInteger(task.tabId)) {
        chrome.tabs.sendMessage(task.tabId, {
          target: 'youtube-download', type: 'download-task-finished', taskId,
          status: 'failed', error: message.error,
        }).catch(() => {});
      }
    }).catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'download-task-state') {
    const taskId = typeof message.taskId === 'string' ? message.taskId : '';
    if (!/^[\w-]{36}$/.test(taskId) || !Number.isInteger(sender.tab?.id)) return;
    const pendingKey = `pending:${taskId}`;
    const sabrKey = `${sabrTaskPrefix}${taskId}`;
    chrome.storage.session.get([pendingKey, sabrKey]).then(stored => {
      const task = stored[pendingKey];
      if (!task || task.tabId !== sender.tab.id) {
        sendResponse({ error: 'A tarefa de download já não está disponível.' });
        return;
      }
      const transfer = stored[sabrKey];
      sendResponse({ state: {
        status: task.status ?? (transfer?.status === 'running' ? 'transferring' : 'preparing'),
        bytes: task.bytes ?? transfer?.bytes ?? 0,
        error: task.error ?? transfer?.error,
      } });
    }).catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'finish-download-task') {
    if (sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('download.html') || !/^[\w-]{36}$/.test(message.taskId ?? '')) return;
    chrome.storage.session.get(`pending:${message.taskId}`).then(async stored => {
      const task = stored[`pending:${message.taskId}`];
      if (!task || task.helperTabId !== sender.tab?.id) {
        sendResponse({ accepted: false });
        return;
      }
      if (task.status === 'complete') {
        await chrome.storage.session.remove(`pending:${message.taskId}`);
      } else {
        await chrome.storage.session.set({ [`pending:${message.taskId}`]: {
          ...task, helperTabId: undefined, objectUrl: undefined,
        } });
      }
      await chrome.storage.session.remove(`${sabrTaskPrefix}${message.taskId}`);
      sendResponse({ accepted: true });
      if (Number.isInteger(sender.tab.id)) chrome.tabs.remove(sender.tab.id).catch(() => {});
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
    getResolutionsForTab(currentId, message.playerData)
      .then(resolutions => sendResponse({ resolutions, source: 'player' }))
      .catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }

  if (message.type === 'download' && Number.isInteger(message.resolution) && message.resolution > 0) {
    startDownload(currentId, message.videoTitle, message.resolution, message.mode, sender.tab?.id, message.playerData)
      .then(sendResponse)
      .catch(error => sendResponse({ error: messageError(error) }));
    return true;
  }
});
