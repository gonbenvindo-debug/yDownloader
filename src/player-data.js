function mediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.googlevideo.com') ? url.href : undefined;
  } catch { return undefined; }
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : fallback;
}

export function resolutionHeight(format) {
  return Number(/^(\d{2,4})p(?:\b|\d)/i.exec(format.quality_label ?? format.qualityLabel ?? '')?.[1]) || number(format.height);
}

function normalizeFormat(raw) {
  const itag = number(raw?.itag);
  const mime = raw?.mimeType ?? raw?.mime_type;
  if (!Number.isInteger(itag) || itag <= 0 || typeof mime !== 'string'
    || !/^(?:video|audio)\/(?:mp4|webm)(?:\s*;|$)/i.test(mime)) return null;
  const value = (camel, snake) => raw[camel] ?? raw[snake];
  const format = {
    itag, mime_type: mime.slice(0, 500),
    width: number(raw.width), height: number(raw.height),
    bitrate: number(raw.bitrate), average_bitrate: number(value('averageBitrate', 'average_bitrate')),
    quality: raw.quality, quality_label: raw.qualityLabel ?? raw.quality_label,
    audio_quality: value('audioQuality', 'audio_quality'), audio_channels: number(value('audioChannels', 'audio_channels')),
    approx_duration_ms: number(value('approxDurationMs', 'approx_duration_ms')), content_length: number(value('contentLength', 'content_length')),
    last_modified_ms: String(value('lastModified', 'last_modified_ms') ?? '0'), xtags: raw.xtags,
    is_drc: value('isDrc', 'is_drc') === true, is_auto_dubbed: value('isAutoDubbed', 'is_auto_dubbed') === true,
    is_descriptive: value('isDescriptive', 'is_descriptive') === true, is_dubbed: value('isDubbed', 'is_dubbed') === true,
    is_original: value('isOriginal', 'is_original') === true, is_secondary: value('isSecondary', 'is_secondary') === true,
    drm_families: value('drmFamilies', 'drm_families') ?? [],
    drm_track_type: value('drmTrackType', 'drm_track_type'), fair_play_key_uri: value('fairPlayKeyUri', 'fair_play_key_uri'),
    has_text: false, url: mediaUrl(raw.url),
  };
  format.has_video = /^video\//i.test(mime) && (format.height > 0 || Boolean(format.quality_label));
  format.has_audio = /^audio\//i.test(mime) || Boolean(format.audio_quality || value('audioBitrate', 'audio_bitrate'))
    || /\b(?:mp4a|opus|vorbis)/i.test(mime);
  for (const [rawKey, key] of [['signatureCipher', 'signature_cipher'], ['cipher', 'cipher']]) {
    const cipher = raw[rawKey] ?? raw[key];
    if (typeof cipher === 'string' && cipher.length < 32_000
      && mediaUrl(new URLSearchParams(cipher).get('url'))) format[key] = cipher;
  }
  const track = raw.audioTrack ?? raw.audio_track;
  if (track) format.audio_track = {
    id: String(track.id ?? '').slice(0, 200),
    audio_is_default: (track.audioIsDefault ?? track.audio_is_default) === true,
  };
  return format;
}

export function hasDrm(format) {
  const type = String(format.drmTrackType ?? format.drm_track_type ?? '').toLowerCase();
  return Boolean((format.drmFamilies ?? format.drm_families)?.length
    || (type && type !== 'none' && type !== '0' && !type.endsWith('_none'))
    || format.fairPlayKeyUri || format.fair_play_key_uri);
}

export function normalizePlayerSnapshot(snapshot, videoId) {
  if (!snapshot || snapshot.videoId !== videoId) return null;
  const streaming = snapshot.streamingData ?? {};
  const formats = values => Array.isArray(values) ? values.slice(0, 300).map(normalizeFormat).filter(Boolean) : [];
  const nativeHeights = [...new Set((Array.isArray(snapshot.qualities) ? snapshot.qualities : [])
    .map(quality => number(quality.height)).filter(height => Number.isInteger(height) && height >= 72 && height <= 8640))];
  const rawValues = values => Array.isArray(values) ? values.slice(0, 300).filter(raw => raw && typeof raw === 'object') : [];
  const rawVideoFormats = [...rawValues(streaming.formats), ...rawValues(streaming.adaptiveFormats)].filter(raw => {
    const mime = raw?.mimeType ?? raw?.mime_type ?? '';
    return !/^audio\//i.test(mime) && resolutionHeight(raw ?? {}) > 0;
  });
  const videoHeights = [...new Set(rawVideoFormats.filter(raw => !hasDrm(raw)).map(resolutionHeight))]
    .filter(height => Number.isInteger(height) && height >= 72 && height <= 8640);
  const protectedHeights = rawVideoFormats.filter(hasDrm).map(resolutionHeight).filter(height => !videoHeights.includes(height));
  return {
    nativeHeights: nativeHeights.filter(height => !protectedHeights.includes(height)),
    videoHeights,
    info: {
      basic_info: { title: String(snapshot.title ?? '').slice(0, 500), duration: number(snapshot.durationSeconds) },
      streaming_data: {
        formats: formats(streaming.formats), adaptive_formats: formats(streaming.adaptiveFormats),
        server_abr_streaming_url: mediaUrl(streaming.serverAbrStreamingUrl),
      },
    },
  };
}
