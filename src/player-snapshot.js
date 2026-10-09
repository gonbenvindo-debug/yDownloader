const qualityHeights = { tiny: 144, small: 240, medium: 360, large: 480 };
const formatFields = [
  'itag', 'mimeType', 'width', 'height', 'quality', 'qualityLabel', 'fps',
  'bitrate', 'averageBitrate', 'audioQuality', 'audioBitrate', 'audioSampleRate',
  'audioChannels', 'contentLength', 'approxDurationMs', 'lastModified', 'xtags',
  'url', 'signatureCipher', 'cipher', 'isDrc', 'isAutoDubbed', 'isDescriptive',
  'isDubbed', 'isOriginal', 'isSecondary', 'drmTrackType', 'fairPlayKeyUri',
];
const fieldAliases = {
  mimeType: 'mime_type', qualityLabel: 'quality_label', averageBitrate: 'average_bitrate',
  audioQuality: 'audio_quality', audioBitrate: 'audio_bitrate', audioSampleRate: 'audio_sample_rate',
  audioChannels: 'audio_channels', contentLength: 'content_length', approxDurationMs: 'approx_duration_ms',
  lastModified: 'last_modified_ms', signatureCipher: 'signature_cipher', isDrc: 'is_drc',
  isAutoDubbed: 'is_auto_dubbed', isDescriptive: 'is_descriptive', isDubbed: 'is_dubbed',
  isOriginal: 'is_original', isSecondary: 'is_secondary', drmTrackType: 'drm_track_type',
  fairPlayKeyUri: 'fair_play_key_uri',
};

function safely(read) {
  try { return read(); } catch { return undefined; }
}

function asResponse(value) {
  if (typeof value === 'string') value = safely(() => JSON.parse(value));
  return value?.playerResponse ?? value?.player_response ?? value;
}

export function parseInlinePlayerResponse(text) {
  const assignment = /(?:\bytInitialPlayerResponse|window\s*\[\s*["']ytInitialPlayerResponse["']\s*\])\s*=\s*/.exec(text);
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
    const value = format[key] ?? format[fieldAliases[key]];
    if (typeof value === 'string') result[key] = value.slice(0, 32_000);
    else if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  const track = format.audioTrack ?? format.audio_track;
  if (track) {
    result.audioTrack = {
      id: String(track.id ?? '').slice(0, 200),
      audioIsDefault: (track.audioIsDefault ?? track.audio_is_default) === true,
    };
  }
  const drmFamilies = format.drmFamilies ?? format.drm_families;
  if (Array.isArray(drmFamilies)) result.drmFamilies = drmFamilies.filter(value => typeof value === 'string');
  return result;
}

export function snapshotFromPlayerResponse(value, videoId) {
  const response = asResponse(value);
  const details = response?.videoDetails ?? response?.video_details ?? response?.basic_info;
  if ((details?.videoId ?? details?.video_id ?? details?.id) !== videoId) return null;
  const streaming = response.streamingData ?? response.streaming_data ?? {};
  const formats = values => Array.isArray(values) ? values.slice(0, 300).filter(Boolean).map(copyFormat) : [];
  return {
    videoId,
    title: String(details.title ?? '').slice(0, 500),
    durationSeconds: Number(details.lengthSeconds ?? details.duration) || 0,
    qualities: [],
    streamingData: {
      formats: formats(streaming.formats),
      adaptiveFormats: formats(streaming.adaptiveFormats ?? streaming.adaptive_formats),
      serverAbrStreamingUrl: streaming.serverAbrStreamingUrl ?? streaming.server_abr_streaming_url,
    },
  };
}

// Enrich partial getter responses with the complete page response. Never mix video IDs.
export function mergePlayerSnapshots(videoId, ...snapshots) {
  const current = snapshots.filter(value => value?.videoId === videoId);
  if (!current.length) return null;
  const qualities = new Map();
  const formats = new Map();
  const adaptiveFormats = new Map();
  let title = '';
  let durationSeconds = 0;
  let serverAbrStreamingUrl;
  for (const snapshot of current) {
    title = snapshot.title || title;
    durationSeconds = snapshot.durationSeconds || durationSeconds;
    serverAbrStreamingUrl = snapshot.streamingData?.serverAbrStreamingUrl || serverAbrStreamingUrl;
    for (const quality of snapshot.qualities ?? []) qualities.set(Number(quality.height), quality);
    for (const [name, target] of [['formats', formats], ['adaptiveFormats', adaptiveFormats]]) {
      for (const format of snapshot.streamingData?.[name] ?? []) {
        const key = `${format.itag ?? `${format.height}:${format.qualityLabel}`}:${format.audioTrack?.id ?? ''}:${format.isDrc === true}`;
        const fields = Object.fromEntries(Object.entries(format).filter(([, value]) => value !== undefined && value !== ''));
        target.set(key, { ...target.get(key), ...fields });
      }
    }
  }
  return {
    videoId, title, durationSeconds,
    qualities: [...qualities.values()].sort((a, b) => a.height - b.height),
    streamingData: { formats: [...formats.values()], adaptiveFormats: [...adaptiveFormats.values()], serverAbrStreamingUrl },
  };
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
  ].map(response => snapshotFromPlayerResponse(response, videoId)).filter(Boolean);

  // A nonempty getter response can contain only audio or a reduced format list.
  // Inline JSON must still be considered in that case.
  for (const script of document.scripts ?? []) {
    const snapshot = snapshotFromPlayerResponse(parseInlinePlayerResponse(script.textContent ?? ''), videoId);
    if (snapshot) candidates.push(snapshot);
  }
  const snapshot = mergePlayerSnapshots(videoId, ...candidates);
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
  if (!snapshot && !qualities.size) return null;
  return mergePlayerSnapshots(videoId, snapshot, {
    videoId, title: String(videoData?.video_id === videoId ? videoData.title ?? '' : '').slice(0, 500),
    qualities: [...qualities.values()].sort((a, b) => a.height - b.height),
  });
}
