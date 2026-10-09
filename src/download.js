import {
  ALL_FORMATS,
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
  setStatus('A abrir os streams do YouTube…');

  const writable = await fileHandle.createWritable();
  activeWritable = writable;
  const videoInput = createInput(task.videoUrl);
  const audioInput = createInput(task.audioUrl);
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
  cancelled = true;
  activeInputs.forEach(input => input.dispose());
  await activeWritable?.abort(new DOMException('Download cancelado.', 'AbortError')).catch(() => {});
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
    setStatus('Pronto para transferir e unir os streams neste browser.');
    saveButton.disabled = false;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Não foi possível carregar o pedido de download.');
  }
}

void loadTask();
