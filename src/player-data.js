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
  return Number(/^(\d{2,4})p(?:\b|\d)/i.exec(format.quality_label ?? '')?.[1]) || format.height;
}

function normalizeFormat(raw) {
  if (!raw || !Number.isInteger(raw.itag) || typeof raw.mimeType !== 'string'
    || !/^(?:video|audio)\/(?:mp4|webm)\s*;/i.test(raw.mimeType)) return null;
  const format = {
    itag: raw.itag, mime_type: raw.mimeType.slice(0, 500),
    width: number(raw.width), height: number(raw.height),
    bitrate: number(raw.bitrate), average_bitrate: number(raw.averageBitrate),
    quality: raw.quality, quality_label: raw.qualityLabel,
    audio_quality: raw.audioQuality, audio_channels: number(raw.audioChannels),
    approx_duration_ms: number(raw.approxDurationMs), content_length: number(raw.contentLength),
    last_modified_ms: String(raw.lastModified ?? '0'), xtags: raw.xtags,
    is_drc: raw.isDrc === true, is_auto_dubbed: raw.isAutoDubbed === true,
    is_descriptive: raw.isDescriptive === true, is_dubbed: raw.isDubbed === true,
    is_original: raw.isOriginal === true, is_secondary: raw.isSecondary === true,
    drm_families: Array.isArray(raw.drmFamilies) ? raw.drmFamilies : [],
    drm_track_type: raw.drmTrackType, fair_play_key_uri: raw.fairPlayKeyUri,
    has_text: false, url: mediaUrl(raw.url),
  };
  format.has_video = raw.mimeType.startsWith('video/') && (format.height > 0 || Boolean(raw.qualityLabel));
  format.has_audio = raw.mimeType.startsWith('audio/') || Boolean(raw.audioQuality || raw.audioBitrate)
    || /\b(?:mp4a|opus|vorbis)/i.test(raw.mimeType);
  for (const [rawKey, key] of [['signatureCipher', 'signature_cipher'], ['cipher', 'cipher']]) {
    if (typeof raw[rawKey] === 'string' && raw[rawKey].length < 32_000
      && mediaUrl(new URLSearchParams(raw[rawKey]).get('url'))) format[key] = raw[rawKey];
  }
  if (raw.audioTrack) format.audio_track = {
    id: String(raw.audioTrack.id ?? '').slice(0, 200),
    audio_is_default: raw.audioTrack.audioIsDefault === true,
  };
  return format;
}

export function normalizePlayerSnapshot(snapshot, videoId) {
  if (!snapshot || snapshot.videoId !== videoId) return null;
  const streaming = snapshot.streamingData ?? {};
  const formats = values => Array.isArray(values) ? values.slice(0, 300).map(normalizeFormat).filter(Boolean) : [];
  const nativeHeights = [...new Set((Array.isArray(snapshot.qualities) ? snapshot.qualities : [])
    .map(quality => quality.height).filter(height => Number.isInteger(height) && height >= 72 && height <= 8640))];
  return {
    nativeHeights,
    info: {
      basic_info: { title: String(snapshot.title ?? '').slice(0, 500), duration: number(snapshot.durationSeconds) },
      streaming_data: {
        formats: formats(streaming.formats), adaptive_formats: formats(streaming.adaptiveFormats),
        server_abr_streaming_url: mediaUrl(streaming.serverAbrStreamingUrl),
      },
    },
  };
}
