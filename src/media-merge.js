import {
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
} from 'mediabunny';

export function checkDuration(actual, expected, label) {
  if (!Number.isFinite(actual) || !(actual > 0))
    throw new Error(`O stream de ${label} está vazio ou tem uma duração inválida.`);
  if (expected > 0 && actual < expected - Math.max(2, expected * 0.005)) {
    throw new Error(
      `O stream de ${label} está incompleto (${actual.toFixed(1)} de ${expected.toFixed(1)} segundos).`,
    );
  }
}

export async function inspectMedia(videoInput, audioInput, expected = {}) {
  const [video, audio] = await Promise.all([
    videoInput.getPrimaryVideoTrack(),
    audioInput.getPrimaryAudioTrack(),
  ]);
  if (!video || !audio)
    throw new Error('O ficheiro não contém os streams de vídeo e áudio necessários.');
  const [width, height, videoDuration, audioDuration, videoCodec, audioCodec] = await Promise.all([
    video.getDisplayWidth(),
    video.getDisplayHeight(),
    video.computeDuration(),
    audio.computeDuration(),
    video.getCodec(),
    audio.getCodec(),
  ]);
  checkDuration(videoDuration, expected.durationSeconds, 'vídeo');
  checkDuration(audioDuration, expected.durationSeconds, 'áudio');
  if (
    (expected.width && width !== expected.width) ||
    (expected.height && height !== expected.height)
  ) {
    throw new Error(
      `O vídeo recebido tem ${width}×${height}; não corresponde à resolução escolhida.`,
    );
  }
  return { video, audio, width, height, videoDuration, audioDuration, videoCodec, audioCodec };
}

// Keep the file writer outside StreamTarget's lock so cancellation can abort
// the atomic write, including failures while opening or validating inputs.
export async function mergeMedia({
  videoInput,
  audioInput,
  writable,
  extension,
  expected,
  signal,
  onProgress = () => {},
}) {
  let output;
  let aborted = false;
  let packets = [];
  const abort = () => {
    aborted = true;
    videoInput.dispose();
    audioInput.dispose();
    void writable.abort(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const media = await inspectMedia(videoInput, audioInput, expected);
    signal?.throwIfAborted();
    const format =
      extension === 'webm'
        ? new WebMOutputFormat()
        : new Mp4OutputFormat({ fastStart: 'fragmented' });
    if (
      !format.getSupportedCodecs().includes(media.videoCodec) ||
      !format.getSupportedCodecs().includes(media.audioCodec)
    ) {
      throw new Error('Os codecs recebidos não são compatíveis com o formato de destino.');
    }
    const target = new StreamTarget(
      new WritableStream({
        write: (chunk) => writable.write(chunk),
        close: () => (aborted ? undefined : writable.close()),
        abort: (reason) => writable.abort(reason),
      }),
      { chunked: true, chunkSize: 4 * 1024 * 1024 },
    );
    let bytes = 0;
    target.onwrite = (_start, end) => {
      bytes = Math.max(bytes, end);
      onProgress(bytes);
    };
    output = new Output({ format, target });
    const videoSource = new EncodedVideoPacketSource(media.videoCodec);
    const audioSource = new EncodedAudioPacketSource(media.audioCodec);
    output.addVideoTrack(videoSource);
    output.addAudioTrack(audioSource);
    await output.start();
    const pump = async (track, source, label) => {
      const decoderConfig = await track.getDecoderConfig();
      if (!decoderConfig) throw new Error(`Não foi possível ler a configuração do ${label}.`);
      let count = 0;
      let end = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        signal?.throwIfAborted();
        if (aborted) throw new DOMException('Download cancelado.', 'AbortError');
        await source.add(packet, count ? undefined : { decoderConfig });
        count++;
        end = Math.max(end, packet.timestamp + packet.duration);
      }
      checkDuration(end, expected?.durationSeconds, label);
      source.close();
      return count;
    };
    packets = [pump(media.video, videoSource, 'vídeo'), pump(media.audio, audioSource, 'áudio')];
    const [videoPackets, audioPackets] = await Promise.all(packets);
    signal?.throwIfAborted();
    await output.finalize();
    return {
      width: media.width,
      height: media.height,
      videoDuration: media.videoDuration,
      audioDuration: media.audioDuration,
      videoCodec: media.videoCodec,
      audioCodec: media.audioCodec,
      videoPackets,
      audioPackets,
      bytes,
    };
  } catch (error) {
    aborted = true;
    await writable.abort(error).catch(() => {});
    videoInput.dispose();
    audioInput.dispose();
    await output?.cancel().catch(() => {});
    await Promise.allSettled(packets);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    videoInput.dispose();
    audioInput.dispose();
  }
}
