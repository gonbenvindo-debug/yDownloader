import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Headless Chrome has no native save dialog. Only replace the destination picker;
// the extension still downloads, validates and muxes the real media itself.
export async function installSaveDestination(page) {
  await page.evaluate(() => {
    window.showSaveFilePicker = async ({ suggestedName }) => {
      const root = await navigator.storage.getDirectory();
      window.testOutputHandle = await root.getFileHandle(`test-${suggestedName}`, { create: true });
      return window.testOutputHandle;
    };
  });
}

export async function exportBrowserFile(page, destination) {
  const size = await page.evaluate(async () => {
    window.testOutputFile = await window.testOutputHandle.getFile();
    return window.testOutputFile.size;
  });
  await mkdir(dirname(destination), { recursive: true });
  const file = await open(destination, 'w');
  try {
    for (let offset = 0; offset < size; offset += 1024 * 1024) {
      const base64 = await page.evaluate(async (offset) => {
        const bytes = new Uint8Array(
          await window.testOutputFile.slice(offset, offset + 1024 * 1024).arrayBuffer(),
        );
        let binary = '';
        for (let index = 0; index < bytes.length; index += 32768) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
        }
        return btoa(binary);
      }, offset);
      await file.write(Buffer.from(base64, 'base64'));
    }
  } finally {
    await file.close();
  }
  return size;
}

export async function verifyPlayback(page) {
  return page.evaluate(async () => {
    const file = await window.testOutputHandle.getFile();
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    video.style.width = '320px';
    document.body.append(video);
    const event = (name) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Playback timed out: ${name}`));
        }, 30000);
        const done = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new Error(`Playback error: ${video.error?.message}`));
        };
        function cleanup() {
          clearTimeout(timer);
          video.removeEventListener(name, done);
          video.removeEventListener('error', failed);
        }
        video.addEventListener(name, done, { once: true });
        video.addEventListener('error', failed, { once: true });
      });
    try {
      await event('loadeddata');
      const samples = [];
      for (const time of [2, video.duration / 2, video.duration - 3]) {
        const sought = event('seeked');
        video.currentTime = time;
        await sought;
        samples.push({
          time: video.currentTime,
          width: video.videoWidth,
          height: video.videoHeight,
          readyState: video.readyState,
        });
      }
      return { duration: video.duration, samples };
    } finally {
      video.removeAttribute('src');
      video.load();
      video.remove();
      URL.revokeObjectURL(url);
    }
  });
}
