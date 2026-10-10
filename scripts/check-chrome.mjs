import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchTestChrome } from './launch-test-chrome.mjs';
import { ALL_FORMATS, FilePathSource, Input, EncodedPacketSink } from 'mediabunny';
import { inspectMedia } from '../src/media-merge.js';

const videoUrl = process.env.TEST_VIDEO_URL || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const resolution = Number(process.env.TEST_RESOLUTION || 2160);
const output = resolve(process.env.TEST_OUTPUT_DIR || '../../outputs/test-4k-auto');
const { context, close } = await launchTestChrome();
const startedAt = new Date().toISOString();
let page;
try {
  page = context.pages()[0] ?? await context.newPage();
  await mkdir(output, { recursive: true });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', {
    path: resolve('../../outputs/yDownloader'),
  });
  const downloadCdp = await context.browser().newBrowserCDPSession();
  await downloadCdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: output, eventsEnabled: true,
  });
  const worker = context.serviceWorkers().find(serviceWorker => serviceWorker.url().includes(id))
    ?? await context.waitForEvent('serviceworker', {
      predicate: serviceWorker => serviceWorker.url().includes(id), timeout: 15000,
    });
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.setDefaultTimeout(30000);
  await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const reject = page.getByText(/^(Rejeitar tudo|Recusar tudo|Reject all)$/).first();
  if (await reject.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false))
    await reject.click();
  await page.waitForSelector('#yt-downloader-button');
  await page.evaluate(() => {
    const player = document.querySelector('#movie_player');
    player.mute();
    player.playVideo();
  });
  const deadline = Date.now() + 60000;
  while (true) {
    const ready = await worker.evaluate(async () => Object.entries(await chrome.storage.session.get(null))
      .some(([key, value]) => key.startsWith('sabr-session:') && value.poToken)).catch(() => false);
    if (ready) break;
    if (Date.now() > deadline) throw new Error('The native player did not provide a SABR session.');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await page.evaluate(() => {
    const player = document.querySelector('#movie_player');
    player.mute();
    player.playVideo();
  });
  const activeTabBefore = await worker.evaluate(async () =>
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  const tabCountBefore = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
  assert.equal(context.pages().length, 1, 'Only the YouTube browser page should be open.');
  assert.equal(tabCountBefore, 1, 'Only the YouTube browser tab should exist before download.');
  await page.locator('#movie_player').hover();
  await page.locator('#yt-downloader-button').click();
  const option = page.getByRole('menuitem', { name: new RegExp(`^${resolution}p`) });
  await option.waitFor();
  const menu = await page.locator('#yt-downloader-popup').innerText();
  assert.doesNotMatch(menu, /\((?:MP4|WEBM)\)/i, 'Resolution names should show the resolution only.');
  await option.click();

  assert.match(page.url(), /youtube\.com\/watch\?/);
  const taskDeadline = Date.now() + 15 * 60 * 1000;
  let task;
  let lastLog = 0;
  while (true) {
    assert.equal(context.pages().length, 1, 'The extension opened another browser page.');
    const browserState = await worker.evaluate(async tabId => {
      const entries = await chrome.storage.session.get(null);
      const task = Object.entries(entries).map(([key, value]) => key.startsWith('pending:') ? value : null)
        .find(value => value?.tabId === tabId && value?.resolution > 0);
      const tabs = await chrome.tabs.query({});
      const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
      return { task, tabCount: tabs.length, activeTabId: active };
    }, activeTabBefore);
    assert.equal(browserState.tabCount, 1, 'The extension opened an additional Chrome tab.');
    assert.equal(browserState.activeTabId, activeTabBefore, 'The YouTube tab stopped being active.');
    task = browserState.task;
    if (task?.status === 'complete') break;
    if (task?.status === 'failed') throw new Error(task.error || 'The browser download failed.');
    if (Date.now() > taskDeadline) throw new Error('4K transfer exceeded 15 minutes.');
    if (Date.now() - lastLog > 30000) {
      const title = await page.locator('#yt-downloader-button').getAttribute('title');
      console.log(`${title || 'Preparing download'} ${task?.bytes ?? 0} bytes`);
      lastLog = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.match(page.url(), /youtube\.com\/watch\?/);
  assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({})).length), 1);
  await page.waitForFunction(
    () => document.querySelector('#yt-downloader-button')?.getAttribute('aria-busy') === 'false'
      && document.querySelector('#yt-downloader-button')?.title.includes('Download entregue'),
    undefined,
    { timeout: 120000 },
  );
  const [item] = await worker.evaluate(async id => chrome.downloads.search({ id }), task.downloadId);
  assert.equal(item?.state, 'complete', 'Chrome did not finish saving the delivered file.');
  const destination = item.filename;
  assert.ok(destination.startsWith(output), `Chrome saved outside the test directory: ${destination}`);
  assert.equal(destination.endsWith(resolution >= 720 ? '.webm' : '.mp4'), true);

  const input = new Input({ source: new FilePathSource(destination), formats: ALL_FORMATS });
  let metadata;
  const packetCounts = {};
  try {
    const media = await inspectMedia(input, input, {});
    assert.equal(media.height, resolution);
    const { video, audio, ...details } = media;
    metadata = details;
    for (const [name, track] of [['video', video], ['audio', audio]]) {
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
    finalStatus: 'Ficheiro entregue na pasta Transferências.',
    activeYouTubeTabId: activeTabBefore,
    youtubeUrlAfterDownload: page.url(),
    openBrowserTabsDuringDownload: 1,
    destination,
    size: (await stat(destination)).size,
    sha256: hash.digest('hex'),
    ...metadata,
    packetCounts,
  };
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await mkdir(output, { recursive: true });
  await page?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  const menu = await page?.locator('#yt-downloader-popup').textContent().catch(() => null);
  const nativePlayer = await page?.evaluate(() => ({
    time: document.querySelector('video')?.currentTime,
    paused: document.querySelector('video')?.paused,
    error: document.querySelector('.ytp-error')?.textContent,
  })).catch(() => null);
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({
    startedAt,
    failedAt: new Date().toISOString(),
    videoUrl,
    error: error.message,
    menu,
    nativePlayer,
    tabs: context.pages().length,
    status: await page?.locator('#yt-downloader-button').getAttribute('title').catch(() => null),
  }, null, 2));
  throw error;
} finally {
  await close();
}
