import { SabrStream } from 'googlevideo/sabr-stream';

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

function reportState(taskId, status, extra = {}) {
  void chrome.runtime.sendMessage({ type: 'sabr-job-state', taskId, status, ...extra }).catch(() => {});
}

async function writeStreamToOpfs(stream, name, job) {
  const directory = await navigator.storage.getDirectory();
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  const monitored = stream.pipeThrough(new TransformStream({
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
  }));
  await monitored.pipeTo(writable);
}

async function runJob(taskId, config) {
  const job = {
    taskId,
    stream: null,
    cancelled: false,
    bytes: 0,
    lastReportedAt: Date.now(),
  };
  activeJobs.set(taskId, job);
  try {
    const endpoint = new URL(config.serverAbrStreamingUrl);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.googlevideo.com')) {
      throw new Error('O endereço SABR do YouTube é inválido.');
    }
    if (!config.poToken || !config.videoPlaybackUstreamerConfig
      || !config.videoFormat || !config.audioFormat) {
      throw new Error('A sessão do player não contém os dados necessários para SABR.');
    }

    job.stream = new SabrStream({
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
    await Promise.all([
      writeStreamToOpfs(videoStream, names.video, job),
      writeStreamToOpfs(audioStream, names.audio, job),
    ]);
    if (job.cancelled) throw new DOMException('Download cancelado.', 'AbortError');
    reportState(taskId, 'complete', { bytes: job.bytes });
  } catch (error) {
    await removeMediaFiles(taskId);
    if (job.cancelled || error?.name === 'AbortError') {
      reportState(taskId, 'cancelled');
    } else {
      reportState(taskId, 'failed', {
        error: error instanceof Error ? error.message : 'Falha ao receber os streams SABR.',
      });
    }
  } finally {
    activeJobs.delete(taskId);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'sabr-offscreen') return;

  if (message.type === 'start-sabr-download') {
    if (!isValidTaskId(message.taskId) || activeJobs.has(message.taskId)) {
      sendResponse({ accepted: false, error: 'O pedido SABR é inválido ou já está em execução.' });
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
      job.stream?.abort();
    }
    sendResponse({ accepted: true });
  }
});
