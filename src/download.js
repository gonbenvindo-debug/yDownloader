import {
  ALL_FORMATS,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  WebMOutputFormat,
} from 'mediabunny';

const taskId = new URLSearchParams(location.search).get('task');
const title = document.querySelector('#video-title');
const status = document.querySelector('#status');
const saveButton = document.querySelector('#save');
const cancelButton = document.querySelector('#cancel');
let task;
let activeInputs = [];
let activeWritable;
let cancelled = false;
let sabrPollTimer;
let sabrReady = false;

function setStatus(message) {
  status.textContent = message;
}

function ensureMediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com')) {
    throw new Error('O YouTube devolveu um stream inválido.');
  }
  return url.href;
}

function createInput(url) {
  return new Input({
    source: new UrlSource(ensureMediaUrl(url), { requestInit: { credentials: 'omit' } }),
    formats: ALL_FORMATS,
  });
}

async function createSabrInput(taskId, track) {
  const directory = await navigator.storage.getDirectory();
  const fileHandle = await directory.getFileHandle(`${taskId}-${track}.media`);
  return new Input({ source: new BlobSource(await fileHandle.getFile()), formats: ALL_FORMATS });
}

async function removeSabrFiles(id) {
  if (task?.mode !== 'sabr') return;
  const directory = await navigator.storage.getDirectory();
  await Promise.all(['video', 'audio'].map(track =>
    directory.removeEntry(`${id}-${track}.media`).catch(() => {})));
}

function formatBytes(value) {
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

async function pumpTrack(track, source, label, onPacket) {
  const decoderConfig = await track.getDecoderConfig();
  if (!decoderConfig) throw new Error(`Não foi possível ler a configuração do stream de ${label}.`);

  let firstPacket = true;
  let packetCount = 0;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    if (cancelled) throw new DOMException('Download cancelado.', 'AbortError');
    await source.add(packet, firstPacket ? { decoderConfig } : undefined);
    firstPacket = false;
    packetCount++;
    if (packetCount % 400 === 0) onPacket(packetCount);
  }
  if (firstPacket) throw new Error(`O stream de ${label} está vazio.`);
  source.close();
}

async function downloadMergedVideo() {
  if (!('showSaveFilePicker' in window)) {
    throw new Error('Este browser não suporta a escolha de ficheiros necessária para unir os streams.');
  }

  const fileHandle = await window.showSaveFilePicker({
    suggestedName: task.suggestedFilename,
    types: [{
      description: task.extension === 'webm' ? 'Vídeo WebM' : 'Vídeo MP4',
      accept: { [task.extension === 'webm' ? 'video/webm' : 'video/mp4']: [`.${task.extension}`] },
    }],
  });

  saveButton.disabled = true;
  cancelButton.hidden = false;
  cancelled = false;
  setStatus(task.mode === 'sabr' ? 'A preparar os segmentos guardados localmente…' : 'A abrir os streams do YouTube…');

  const writable = await fileHandle.createWritable();
  activeWritable = writable;
  const [videoInput, audioInput] = task.mode === 'sabr'
    ? await Promise.all([createSabrInput(task.taskId, 'video'), createSabrInput(task.taskId, 'audio')])
    : [createInput(task.videoUrl), createInput(task.audioUrl)];
  activeInputs = [videoInput, audioInput];

  try {
    const [videoTrack, audioTrack] = await Promise.all([
      videoInput.getPrimaryVideoTrack(),
      audioInput.getPrimaryAudioTrack(),
    ]);
    if (!videoTrack || !audioTrack) throw new Error('Não foi possível abrir os streams de vídeo e áudio.');

    const [videoCodec, audioCodec] = await Promise.all([videoTrack.getCodec(), audioTrack.getCodec()]);
    if (!videoCodec || !audioCodec) throw new Error('O codec deste vídeo não é compatível com o browser.');

    const outputFormat = task.extension === 'webm'
      ? new WebMOutputFormat()
      : new Mp4OutputFormat({ fastStart: 'fragmented' });
    if (!outputFormat.getSupportedCodecs().includes(videoCodec)
      || !outputFormat.getSupportedCodecs().includes(audioCodec)) {
      throw new Error('O browser não consegue unir estes codecs neste formato.');
    }

    const videoSource = new EncodedVideoPacketSource(videoCodec);
    const audioSource = new EncodedAudioPacketSource(audioCodec);
    const target = new StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 });
    const output = new Output({ format: outputFormat, target });
    output.addVideoTrack(videoSource, {
      width: await videoTrack.getDisplayWidth(),
      height: await videoTrack.getDisplayHeight(),
    });
    output.addAudioTrack(audioSource);

    let writtenBytes = 0;
    let lastStatusAt = 0;
    target.onwrite = (_start, end) => {
      writtenBytes = Math.max(writtenBytes, end);
      if (Date.now() - lastStatusAt > 500) {
        lastStatusAt = Date.now();
        setStatus(`A unir o vídeo e o áudio… ${formatBytes(writtenBytes)} escritos.`);
      }
    };

    await output.start();
    setStatus('A transferir e unir os streams…');
    await Promise.all([
      pumpTrack(videoTrack, videoSource, 'vídeo', () => setStatus('A processar o stream de vídeo…')),
      pumpTrack(audioTrack, audioSource, 'áudio', () => setStatus('A processar o stream de áudio…')),
    ]);
    await output.finalize();
    setStatus(`Concluído. Ficheiro guardado (${formatBytes(writtenBytes)}).`);
    saveButton.hidden = true;
    await removeSabrFiles(task.taskId);
  } catch (error) {
    await writable.abort(error).catch(() => {});
    throw error;
  } finally {
    videoInput.dispose();
    audioInput.dispose();
    activeInputs = [];
    activeWritable = null;
    cancelButton.hidden = true;
    saveButton.disabled = false;
  }
}

saveButton.addEventListener('click', async () => {
  try {
    await downloadMergedVideo();
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (cancelled) setStatus('Download cancelado.');
      return;
    }
    setStatus(error instanceof Error ? error.message : 'Falha ao unir os streams.');
  }
});

cancelButton.addEventListener('click', async () => {
  if (task?.mode === 'sabr' && !sabrReady && !activeWritable) {
    cancelButton.disabled = true;
    setStatus('A cancelar a transferência dos segmentos…');
    await chrome.runtime.sendMessage({ type: 'cancel-sabr-task', taskId: task.taskId }).catch(() => {});
    await pollSabrState();
    cancelButton.disabled = false;
    return;
  }
  cancelled = true;
  activeInputs.forEach(input => input.dispose());
  await activeWritable?.abort(new DOMException('Download cancelado.', 'AbortError')).catch(() => {});
  if (task?.mode === 'sabr') await removeSabrFiles(task.taskId);
  setStatus('A cancelar o download…');
});

async function loadTask() {
  if (!/^[\w-]{36}$/.test(taskId ?? '')) {
    setStatus('Pedido de download inválido.');
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({ type: 'consume-pending-download', taskId });
    if (!response?.task) throw new Error(response?.error || 'Não foi possível carregar o pedido de download.');
    task = response.task;
    title.textContent = `${task.title} · ${task.resolution}p`;
    if (task.mode === 'sabr') {
      saveButton.textContent = 'Escolher ficheiro e unir localmente';
      cancelButton.hidden = false;
      setStatus('A transferir segmentos da sessão do player…');
      await pollSabrState();
      sabrPollTimer = setInterval(() => void pollSabrState(), 1000);
    } else {
      setStatus('Pronto para transferir e unir os streams neste browser.');
      saveButton.disabled = false;
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Não foi possível carregar o pedido de download.');
  }
}

async function pollSabrState() {
  if (task?.mode !== 'sabr') return;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'sabr-task-state', taskId: task.taskId });
    const state = response?.state;
    if (!state) return;
    if (Number.isFinite(state.bytes)) setStatus(`A transferir e guardar segmentos localmente… ${formatBytes(state.bytes)}.`);
    if (state.status === 'complete') {
      sabrReady = true;
      clearInterval(sabrPollTimer);
      cancelButton.hidden = true;
      saveButton.disabled = false;
      setStatus(`Segmentos prontos (${formatBytes(state.bytes ?? 0)}). Escolhe onde guardar o vídeo unido.`);
    } else if (state.status === 'failed' || state.status === 'cancelled') {
      clearInterval(sabrPollTimer);
      cancelButton.hidden = true;
      saveButton.disabled = true;
      setStatus(state.status === 'cancelled' ? 'Transferência cancelada.' : state.error || 'Falha ao transferir segmentos SABR.');
    } else {
      saveButton.disabled = true;
    }
  } catch {
    setStatus('A aguardar pelo processo local de transferência…');
  }
}

void loadTask();
