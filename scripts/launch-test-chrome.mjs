import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { chromium } from 'playwright';

export async function launchTestChrome() {
  const profile = await mkdtemp(join(tmpdir(), 'ydownloader-chrome-'));
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const executable =
    process.env.CHROME_PATH ||
    (process.platform === 'win32'
      ? join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe')
      : process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : '/usr/bin/google-chrome');
  // A dedicated profile and explicit CDP port keep the native player's normal
  // browser environment. The debug-pipe automation environment was rejected by
  // YouTube even during ordinary playback, before any extension download.
  const processHandle = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-extension-debugging',
      '--start-minimized',
      '--window-position=-32000,-32000',
      ...(process.env.CHROME_HEADLESS === 'true' ? ['--headless=new'] : []),
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  let launchError;
  processHandle.on('error', (error) => {
    launchError = error;
  });
  let browser;
  const close = async () => {
    if (browser?.isConnected()) {
      const cdp = await browser.newBrowserCDPSession().catch(() => null);
      await cdp?.send('Browser.close').catch(() => {});
      await browser.close().catch(() => {});
    }
    if (processHandle.exitCode === null) processHandle.kill();
    // Delete only the temporary profile created by this invocation.
    if (
      dirname(resolve(profile)) === resolve(tmpdir()) &&
      basename(profile).startsWith('ydownloader-chrome-')
    ) {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(
        () => {},
      );
    }
  };
  try {
    const deadline = Date.now() + 30000;
    while (!browser) {
      if (launchError) throw launchError;
      if (processHandle.exitCode !== null)
        throw new Error(`Chrome exited: ${processHandle.exitCode}`);
      browser = await chromium
        .connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 })
        .catch(() => null);
      if (Date.now() > deadline) throw new Error('Chrome did not expose the test debugging port.');
      if (!browser) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { context: browser.contexts()[0], close };
  } catch (error) {
    await close();
    throw error;
  }
}
