const qualityHeights = { tiny: 144, small: 240, medium: 360, large: 480 };
const formatFields = [
  'itag', 'mimeType', 'width', 'height', 'quality', 'qualityLabel', 'fps',
  'bitrate', 'averageBitrate', 'audioQuality', 'audioBitrate', 'audioSampleRate',
  'audioChannels', 'contentLength', 'approxDurationMs', 'lastModified', 'xtags',
  'url', 'signatureCipher', 'cipher', 'isDrc', 'isAutoDubbed', 'isDescriptive',
  'isDubbed', 'isOriginal', 'isSecondary', 'drmTrackType', 'fairPlayKeyUri',
];

function safely(read) {
  try { return read(); } catch { return undefined; }
}

function asResponse(value) {
  if (typeof value === 'string') value = safely(() => JSON.parse(value));
  return value?.playerResponse ?? value;
}

export function parseInlinePlayerResponse(text) {
  const assignment = /\bytInitialPlayerResponse\s*=\s*/.exec(text);
  if (!assignment) return null;
  const start = assignment.index + assignment[0].length;
  if (text[start] !== '{') return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) {
      return safely(() => JSON.parse(text.slice(start, index + 1))) ?? null;
    }
  }
  return null;
}

function copyFormat(format) {
  const result = {};
  for (const key of formatFields) {
    const value = format[key];
    if (typeof value === 'string') result[key] = value.slice(0, 32_000);
    else if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  if (format.audioTrack) {
    result.audioTrack = {
      id: String(format.audioTrack.id ?? '').slice(0, 200),
      audioIsDefault: format.audioTrack.audioIsDefault === true,
    };
  }
  if (Array.isArray(format.drmFamilies)) result.drmFamilies = format.drmFamilies.filter(value => typeof value === 'string');
  return result;
}

function qualityHeight(quality, label) {
  return Number(/^(\d{2,4})p(?:\b|\d)/i.exec(label ?? '')?.[1])
    || Number(/^hd(\d{3,4})$/.exec(quality ?? '')?.[1])
    || qualityHeights[quality] || 0;
}

export function collectPlayerSnapshot({ window, document }, videoId) {
  const player = document.getElementById('movie_player') ?? document.querySelector('.html5-video-player');
  const videoData = safely(() => player?.getVideoData?.());
  const ytdPlayer = document.querySelector('ytd-player, ytm-player');
  const watch = document.querySelector('ytd-watch-flexy');
  const candidates = [
    safely(() => player?.getPlayerResponse?.()),
    safely(() => ytdPlayer?.playerResponse),
    safely(() => ytdPlayer?.__data?.playerResponse),
    safely(() => watch?.playerData),
    safely(() => window.ytInitialPlayerResponse),
    safely(() => window.ytplayer?.config?.args?.player_response),
  ].map(asResponse).filter(response => response?.videoDetails?.videoId === videoId);

  if (!candidates.length) {
    for (const script of document.scripts ?? []) {
      const response = parseInlinePlayerResponse(script.textContent ?? '');
      if (response?.videoDetails?.videoId === videoId) { candidates.push(response); break; }
    }
  }
  const response = candidates.find(value => value.streamingData?.formats?.length || value.streamingData?.adaptiveFormats?.length)
    ?? candidates[0];
  const qualities = new Map();
  // During adverts or SPA navigation, the player may still belong to another video.
  if (videoData?.video_id === videoId) {
    for (const quality of safely(() => player?.getAvailableQualityData?.()) ?? []) {
      const height = qualityHeight(quality.quality, quality.qualityLabel);
      if (height) qualities.set(height, { height, quality: quality.quality, label: quality.qualityLabel });
    }
    for (const quality of safely(() => player?.getAvailableQualityLevels?.()) ?? []) {
      const height = qualityHeight(quality);
      if (height && !qualities.has(height)) qualities.set(height, { height, quality, label: `${height}p` });
    }
  }
  if (!response && !qualities.size) return null;
  const streaming = response?.streamingData ?? {};
  return {
    videoId,
    title: String(response?.videoDetails?.title ?? videoData?.title ?? '').slice(0, 500),
    durationSeconds: Number(response?.videoDetails?.lengthSeconds) || 0,
    qualities: [...qualities.values()].sort((a, b) => a.height - b.height),
    streamingData: {
      formats: (streaming.formats ?? []).slice(0, 300).map(copyFormat),
      adaptiveFormats: (streaming.adaptiveFormats ?? []).slice(0, 300).map(copyFormat),
      serverAbrStreamingUrl: streaming.serverAbrStreamingUrl,
    },
  };
}
