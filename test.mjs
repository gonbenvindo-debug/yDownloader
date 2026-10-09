import assert from 'node:assert/strict';
import { test } from 'node:test';

const base = 'http://127.0.0.1:3000';
const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

test('lista as resoluções reais e rejeita pedidos inválidos', async () => {
  const response = await fetch(`${base}/resolutions?url=${encodeURIComponent(url)}`);
  assert.equal(response.status, 200);
  const { resolutions } = await response.json();
  assert.ok(resolutions.includes(1080) && resolutions.includes(2160));
  assert.deepEqual(resolutions, [...new Set(resolutions)].sort((a, b) => a - b));

  for (const [path, options, status] of [
    ['/missing', {}, 404],
    ['/download', {}, 405],
    ['/resolutions', {}, 400],
    ['/resolutions?url=https://example.com', {}, 400],
    ['/download', { method: 'POST', body: '{}' }, 415],
    ['/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, 400],
    ['/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, resolution: '1080' }) }, 400],
    ['/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(8193) }, 413],
    ['/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, resolution: 123 }) }, 422],
  ]) {
    const result = await fetch(`${base}${path}`, options);
    assert.equal(result.status, status, path);
    assert.equal(typeof (await result.json()).error, 'string');
  }
});

test('inicia a transferência antes de preparar o vídeo', async () => {
  const response = await fetch(`${base}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Download-Stream': '1' },
    body: JSON.stringify({ url, resolution: 123 }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /aqz-KE-bpKQ-123p\.mp4/);
  await response.body.cancel();
});

test('inicia uma transferência MP4 em streaming', async () => {
  const response = await fetch(`${base}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Download-Stream': '1' },
    body: JSON.stringify({ url, resolution: 1080 }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-length'), null);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.ok(Buffer.from(value).includes(Buffer.from('ftyp')));
  await reader.cancel();
});
