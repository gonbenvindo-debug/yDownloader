import { SabrStream } from 'googlevideo/sabr-stream';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { inspectMedia } from './media-merge.js';

const activeJobs = new Map();

function isValidTaskId(value) {
  return typeof value === 'string' && /^[\w-]{36}$/.test(value);
}

function mediaFileNames(taskId) {
  return {
    video: `${taskId}-video.media`,
    audio: `${taskId}-audio.media`,
  };
}

async function removeMediaFiles(taskId) {
  const directory = await navigator.storage.getDirectory();
  for (const name of Object.values(mediaFileNames(taskId))) {
    await directory.removeEntry(name).catch(() => {});
  }
}

async function removeExpiredMedia() {
  const directory = await navigator.storage.getDirectory();
  for await (const [name, handle] of directory.entries()) {
    const match = /^([\w-]{36})-(video|audio)\.media$/.exec(name);
    if (!match || handle.kind !== 'file' || activeJobs.has(match[1])) continue;
    const file = await handle.getFile();
    if (Date.now() - file.lastModified > 24 * 60 * 60 * 1000)
      await directory.removeEntry(name).catch(() => {});
  }
}

function reportState(taskId, status, extra = {}) {
  const job = activeJobs.get(taskId);
  if (!job) return Promise.resolve();
  job.reports = job.reports
    .then(() => chrome.runtime.sendMessage({ type: 'sabr-job-state', taskId, status, ...extra }))
    .catch(() => {});
  return job.reports;
}

async function writeStreamToOpfs(stream, name, job) {
  const directory = await navigator.storage.getDirectory();
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  const monitored = stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (job.cancelled) throw new DOMException('Download cancelado.', 'AbortError');
        job.bytes += chunk.byteLength;
        controller.enqueue(chunk);
        const now = Date.now();
        if (now - job.lastReportedAt > 1000) {
          job.lastReportedAt = now;
          reportState(job.taskId, 'running', { bytes: job.bytes });
        }
      },
    }),
  );
  await monitored.pipeTo(writable, { signal: job.controller.signal });
}

async function runJob(taskId, config) {
  const job = {
    taskId,
    stream: null,
    cancelled: false,
    bytes: 0,
    lastReportedAt: Date.now(),
    controller: new AbortController(),
    reports: Promise.resolve(),
  };
  activeJobs.set(taskId, job);
  let streams = [];
  const heartbeat = setInterval(() => {
    void reportState(taskId, 'running', { bytes: job.bytes });
  }, 15_000);
  try {
    await removeExpiredMedia();
    const endpoint = new URL(config.serverAbrStreamingUrl);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.googlevideo.com')) {
      throw new Error('O endereço SABR do YouTube é inválido.');
    }
    if (
      !config.poToken ||
      !config.videoPlaybackUstreamerConfig ||
      !config.videoFormat ||
      !config.audioFormat
    ) {
      throw new Error('A sessão do player não contém os dados necessários para SABR.');
    }

    job.stream = new SabrStream({
      fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
      serverAbrStreamingUrl: endpoint.href,
      videoPlaybackUstreamerConfig: config.videoPlaybackUstreamerConfig,
      poToken: config.poToken,
      clientInfo: config.clientInfo,
      durationMs: config.durationMs || undefined,
      formats: [config.videoFormat, config.audioFormat],
    });
    const { videoStream, audioStream } = await job.stream.start({
      videoFormat: config.videoFormat,
      audioFormat: config.audioFormat,
      maxRetries: 5,
      stallDetectionMs: 45_000,
    });
    const names = mediaFileNames(taskId);
    streams = [
      writeStreamToOpfs(videoStream, names.video, job),
      writeStreamToOpfs(audioStream, names.audio, job),
    ];
    await Promise.all(streams);
    if (job.cancelled) throw new DOMException('Download cancelado.', 'AbortError');
    const directory = await navigator.storage.getDirectory();
    const inputs = [];
    try {
      for (const name of [names.video, names.audio]) {
        const handle = await directory.getFileHandle(name);
        inputs.push(
          new Input({ source: new BlobSource(await handle.getFile()), formats: ALL_FORMATS }),
        );
      }
      await inspectMedia(inputs[0], inputs[1], {
        width: config.videoFormat.width,
        height: config.videoFormat.height,
        durationSeconds: config.durationMs / 1000,
      });
    } finally {
      inputs.forEach((input) => input.dispose());
    }
    clearInterval(heartbeat);
    await reportState(taskId, 'complete', { bytes: job.bytes });
  } catch (error) {
    clearInterval(heartbeat);
    job.controller.abort(error);
    try {
      job.stream?.abort();
    } catch {
      /* streams may already be closed */
    }
    await Promise.allSettled(streams);
    await removeMediaFiles(taskId).catch(() => {});
    if (job.cancelled || error?.name === 'AbortError') {
      await reportState(taskId, 'cancelled');
    } else {
      const detail = error instanceof Error ? error.message : 'Falha ao receber os streams SABR.';
      await reportState(taskId, 'failed', {
        error: /attestation required/i.test(detail)
          ? 'O YouTube recusou a sessão de reprodução. Atualiza o vídeo, confirma que reproduz normalmente e volta a tentar. O ficheiro incompleto foi eliminado.'
          : error?.name === 'QuotaExceededError'
            ? 'O browser ficou sem espaço para os ficheiros temporários. Liberta espaço e tenta novamente.'
            : detail,
      });
    }
  } finally {
    clearInterval(heartbeat);
    activeJobs.delete(taskId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'sabr-offscreen') return;

  if (message.type === 'start-sabr-download') {
    if (!isValidTaskId(message.taskId) || activeJobs.has(message.taskId) || activeJobs.size >= 2) {
      sendResponse({
        accepted: false,
        error: 'Não foi possível iniciar. Aguarda que uma transferência em curso termine.',
      });
      return;
    }
    void runJob(message.taskId, message.sabr);
    sendResponse({ accepted: true });
    return;
  }

  if (message.type === 'cancel-sabr-download') {
    if (!isValidTaskId(message.taskId)) {
      sendResponse({ accepted: false });
      return;
    }
    const job = activeJobs.get(message.taskId);
    if (job) {
      job.cancelled = true;
      job.controller.abort(new DOMException('Download cancelado.', 'AbortError'));
      try {
        job.stream?.abort();
      } catch {
        /* already closed */
      }
    }
    sendResponse({ accepted: true });
  }
});
