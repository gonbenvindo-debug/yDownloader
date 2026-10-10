import { ALL_FORMATS, BlobSource, Input, UrlSource } from 'mediabunny';
import { inspectMedia, mergeMedia } from './media-merge.js';

const taskId = new URLSearchParams(location.search).get('task');
const title = document.querySelector('#video-title');
const status = document.querySelector('#status');
const saveButton = document.querySelector('#save');
const cancelButton = document.querySelector('#cancel');
let task;
let controller;
let pollTimer;
let sabrReady = false;
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
async function removeSabrFiles() {
  if (task?.mode !== 'sabr') return;
  const directory = await navigator.storage.getDirectory();
  await Promise.all(
    ['video', 'audio'].map((track) =>
      directory.removeEntry(`${task.taskId}-${track}.media`).catch(() => {}),
    ),
  );
}

saveButton.addEventListener('click', async () => {
  if (busy || !task) return;
  busy = true;
  saveButton.disabled = true;
  let writable;
  const inputs = [];
  controller = new AbortController();
  try {
    if (!window.showSaveFilePicker)
      throw new Error(
        'Este browser não permite escolher o ficheiro de destino. Usa uma versão recente do Chrome.',
      );
    const handle = await window.showSaveFilePicker({
      suggestedName: task.suggestedFilename,
      types: [
        {
          description: task.extension === 'webm' ? 'Vídeo WebM' : 'Vídeo MP4',
          accept: {
            [task.extension === 'webm' ? 'video/webm' : 'video/mp4']: [`.${task.extension}`],
          },
        },
      ],
    });
    saveButton.disabled = true;
    cancelButton.hidden = false;
    setStatus('A verificar os streams e a guardar o vídeo…');
    writable = await handle.createWritable();
    // Open sequentially so a failed second input cannot leak the first handle.
    inputs.push(task.mode === 'sabr' ? await createSabrInput('video') : createInput(task.videoUrl));
    inputs.push(task.mode === 'sabr' ? await createSabrInput('audio') : createInput(task.audioUrl));
    let lastReport = 0;
    const expected = {
      width: task.width,
      height: task.height,
      durationSeconds: task.durationSeconds,
    };
    await mergeMedia({
      videoInput: inputs[0],
      audioInput: inputs[1],
      writable,
      extension: task.extension,
      expected,
      signal: controller.signal,
      onProgress(bytes) {
        if (Date.now() - lastReport > 500) {
          lastReport = Date.now();
          setStatus(`A guardar o vídeo… ${formatBytes(bytes)}.`);
        }
      },
    });
    writable = null;
    const file = await handle.getFile();
    const verification = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    let media;
    try {
      media = await inspectMedia(verification, verification, expected);
    } finally {
      verification.dispose();
    }
    await removeSabrFiles();
    await chrome.runtime.sendMessage({ type: 'finish-download-task', taskId }).catch(() => {});
    setStatus(
      `Concluído e verificado: ${media.width}×${media.height}, vídeo e áudio, ${formatBytes(file.size)}.`,
    );
    saveButton.hidden = true;
  } catch (error) {
    await writable?.abort(error).catch(() => {});
    if (error?.name === 'AbortError')
      setStatus('Download cancelado. Podes voltar a guardar o vídeo.');
    else setStatus(error instanceof Error ? error.message : 'Falha ao guardar o vídeo.');
  } finally {
    inputs.forEach((input) => input.dispose());
    controller = null;
    busy = false;
    cancelButton.hidden = true;
    cancelButton.disabled = false;
    saveButton.disabled = false;
  }
});

cancelButton.addEventListener('click', async () => {
  cancelButton.disabled = true;
  if (controller) {
    controller.abort(new DOMException('Download cancelado.', 'AbortError'));
    return;
  }
  clearTimeout(pollTimer);
  setStatus('A cancelar a transferência…');
  try {
    await chrome.runtime.sendMessage({ type: 'cancel-sabr-task', taskId });
  } catch (error) {
    setStatus(error.message || 'Não foi possível cancelar a transferência.');
  } finally {
    cancelButton.disabled = false;
    await pollSabrState();
  }
});

async function pollSabrState() {
  if (task?.mode !== 'sabr' || sabrReady) return;
  let terminal = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'sabr-task-state', taskId });
    const state = response?.state;
    if (!state)
      throw new Error(
        'A tarefa de download já não está disponível. Volta ao vídeo e tenta novamente.',
      );
    if (state.status === 'complete') {
      terminal = true;
      sabrReady = true;
      cancelButton.hidden = true;
      saveButton.disabled = false;
      setStatus(
        `Transferência recebida (${formatBytes(state.bytes ?? 0)}). Escolhe onde guardar o vídeo.`,
      );
    } else if (['failed', 'cancelled'].includes(state.status)) {
      terminal = true;
      cancelButton.hidden = true;
      saveButton.disabled = true;
      setStatus(
        state.status === 'cancelled'
          ? 'Transferência cancelada.'
          : state.error || 'Falha ao transferir o vídeo.',
      );
    } else setStatus(`A transferir o vídeo… ${formatBytes(state.bytes ?? 0)}.`);
  } catch (error) {
    terminal = true;
    cancelButton.hidden = true;
    setStatus(error.message || 'Não foi possível consultar a transferência.');
  }
  if (!terminal) pollTimer = setTimeout(() => void pollSabrState(), 1000);
}

async function loadTask() {
  if (!/^[\w-]{36}$/.test(taskId ?? '')) {
    setStatus('Pedido de download inválido.');
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'consume-pending-download', taskId });
    if (!response?.task)
      throw new Error(response?.error || 'Não foi possível carregar o download.');
    task = response.task;
    title.textContent = `${task.title} · ${task.resolution}p`;
    if (task.mode === 'sabr') {
      cancelButton.hidden = false;
      await pollSabrState();
    } else {
      setStatus('Escolhe onde guardar o vídeo.');
      saveButton.disabled = false;
    }
  } catch (error) {
    setStatus(error.message || 'Não foi possível carregar o download.');
  }
}
addEventListener('pagehide', () => {
  clearTimeout(pollTimer);
  controller?.abort(new DOMException('Página fechada.', 'AbortError'));
});
void loadTask();
