import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchTestChrome } from './launch-test-chrome.mjs';
import { ALL_FORMATS, FilePathSource, Input, EncodedPacketSink } from 'mediabunny';
import { inspectMedia } from '../src/media-merge.js';
import {
  exportBrowserFile,
  installSaveDestination,
  verifyPlayback,
} from './browser-test-helpers.mjs';

const videoUrl = process.env.TEST_VIDEO_URL || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const resolution = Number(process.env.TEST_RESOLUTION || 2160);
const output = resolve(process.env.TEST_OUTPUT_DIR || '../../outputs/test-4k');
const { context, close } = await launchTestChrome();
const startedAt = new Date().toISOString();
let page;
let download;
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', {
    path: resolve('../../outputs/yDownloader'),
  });
  const worker =
    context.serviceWorkers().find((worker) => worker.url().includes(id)) ??
    (await context.waitForEvent('serviceworker', {
      predicate: (worker) => worker.url().includes(id),
      timeout: 15000,
    }));
  page = await context.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.setDefaultTimeout(30000);
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const reject = page.getByText(/^(Rejeitar tudo|Recusar tudo|Reject all)$/).first();
  if (
    await reject
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false)
  )
    await reject.click();
  await page.waitForSelector('#yt-downloader-button');
  await page.evaluate(() => {
    const player = document.querySelector('#movie_player');
    player.mute();
    player.playVideo();
  });
  const deadline = Date.now() + 60000;
  while (true) {
    const ready = await worker
      .evaluate(async () =>
        Object.entries(await chrome.storage.session.get(null)).some(
          ([key, value]) => key.startsWith('sabr-session:') && value.poToken,
        ),
      )
      .catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) throw new Error('The native player did not provide a SABR session.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await page.evaluate(() => {
    const player = document.querySelector('#movie_player');
    player.mute();
    player.playVideo();
  });
  await page.locator('#movie_player').hover();
  await page.locator('#yt-downloader-button').click();
  const option = page.getByRole('menuitem', { name: new RegExp(`^${resolution}p`) });
  await option.waitFor();
  const menu = await page.locator('#yt-downloader-popup').innerText();
  const opened = context.waitForEvent('page', { timeout: 30000 });
  await option.click();
  download = await opened;
  await download.waitForLoadState('domcontentloaded');
  const transferDeadline = Date.now() + 15 * 60 * 1000;
  let lastLog = 0;
  while (await download.locator('#save').isDisabled()) {
    const state = await download.evaluate(() =>
      chrome.runtime.sendMessage({
        type: 'sabr-task-state',
        taskId: new URLSearchParams(location.search).get('task'),
      }),
    );
    if (['failed', 'cancelled'].includes(state?.state?.status))
      throw new Error(state.state.error || state.state.status);
    if (Date.now() > transferDeadline) throw new Error('4K transfer exceeded 15 minutes.');
    if (Date.now() - lastLog > 30000) {
      console.log(await download.locator('#status').innerText());
      lastLog = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // Reload must preserve the completed task and the temporary media.
  await download.reload({ waitUntil: 'domcontentloaded' });
  await download.waitForFunction(() => !document.querySelector('#save').disabled);
  await installSaveDestination(download);
  await download.locator('#save').click();
  await download.waitForFunction(
    () => document.querySelector('#save').hidden || !document.querySelector('#save').disabled,
    undefined,
    { timeout: 5 * 60 * 1000 },
  );
  const finalStatus = await download.locator('#status').innerText();
  assert.match(finalStatus, /^Concluído e verificado:/);
  const playback = await verifyPlayback(download);
  assert.ok(
    playback.samples.every((sample) => sample.height === resolution && sample.readyState >= 2),
  );
  const filename = await download.evaluate(() =>
    window.testOutputHandle.name.replace(/^test-/, ''),
  );
  const destination = resolve(output, filename);
  const size = await exportBrowserFile(download, destination);
  const input = new Input({ source: new FilePathSource(destination), formats: ALL_FORMATS });
  let metadata;
  const packetCounts = {};
  try {
    const media = await inspectMedia(input, input, {
      height: resolution,
      durationSeconds: playback.duration,
    });
    const { video, audio, ...details } = media;
    metadata = details;
    for (const [name, track] of [
      ['video', video],
      ['audio', audio],
    ]) {
      let count = 0;
      for await (const packet of new EncodedPacketSink(track).packets()) {
        assert.ok(packet.data.length > 0);
        count++;
      }
      assert.ok(count > 0);
      packetCounts[name] = count;
    }
  } finally {
    input.dispose();
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(destination)) hash.update(chunk);
  const report = {
    startedAt,
    completedAt: new Date().toISOString(),
    browser: context.browser().version(),
    videoUrl,
    menu,
    finalStatus,
    destination,
    size,
    sha256: hash.digest('hex'),
    ...metadata,
    packetCounts,
    playback,
  };
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await mkdir(output, { recursive: true });
  await page?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  const menu = await page
    ?.locator('#yt-downloader-popup')
    .textContent()
    .catch(() => null);
  const nativePlayer = await page
    ?.evaluate(() => ({
      time: document.querySelector('video')?.currentTime,
      paused: document.querySelector('video')?.paused,
      error: document.querySelector('.ytp-error')?.textContent,
    }))
    .catch(() => null);
  await writeFile(
    resolve(output, 'failure.json'),
    JSON.stringify(
      {
        startedAt,
        failedAt: new Date().toISOString(),
        videoUrl,
        error: error.message,
        menu,
        nativePlayer,
        status: await download
          ?.locator('#status')
          .innerText()
          .catch(() => null),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await close();
}
