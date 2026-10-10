import { SabrStream } from 'googlevideo/sabr-stream';
import { ALL_FORMATS, BlobSource, Input, UrlSource } from 'mediabunny';
import { inspectMedia, mergeMedia } from './media-merge.js';

const activeJobs = new Map();

function isValidTaskId(value) {
  return typeof value === 'string' && /^[\w-]{36}$/.test(value);
}

function mediaFileNames(taskId) {
  return {
    video: `${taskId}-video.media`,
    audio: `${taskId}-audio.media`,
    output: `${taskId}-output.media`,
  };
}

async function removeJobFiles(taskId) {
  const directory = await navigator.storage.getDirectory();
  await Promise.all(Object.values(mediaFileNames(taskId)).map(name =>
    directory.removeEntry(name).catch(() => {}),
  ));
}

async function removeExpiredMedia() {
  const directory = await navigator.storage.getDirectory();
  for await (const [name, handle] of directory.entries()) {
    const match = /^([\w-]{36})-(?:video|audio|output)\.media$/.exec(name);
    if (!match || handle.kind !== 'file' || activeJobs.has(match[1])) continue;
    const file = await handle.getFile();
    if (Date.now() - file.lastModified > 24 * 60 * 60 * 1000)
      await directory.removeEntry(name).catch(() => {});
  }
}

function reportState(taskId, status, extra = {}) {
  const job = activeJobs.get(taskId);
  if (!job) return Promise.resolve();
  if (extra.phase) job.phase = extra.phase;
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
          reportState(job.taskId, 'running', { phase: 'transferring', bytes: job.bytes });
        }
      },
    }),
  );
  await monitored.pipeTo(writable, { signal: job.controller.signal });
}

function createInput(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.googlevideo.com'))
    throw new Error('O endereço do stream é inválido.');
  return new Input({
    source: new UrlSource(parsed.href, { requestInit: { credentials: 'include' } }),
    formats: ALL_FORMATS,
  });
}

async function createSabrInput(taskId, track) {
  const directory = await navigator.storage.getDirectory();
  const handle = await directory.getFileHandle(mediaFileNames(taskId)[track]);
  return new Input({ source: new BlobSource(await handle.getFile()), formats: ALL_FORMATS });
}

async function mergeAndDeliver(job) {
  const { task, taskId } = job;
  if (!['mp4', 'webm'].includes(task.extension)) throw new Error('O formato de destino não é suportado.');
  const expected = {
    width: task.width,
    height: task.height,
    durationSeconds: task.durationSeconds,
  };
  const inputs = [];
  let writable;
  try {
    inputs.push(task.mode === 'sabr'
      ? await createSabrInput(taskId, 'video')
      : createInput(task.videoUrl));
    inputs.push(task.mode === 'sabr'
      ? await createSabrInput(taskId, 'audio')
      : createInput(task.audioUrl));
    const directory = await navigator.storage.getDirectory();
    const handle = await directory.getFileHandle(mediaFileNames(taskId).output, { create: true });
    writable = await handle.createWritable();
    job.phase = 'muxing';
    await reportState(taskId, 'running', { phase: job.phase, bytes: 0 });
    let lastReport = 0;
    await mergeMedia({
      videoInput: inputs[0],
      audioInput: inputs[1],
      writable,
      extension: task.extension,
      expected,
      signal: job.controller.signal,
      onProgress(bytes) {
        if (Date.now() - lastReport < 1000) return;
        lastReport = Date.now();
        reportState(taskId, 'running', { phase: 'muxing', bytes });
      },
    });
    writable = null;
    const file = await handle.getFile();
    const verification = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      await inspectMedia(verification, verification, expected);
    } finally {
      verification.dispose();
    }

    if (task.mode === 'sabr') {
      for (const track of ['video', 'audio'])
        await directory.removeEntry(mediaFileNames(taskId)[track]).catch(() => {});
    }
    job.objectUrl = URL.createObjectURL(file);
    job.phase = 'downloading';
    await reportState(taskId, 'running', {
      phase: 'downloading', bytes: file.size, objectUrl: job.objectUrl,
    });

    const anchor = document.createElement('a');
    anchor.href = job.objectUrl;
    anchor.download = task.suggestedFilename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    job.deliveryTimer = setTimeout(() => {
      void failJob(job, new Error('O Chrome não iniciou a gravação. Tenta novamente.'));
    }, 60_000);
  } catch (error) {
    await writable?.abort(error).catch(() => {});
    throw error;
  } finally {
    inputs.forEach(input => input.dispose());
  }
}

function makeJob(taskId, task) {
  return {
    taskId,
    task,
    phase: task.mode === 'sabr' ? 'transferring' : 'preparing',
    stream: null,
    cancelled: false,
    bytes: 0,
    lastReportedAt: Date.now(),
    controller: new AbortController(),
    reports: Promise.resolve(),
    objectUrl: null,
    deliveryTimer: null,
  };
}

async function failJob(job, error) {
  if (!activeJobs.has(job.taskId)) return;
  job.cancelled = true;
  clearTimeout(job.deliveryTimer);
  job.controller.abort(error);
  try { job.stream?.abort(); } catch { /* stream may have ended */ }
  await removeJobFiles(job.taskId).catch(() => {});
  if (job.objectUrl) URL.revokeObjectURL(job.objectUrl);
  const detail = error instanceof Error ? error.message : 'Falha ao preparar o ficheiro.';
  await reportState(job.taskId, 'failed', {
    error: /attestation required/i.test(detail)
      ? 'O YouTube recusou a sessão atual. Deixa o vídeo reproduzir alguns segundos e tenta novamente.'
      : error?.name === 'QuotaExceededError'
        ? 'O browser ficou sem espaço para os ficheiros temporários. Liberta espaço e tenta novamente.'
        : detail,
  });
  activeJobs.delete(job.taskId);
}

async function runSabrJob(taskId, config, task) {
  const job = makeJob(taskId, task);
  activeJobs.set(taskId, job);
  const streams = [];
  const heartbeat = setInterval(() => {
    reportState(taskId, 'running', { phase: job.phase, bytes: job.bytes });
  }, 15_000);
  try {
    await removeExpiredMedia();
    const endpoint = new URL(config.serverAbrStreamingUrl);
    if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.googlevideo.com'))
      throw new Error('O endereço SABR do YouTube é inválido.');
    if (!config.poToken || !config.videoPlaybackUstreamerConfig || !config.videoFormat || !config.audioFormat)
      throw new Error('A sessão do player não contém os dados necessários para SABR.');

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
    streams.push(
      writeStreamToOpfs(videoStream, names.video, job),
      writeStreamToOpfs(audioStream, names.audio, job),
    );
    await Promise.all(streams);
    if (job.cancelled) throw new DOMException('Download cancelado.', 'AbortError');

    const directory = await navigator.storage.getDirectory();
    const verifyInputs = [];
    try {
      for (const name of [names.video, names.audio]) {
        const handle = await directory.getFileHandle(name);
        verifyInputs.push(new Input({ source: new BlobSource(await handle.getFile()), formats: ALL_FORMATS }));
      }
      await inspectMedia(verifyInputs[0], verifyInputs[1], {
        width: config.videoFormat.width,
        height: config.videoFormat.height,
        durationSeconds: config.durationMs / 1000,
      });
    } finally {
      verifyInputs.forEach(input => input.dispose());
    }

    await mergeAndDeliver(job);
  } catch (error) {
    await Promise.allSettled(streams);
    await failJob(job, error);
  } finally {
    clearInterval(heartbeat);
  }
}

async function runMergeJob(taskId, task) {
  const job = makeJob(taskId, task);
  activeJobs.set(taskId, job);
  const heartbeat = setInterval(() => {
    reportState(taskId, 'running', { phase: job.phase });
  }, 15_000);
  try {
    await removeExpiredMedia();
    await mergeAndDeliver(job);
  } catch (error) {
    await failJob(job, error);
  } finally {
    clearInterval(heartbeat);
  }
}

async function cleanCompletedJob(taskId) {
  const job = activeJobs.get(taskId);
  if (!job) return;
  clearTimeout(job.deliveryTimer);
  if (job.objectUrl) URL.revokeObjectURL(job.objectUrl);
  await removeJobFiles(taskId).catch(() => {});
  activeJobs.delete(taskId);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== chrome.runtime.id) return;

  if (message.type === 'sabr-download-started' && message.target === 'sabr-offscreen') {
    const job = activeJobs.get(message.taskId);
    if (job) clearTimeout(job.deliveryTimer);
    sendResponse({ accepted: Boolean(job) });
    return;
  }

  if (message.type === 'sabr-download-finished' && message.target === 'sabr-offscreen') {
    cleanCompletedJob(message.taskId).then(() => sendResponse({ accepted: true }));
    return true;
  }

  if (message.target !== 'sabr-offscreen') return;

  if (message.type === 'start-sabr-download') {
    if (!isValidTaskId(message.taskId) || activeJobs.has(message.taskId)
      || activeJobs.size >= 2 || message.task?.mode !== 'sabr') {
      sendResponse({ accepted: false, error: 'Não foi possível iniciar. Aguarda que uma transferência em curso termine.' });
      return;
    }
    void runSabrJob(message.taskId, message.sabr, message.task);
    sendResponse({ accepted: true });
    return;
  }

  if (message.type === 'start-merge-download') {
    if (!isValidTaskId(message.taskId) || activeJobs.has(message.taskId)
      || activeJobs.size >= 2 || message.task?.mode !== 'merge') {
      sendResponse({ accepted: false, error: 'Não foi possível iniciar. Aguarda que uma transferência em curso termine.' });
      return;
    }
    void runMergeJob(message.taskId, message.task);
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
      try { job.stream?.abort(); } catch { /* already closed */ }
    }
    sendResponse({ accepted: Boolean(job) });
  }
});
