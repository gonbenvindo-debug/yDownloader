import { createPlayerReader } from './player-reader.js';

const buttonId = 'yt-downloader-button';
const popupId = 'yt-downloader-popup';
let currentVideoId = '';
let button;
let popup;
let menu;
let status;
let icon;
let downloadIcon;
let spinnerIcon;
let downloading = false;
let activeDownloadId = null;
let activeTaskId = null;
let menuPlayerData = null;
let menuRequestGeneration = 0;
const readPlayerData = createPlayerReader();

function getVideoId() {
  const url = new URL(location.href);
  return url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1] ?? '';
}

function closePopup() {
  if (!popup) return;
  menuRequestGeneration++;
  popup.style.display = 'none';
  button?.setAttribute('aria-expanded', 'false');
}

function setStatus(message) {
  status.textContent = message;
  status.hidden = !message;
  resizePopup();
}

function setDownloading(value) {
  downloading = value;
  button.disabled = value;
  button.title = value ? 'A descarregar…' : 'Descarregar vídeo';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-busy', String(value));
  button.classList.toggle('yt-downloader-loading', value);
  icon.replaceChildren(value ? spinnerIcon : downloadIcon);
}

function showTaskResult(taskId, state, error) {
  if (activeTaskId !== taskId) return;
  activeTaskId = null;
  setDownloading(false);
  if (state === 'complete') {
    button.title = 'Download entregue na pasta Transferências';
    button.setAttribute('aria-label', button.title);
    setTimeout(() => {
      if (!downloading && button?.isConnected) {
        button.title = 'Descarregar vídeo';
        button.setAttribute('aria-label', button.title);
      }
    }, 5000);
    return;
  }
  if (currentVideoId !== getVideoId()) return;
  popup.style.display = 'block';
  button.setAttribute('aria-expanded', 'true');
  setStatus(error || 'A gravação foi interrompida. Volta a tentar esta resolução.');
}

async function monitorTask(taskId) {
  while (activeTaskId === taskId) {
    let result;
    try { result = await chrome.runtime.sendMessage({ type: 'download-task-state', taskId }); }
    catch {}
    if (result?.error) {
      showTaskResult(taskId, 'failed');
      return;
    }
    const state = result?.state;
    if (state?.status === 'complete' || state?.status === 'failed') {
      showTaskResult(taskId, state.status, state.error);
      return;
    }
    if (state?.status === 'muxing') {
      button.title = 'A unir vídeo e áudio…';
      button.setAttribute('aria-label', button.title);
    } else if (state?.status === 'downloading') {
      button.title = 'A guardar o ficheiro…';
      button.setAttribute('aria-label', button.title);
    } else {
      button.title = 'A transferir o vídeo…';
      button.setAttribute('aria-label', button.title);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.target === 'youtube-download' && message.type === 'download-task-finished')
    showTaskResult(message.taskId, message.status, message.error);
});

async function monitorDownload(downloadId) {
  while (activeDownloadId === downloadId) {
    let result;
    try { result = await chrome.runtime.sendMessage({ type: 'download-state', downloadId }); }
    catch {}
    if (result?.state === 'complete' || result?.state === 'interrupted') {
      activeDownloadId = null;
      setDownloading(false);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function resizePopup() {
  const panel = popup.querySelector('.ytp-panel');
  const height = Math.min(panel.scrollHeight, innerHeight * .5, 360);
  popup.style.height = `${height}px`;
  panel.style.height = popup.style.height;
}

function createPopup() {
  popup = document.createElement('div');
  popup.id = popupId;
  popup.className = 'ytp-popup ytp-settings-menu';
  popup.setAttribute('role', 'menu');
  popup.style.display = 'none';

  const content = document.createElement('div');
  content.className = 'ytp-popup-content';
  const panel = document.createElement('div');
  panel.className = 'ytp-panel';
  menu = document.createElement('div');
  menu.className = 'ytp-panel-menu';
  const title = document.createElement('div');
  title.className = 'ytp-menuitem';
  title.textContent = 'Descarregar vídeo';
  status = document.createElement('div');
  status.id = 'yt-downloader-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  panel.append(title, menu, status);
  content.append(panel);
  popup.append(content);
  return popup;
}

function createButton() {
  button = document.createElement('button');
  button.id = buttonId;
  button.className = 'ytp-button';
  button.type = 'button';
  button.title = 'Descarregar vídeo';
  button.setAttribute('aria-label', 'Descarregar vídeo');
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '24');
  icon.setAttribute('height', '24');
  icon.setAttribute('aria-hidden', 'true');
  downloadIcon = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  downloadIcon.setAttribute('d', 'M5 20h14v-2H5v2zm7-3 7-7h-4V3H9v7H5l7 7z');
  spinnerIcon = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  spinnerIcon.setAttribute('cx', '12');
  spinnerIcon.setAttribute('cy', '12');
  spinnerIcon.setAttribute('r', '9');
  spinnerIcon.setAttribute('fill', 'none');
  spinnerIcon.setAttribute('stroke', 'currentColor');
  spinnerIcon.setAttribute('stroke-width', '2.5');
  spinnerIcon.setAttribute('stroke-linecap', 'round');
  spinnerIcon.setAttribute('stroke-dasharray', '42 16');
  icon.append(downloadIcon);
  button.append(icon);
  button.addEventListener('click', () => void togglePopup());
  return button;
}

function addResolution(resolution) {
  const option = document.createElement('button');
  option.className = 'ytp-menuitem';
  option.type = 'button';
  option.setAttribute('role', 'menuitem');
  option.textContent = `${resolution.height}p`;
  option.addEventListener('click', async () => {
    if (option.disabled || downloading) return;
    const videoId = currentVideoId;
    const videoTitle = document.querySelector('meta[name="title"]')?.content
      || document.title.replace(/\s+-\s+YouTube\s*$/, '');
    closePopup();
    setDownloading(true);
    let result;
    try {
      const playerData = await readPlayerData(videoId).catch(() => null)
        ?? (menuPlayerData?.videoId === videoId ? menuPlayerData : null);
      if (videoId !== getVideoId()) { setDownloading(false); return; }
      result = await chrome.runtime.sendMessage({
        type: 'download', videoId, videoTitle, resolution: resolution.height, mode: resolution.mode,
        playerData,
      });
    }
    catch { result = { error: 'Não foi possível iniciar o download.' }; }
    if (result?.taskId) {
      activeTaskId = result.taskId;
      void monitorTask(result.taskId);
      return;
    }
    if (result?.error || !Number.isInteger(result?.downloadId)) {
      setDownloading(false);
      if (videoId !== currentVideoId) return;
      popup.style.display = 'block';
      button.setAttribute('aria-expanded', 'true');
      setStatus(result?.error ?? 'Não foi possível iniciar o download.');
      return;
    }
    activeDownloadId = result.downloadId;
    void monitorDownload(activeDownloadId);
  });
  menu.append(option);
}

async function togglePopup() {
  if (downloading) return;
  if (popup.style.display === 'block') {
    closePopup();
    return;
  }
  popup.style.display = 'block';
  button.setAttribute('aria-expanded', 'true');
  menu.replaceChildren();
  const requestGeneration = ++menuRequestGeneration;
  const videoId = currentVideoId;
  setStatus('A ler as resoluções do vídeo…');
  let result;
  try {
    const playerData = await readPlayerData(videoId);
    if (videoId !== getVideoId()) return;
    if (!playerData) throw new Error('O player ainda está a carregar. Deixa o vídeo reproduzir alguns segundos e tenta novamente.');
    menuPlayerData = playerData;
    result = await chrome.runtime.sendMessage({ type: 'get-resolutions', videoId, playerData });
  } catch (error) { result = { error: error.message || 'Não foi possível ler as resoluções do player.' }; }
  if (requestGeneration !== menuRequestGeneration || videoId !== getVideoId()
    || videoId !== currentVideoId || popup.style.display !== 'block') return;
  if (result?.error) {
    setStatus(result.error);
    return;
  }
  const resolutions = Array.isArray(result?.resolutions) ? result.resolutions : [];
  if (!resolutions.length) {
    setStatus('O player ainda está a carregar as resoluções. Deixa o vídeo reproduzir alguns segundos e abre o menu novamente.');
    return;
  }
  setStatus('');
  resolutions.forEach(addResolution);
  resizePopup();
}

function syncPlayer() {
  const videoId = getVideoId();
  if (videoId !== currentVideoId) {
    currentVideoId = videoId;
    menuPlayerData = null;
    closePopup();
  }
  if (!videoId) return;
  const player = document.querySelector('.html5-video-player');
  const controls = player?.querySelector('.ytp-right-controls-left');
  if (!player || !controls) return;
  if (!button) createButton();
  if (button.parentElement !== controls) controls.prepend(button);
  if (!popup) createPopup();
  if (popup.parentElement !== player) player.append(popup);
}

let syncQueued = false;
new MutationObserver(() => {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => { syncQueued = false; syncPlayer(); });
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('yt-navigate-finish', syncPlayer);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closePopup(); });
document.addEventListener('click', event => {
  if (popup?.style.display === 'block' && !popup.contains(event.target) && !button.contains(event.target)) closePopup();
});
syncPlayer();
