import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ytdlp = process.env.YTDLP_PATH || join(import.meta.dirname, 'tools', 'yt-dlp.exe');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const firstChunkSize = 1024 * 1024;
const chunkSize = 8 * 1024 * 1024;
const concurrentRanges = 8;
await execute(ytdlp, ['--version'], { windowsHide: true });
await execute(ffmpeg, ['-version'], { windowsHide: true });

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function videoId(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'URL inválido.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) {
    fail(400, 'Usa um URL de um vídeo do YouTube.');
  }
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1];
  if (!/^[\w-]{11}$/.test(id ?? '')) fail(400, 'ID de vídeo inválido.');
  return id;
}

async function fetchRange(format, start, end, size, signal) {
  const headers = new Headers(format.http_headers ?? {});
  headers.set('Accept', '*/*');
  headers.set('Accept-Encoding', 'identity');
  headers.set('Range', `bytes=${start}-${end}`);
  for (let attempt = 0; ; attempt++) {
    let result;
    try { result = await fetch(format.url, { headers, signal }); }
    catch (error) {
      if (signal.aborted || attempt === 2) throw error;
    }
    if (result) {
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(result.headers.get('content-range') ?? '');
      if (result.status !== 206 || !contentRange || Number(contentRange[1]) !== start || Number(contentRange[2]) !== end || Number(contentRange[3]) !== size) {
        if (result.body) await result.body.cancel().catch(() => {});
        if (![403, 429, 500, 502, 503, 504].includes(result.status) || attempt === 2) throw new Error(`O YouTube não aceitou o intervalo ${start}-${end} (HTTP ${result.status}).`);
      } else {
        try {
          const bytes = Buffer.from(await result.arrayBuffer());
          if (bytes.length === end - start + 1) return bytes;
          if (attempt === 2) throw new Error(`O intervalo ${start}-${end} veio incompleto.`);
        } catch (error) {
          if (signal.aborted || attempt === 2) throw error;
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
}

async function pipeRanges({ format, size, first }, output, signal) {
  const ranges = Array.from({ length: Math.ceil((size - firstChunkSize) / chunkSize) }, (_, index) => {
    const start = firstChunkSize + index * chunkSize;
    return { start, end: Math.min(size - 1, start + chunkSize - 1) };
  });
  const pending = new Map();
  const requests = new Map();
  output.on('error', () => {});
  const fetchChunk = index => {
    const { start, end } = ranges[index];
    const request = fetchRange(format, start, end, size, signal).then(bytes => pending.set(index, bytes));
    request.catch(() => {});
    requests.set(index, request);
  };
  const write = async bytes => { if (!output.write(bytes)) await once(output, 'drain', { signal }); };
  for (let index = 0; index < Math.min(concurrentRanges, ranges.length); index++) fetchChunk(index);
  await write(first);
  for (let index = 0; index < ranges.length; index++) {
    await requests.get(index);
    await write(pending.get(index));
    pending.delete(index);
    const next = index + concurrentRanges;
    if (next < ranges.length) fetchChunk(next);
  }
  output.end();
}

createServer(async (request, response) => {
  const controller = new AbortController();
  response.on('close', () => { if (!response.writableFinished) controller.abort(); });
  try {
    const route = new URL(request.url, 'http://127.0.0.1');
    const method = route.pathname === '/resolutions' ? 'GET' : route.pathname === '/download' ? 'POST' : null;
    if (!method) fail(404, 'Endpoint não encontrado.');
    if (request.method !== method) {
      response.setHeader('Allow', method);
      fail(405, 'Método não permitido.');
    }

    let input = { url: route.searchParams.get('url') };
    if (method === 'POST') {
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') fail(415, 'Envia application/json.');
      const chunks = [];
      let size = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 8192) {
          request.resume();
          fail(413, 'Pedido demasiado grande.');
        }
        chunks.push(chunk);
      }
      try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'JSON inválido.'); }
    }
    if (!input || typeof input.url !== 'string') fail(400, 'O campo url é obrigatório.');
    const id = videoId(input.url);
    if (method === 'POST' && (!Number.isInteger(input.resolution) || input.resolution < 1)) fail(400, 'resolution deve ser um número inteiro, por exemplo 1080.');
    const streamDownload = method === 'POST' && request.headers['x-download-stream'] === '1';
    if (streamDownload) {
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${id}-${input.resolution}p.mp4"`,
        'Cache-Control': 'no-store',
      });
      response.flushHeaders();
    }

    const args = ['--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist', '--js-runtimes', 'node'];
    if (method === 'POST') args.push('--format', `bv[height=${input.resolution}]+ba/b[height=${input.resolution}]`);
    args.push(input.url);
    let stdout;
    try {
      ({ stdout } = await execute(ytdlp, args, { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal: controller.signal }));
    } catch (error) {
      if (method === 'POST' && /requested format is not available/i.test(error.stderr ?? '')) fail(422, 'Resolução indisponível neste vídeo.');
      throw error;
    }
    controller.signal.throwIfAborted();
    const video = JSON.parse(stdout);
    const resolutions = [...new Set(video.formats.filter(format => format.vcodec !== 'none' && format.height && !format.has_drm).map(format => format.height))].sort((a, b) => a - b);
    if (!resolutions.length) fail(422, 'Este vídeo não tem streams disponíveis para download.');
    if (method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ resolutions }));
      return;
    }
    const formats = video.requested_formats ?? [video];
    if (!formats.length || formats.some(format => typeof format.url !== 'string')) fail(502, 'O YouTube não devolveu os streams do vídeo.');
    let rangeInputs;
    if (formats.every(format => Number.isSafeInteger(Number(format.filesize)) && Number(format.filesize) > 0)) {
      try {
        rangeInputs = await Promise.all(formats.map(async format => {
          const size = Number(format.filesize);
          const end = Math.min(size - 1, firstChunkSize - 1);
          return { format, size, first: await fetchRange(format, 0, end, size, controller.signal) };
        }));
      } catch (error) {
        controller.signal.throwIfAborted();
        console.warn(`Download por intervalos indisponível; a usar o fluxo direto: ${error.message}`);
      }
    }
    if (!streamDownload) {
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${id}-${input.resolution}p.mp4"`,
        'Cache-Control': 'no-store',
      });
      response.flushHeaders();
    }
    const ffmpegArgs = ['-hide_banner', '-loglevel', 'error'];
    if (rangeInputs) {
      for (let index = 0; index < rangeInputs.length; index++) ffmpegArgs.push('-i', `pipe:${3 + index}`);
    } else {
      for (const format of formats) {
        const headers = Object.entries(format.http_headers ?? {}).map(([name, value]) => `${name}: ${String(value).replace(/[\r\n]/g, '')}\r\n`).join('');
        if (headers) ffmpegArgs.push('-headers', headers);
        ffmpegArgs.push('-i', format.url);
      }
    }
    ffmpegArgs.push('-map', '0:v:0');
    ffmpegArgs.push('-map', formats.length > 1 ? '1:a:0' : '0:a:0?');
    ffmpegArgs.push('-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ffmpegArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...(rangeInputs ? formats.map(() => 'pipe') : [])] });
      let stderr = '';
      let rangeError;
      const abort = () => child.kill();
      controller.signal.addEventListener('abort', abort, { once: true });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.stdout.pipe(response, { end: false });
      if (rangeInputs) {
        Promise.all(rangeInputs.map((input, index) => pipeRanges(input, child.stdio[3 + index], controller.signal))).catch(error => {
          rangeError = error;
          if (!controller.signal.aborted) controller.abort();
        });
      }
      child.once('error', error => {
        controller.signal.removeEventListener('abort', abort);
        controller.abort();
        if (!response.destroyed) response.destroy(error);
        reject(error);
      });
      child.once('close', code => {
        controller.signal.removeEventListener('abort', abort);
        if (code === 0) {
          response.end();
          resolve();
        } else {
          if (!controller.signal.aborted) controller.abort();
          const error = rangeError || new Error(stderr.trim() || `FFmpeg terminou com código ${code}.`);
          if (!response.destroyed) response.destroy(error);
          reject(error);
        }
      });
    });
  } catch (error) {
    controller.abort();
    console.error(error.message);
    if (response.headersSent) response.destroy(error);
    else if (!response.destroyed) {
      response.writeHead(error.status || 502, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.status ? error.message : 'Falha no download. Consulta o terminal do servidor.' }));
    }
  }
}).listen(3000, '127.0.0.1', () => console.log('http://127.0.0.1:3000'));
