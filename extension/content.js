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
let readingQuality = false;

function getVideoId() {
  const url = new URL(location.href);
  return url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([\w-]{11})(?:\/|$)/.exec(url.pathname)?.[1] ?? '';
}

function closePopup() {
  if (!popup) return;
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

function readResolutions() {
  const player = document.querySelector('.html5-video-player');
  const settings = player?.querySelector('.ytp-settings-button');
  const panel = player?.querySelector('.ytp-settings-menu[data-layer]');
  if (!settings || !panel) return [];
  const wasOpen = getComputedStyle(panel).display !== 'none';
  readingQuality = true;
  try {
    const read = () => [...new Set([...panel.querySelectorAll('[role="menuitemradio"]')]
      .map(item => Number(/(\d{3,4})p/i.exec(item.textContent)?.[1]))
      .filter(Boolean))].sort((a, b) => a - b);
    let resolutions = read();
    if (resolutions.length) {
      if (wasOpen) settings.click();
      return resolutions;
    }
    if (wasOpen) settings.click();
    settings.click();
    [...panel.querySelectorAll('.ytp-menuitem[aria-haspopup="true"]')]
      .find(item => /\d{3,4}p/i.test(item.querySelector('.ytp-menuitem-content')?.textContent ?? ''))?.click();
    resolutions = read();
    settings.click();
    return resolutions;
  } finally {
    readingQuality = false;
  }
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
  option.textContent = `${resolution}p`;
  option.addEventListener('click', async () => {
    if (option.disabled || downloading) return;
    const videoId = currentVideoId;
    const videoTitle = document.querySelector('meta[name="title"]')?.content
      || document.title.replace(/\s+-\s+YouTube\s*$/, '');
    closePopup();
    setDownloading(true);
    let result;
    try { result = await chrome.runtime.sendMessage({ type: 'download', videoId, videoTitle, resolution }); }
    catch { result = { error: 'Não foi possível iniciar o download.' }; }
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

function togglePopup() {
  if (downloading) return;
  if (popup.style.display === 'block') {
    closePopup();
    return;
  }
  popup.style.display = 'block';
  button.setAttribute('aria-expanded', 'true');
  menu.replaceChildren();
  const videoId = currentVideoId;
  let resolutions;
  try { resolutions = readResolutions(); }
  catch { resolutions = []; }
  if (videoId !== currentVideoId || popup.style.display !== 'block') return;
  if (!resolutions.length) {
    setStatus('Não foi possível ler as resoluções do player.');
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
  if (!readingQuality && popup?.style.display === 'block' && !popup.contains(event.target) && !button.contains(event.target)) closePopup();
});
syncPlayer();
