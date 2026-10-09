import { requestPlayerSnapshot } from './player-client.js';
import { collectPlayerSnapshot, mergePlayerSnapshots, parseInlinePlayerResponse, snapshotFromPlayerResponse } from './player-snapshot.js';
import { normalizePlayerSnapshot } from './player-data.js';

function hasQualities(snapshot, videoId) {
  const data = normalizePlayerSnapshot(snapshot, videoId);
  return Boolean(data && (data.nativeHeights.length || data.videoHeights.length));
}

function hasTransferMetadata(snapshot, videoId) {
  const data = normalizePlayerSnapshot(snapshot, videoId)?.info.streaming_data;
  if (!data) return false;
  const detailed = format => /codecs\s*=/i.test(format.mime_type);
  return data.formats.some(format => format.has_video && format.has_audio && detailed(format)
    && (format.url || format.cipher || format.signature_cipher))
    || data.adaptive_formats.some(format => format.has_video && !format.has_audio && detailed(format))
      && data.adaptive_formats.some(format => format.has_audio && !format.has_video && detailed(format));
}

export function createPlayerReader({
  pageWindow = window, pageDocument = document, readBridge = requestPlayerSnapshot,
  fetchImpl = fetch, timeoutMs = 8000, now = Date.now,
} = {}) {
  const cache = new Map();
  return async videoId => {
    if (!/^[\w-]{11}$/.test(videoId)) throw new Error('O endereço do vídeo é inválido.');
    const cached = cache.get(videoId);
    // Script text is visible in the isolated content world even if MAIN is unavailable.
    const inline = collectPlayerSnapshot({ window: {}, document: pageDocument }, videoId);
    const bridge = await readBridge(videoId, pageWindow).catch(() => null);
    let snapshot = mergePlayerSnapshots(videoId,
      cached && now() - cached.savedAt < 45_000 ? cached.snapshot : null, inline, bridge);
    if (hasTransferMetadata(snapshot, videoId)) return snapshot;

    // Fetching the watch page on the current YouTube origin avoids a separate API client,
    // CORS and a backend. It also handles SPA pages whose inline scripts belong to an old video.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let failure;
    try {
      const watchUrl = new URL(`/watch?v=${videoId}`, pageWindow.location.origin);
      const response = await fetchImpl(watchUrl.href, {
        credentials: 'same-origin', signal: controller.signal,
      });
      if (!response.ok) throw new Error(`O YouTube não devolveu a página do vídeo (HTTP ${response.status}).`);
      if (response.url && new URL(response.url).origin !== watchUrl.origin) {
        throw new Error('Abre o vídeo no YouTube e conclui o ecrã de consentimento antes de descarregar.');
      }
      const html = await response.text();
      const fresh = snapshotFromPlayerResponse(parseInlinePlayerResponse(html), videoId);
      if (!fresh || !hasQualities(fresh, videoId)) throw new Error('O YouTube não forneceu os formatos deste vídeo.');
      snapshot = mergePlayerSnapshots(videoId, snapshot, fresh);
      cache.clear();
      cache.set(videoId, { snapshot: fresh, savedAt: now() });
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timeout);
    }
    if (hasQualities(snapshot, videoId)) return snapshot;
    if (failure?.name === 'AbortError') throw new Error('O YouTube demorou a fornecer os formatos. Tenta novamente.');
    if (/failed to fetch|networkerror/i.test(failure?.message ?? '')) {
      throw new Error('Não foi possível ler a página do vídeo no YouTube. Atualiza a página e tenta novamente.');
    }
    throw failure ?? new Error('O player ainda não forneceu as resoluções deste vídeo.');
  };
}
