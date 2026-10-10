import { ALL_FORMATS, BlobSource, Input, UrlSource } from 'mediabunny';
import { inspectMedia, mergeMedia } from './media-merge.js';

const taskId = new URLSearchParams(location.search).get('task');
const title = document.querySelector('#video-title');
const status = document.querySelector('#status');
const cancelButton = document.querySelector('#cancel');
let task;
let controller;
let pollTimer;
let readyTimer;
let outputUrl;
let busy = false;

function setStatus(message) {
  status.textContent = message;
}
function formatBytes(value) {
  return value < 1024 ** 3
    ? `${(value / 1024 ** 2).toFixed(1)} MB`
    : `${(value / 1024 ** 3).toFixed(2)} GB`;
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
async function createSabrInput(track) {
  const directory = await navigator.storage.getDirectory();
  const handle = await directory.getFileHandle(`${task.taskId}-${track}.media`);
  return new Input({ source: new BlobSource(await handle.getFile()), formats: ALL_FORMATS });
}
async function removeTaskFiles() {
  if (!task?.taskId || !['mp4', 'webm'].includes(task.extension)) return;
  const directory = await navigator.storage.getDirectory();
  await Promise.all([
    'video', 'audio', 'output',
  ].map((name) => directory.removeEntry(`${task.taskId}-${name}.${name === 'output' ? task.extension : 'media'}`).catch(() => {})));
}
async function report(status, extra = {}) {
  const result = await chrome.runtime.sendMessage({
    type: 'download-page-state', taskId, status, ...extra,
  });
  if (!result?.accepted) throw new Error(result?.error || 'A tarefa de download expirou.');
}
async function finishTask() {
  clearTimeout(pollTimer);
  clearTimeout(readyTimer);
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null;
  await removeTaskFiles().catch(() => {});
  if (/^[\w-]{36}$/.test(taskId ?? ''))
    await chrome.runtime.sendMessage({ type: 'finish-download-task', taskId }).catch(() => {});
}
async function failTask(error) {
  const message = error instanceof Error ? error.message : 'Falha ao preparar o ficheiro.';
  setStatus(message);
  await report('failed', { error: message }).catch(() => {});
  await finishTask();
  busy = false;
}

async function mergeAndDeliver() {
  if (busy) return;
  busy = true;
  const inputs = [];
  let writable;
  controller = new AbortController();
  try {
    await report('muxing', { bytes: 0 });
    const expected = {
      width: task.width,
      height: task.height,
      durationSeconds: task.durationSeconds,
    };
    inputs.push(task.mode === 'sabr' ? await createSabrInput('video') : createInput(task.videoUrl));
    inputs.push(task.mode === 'sabr' ? await createSabrInput('audio') : createInput(task.audioUrl));
    const directory = await navigator.storage.getDirectory();
    const outputName = `${task.taskId}-output.${task.extension}`;
    const handle = await directory.getFileHandle(outputName, { create: true });
    writable = await handle.createWritable();
    let lastReport = 0;
    await mergeMedia({
      videoInput: inputs[0],
      audioInput: inputs[1],
      writable,
      extension: task.extension,
      expected,
      signal: controller.signal,
      onProgress(bytes) {
        if (Date.now() - lastReport > 1000) {
          lastReport = Date.now();
          void report('muxing', { bytes }).catch(() => {});
        }
      },
    });
    writable = null;
    const file = await handle.getFile();
    const verification = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      const media = await inspectMedia(verification, verification, expected);
      setStatus(`A entregar ${media.width}×${media.height} · ${formatBytes(file.size)}…`);
    } finally {
      verification.dispose();
    }
    outputUrl = URL.createObjectURL(file);
    await report('ready', { bytes: file.size, objectUrl: outputUrl });
    const anchor = document.createElement('a');
    anchor.href = outputUrl;
    anchor.download = task.suggestedFilename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    readyTimer = setTimeout(() => {
      void failTask(new Error('O Chrome não iniciou a gravação do ficheiro. Volta ao YouTube e tenta novamente.'));
    }, 30_000);
  } catch (error) {
    await writable?.abort(error).catch(() => {});
    await failTask(error);
  } finally {
    inputs.forEach((input) => input.dispose());
    controller = null;
  }
}

async function pollSabrState() {
  let terminal = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'sabr-task-state', taskId });
    const state = response?.state;
    if (!state) throw new Error('A tarefa de download já não está disponível.');
    if (state.status === 'complete') {
      terminal = true;
      setStatus(`Transferência recebida (${formatBytes(state.bytes ?? 0)}). A unir áudio e vídeo…`);
      await mergeAndDeliver();
    } else if (['failed', 'cancelled'].includes(state.status)) {
      terminal = true;
      throw new Error(state.status === 'cancelled' ? 'Transferência cancelada.' : state.error || 'Falha ao transferir o vídeo.');
    } else {
      setStatus(`A transferir o vídeo… ${formatBytes(state.bytes ?? 0)}.`);
      await report('transferring', { bytes: state.bytes ?? 0 });
    }
  } catch (error) {
    terminal = true;
    await failTask(error);
  }
  if (!terminal) pollTimer = setTimeout(() => void pollSabrState(), 1000);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'download-page' || message.taskId !== taskId) return;
  if (message.type === 'download-started') {
    clearTimeout(readyTimer);
    void report('downloading').catch(() => {});
    setStatus('A guardar o ficheiro na pasta Transferências…');
  } else if (message.type === 'download-finished') {
    if (message.status === 'complete') {
      setStatus('Ficheiro entregue na pasta Transferências.');
      void finishTask();
    } else {
      void failTask(new Error('O Chrome interrompeu a gravação. Volta ao YouTube e tenta novamente.'));
    }
  }
});

cancelButton.addEventListener('click', async () => {
  cancelButton.disabled = true;
  controller?.abort(new DOMException('Download cancelado.', 'AbortError'));
  try {
    await chrome.runtime.sendMessage({ type: 'cancel-sabr-task', taskId });
  } finally {
    cancelButton.disabled = false;
  }
});

async function loadTask() {
  if (!/^[\w-]{36}$/.test(taskId ?? '')) {
    setStatus('Pedido de download inválido.');
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'consume-pending-download', taskId });
    if (!response?.task) throw new Error(response?.error || 'Não foi possível carregar o download.');
    task = response.task;
    title.textContent = `${task.title} · ${task.resolution}p`;
    cancelButton.hidden = true;
    if (task.mode === 'sabr') {
      setStatus('A preparar a transferência…');
      await pollSabrState();
    } else {
      setStatus('A preparar vídeo e áudio…');
      void mergeAndDeliver();
    }
  } catch (error) {
    await failTask(error);
  }
}

addEventListener('pagehide', () => {
  clearTimeout(pollTimer);
  clearTimeout(readyTimer);
  controller?.abort(new DOMException('Página fechada.', 'AbortError'));
});
void loadTask();
