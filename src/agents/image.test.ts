import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const l2d = (args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'l2d-image-'));
}

async function localUpscale() {
  const directory = await tempDir();
  try {
    await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 120, b: 80, alpha: 1 } } })
      .png().toFile(join(directory, 'in.png'));
    await l2d(['upscale', '--in', join(directory, 'in.png'), '--out', join(directory, 'out.png'), '--scale', '2'],
      { L2D_UPSCALE_BACKEND: 'local' });
    const metadata = await sharp(join(directory, 'out.png')).metadata();
    assert.equal(metadata.width, 16);
    assert.equal(metadata.height, 16);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取端口');
  return `http://127.0.0.1:${address.port}/v1`;
}

test('local 后端放大：尺寸按倍数变化，输出仍是 PNG', localUpscale);

test('api 后端：无参考图走 generations，有参考图走 edits multipart', async () => {
  const raw = Buffer.alloc(4 * 4 * 4, 255);
  raw[3] = 0;
  const pixel = await sharp(raw, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
  const calls: { url?: string; type?: string; body?: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      calls.push({ url: request.url, type: String(request.headers['content-type']), body });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ b64_json: pixel.toString('base64') }] }));
    });
  });
  const base = await listen(server);
  const directory = await tempDir();
  try {
    await sharp(pixel).toFile(join(directory, 'ref.png'));
    const env = { L2D_IMAGE_BACKEND: 'api', L2D_IMAGE_BASE_URL: base, L2D_IMAGE_API_KEY: 'test-key', L2D_IMAGE_MODEL: 'mock-model' };

    await l2d(['imagegen', '--prompt', '画一只猫', '--out', join(directory, 'gen.png'), '--background', 'transparent'], env);
    assert.equal(calls[0].url, '/v1/images/generations');
    assert.match(calls[0].type ?? '', /application\/json/);
    assert.match(calls[0].body ?? '', /mock-model/);
    assert.equal(JSON.parse(calls[0].body!).background, 'transparent');
    assert.equal(JSON.parse(calls[0].body!).output_format, 'png');
    assert.equal((await readFile(join(directory, 'gen.png'))).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

    await l2d(['imagegen', '--prompt', '换装', '--ref', join(directory, 'ref.png'), '--out', join(directory, 'edit.png'), '--background', 'transparent'], env);
    const edit = calls[1];
    assert.equal(edit.url, '/v1/images/edits');
    assert.match(edit.type ?? '', /multipart\/form-data/);
    assert.match(edit.body ?? '', /name="image\[\]"/);
    assert.match(edit.body ?? '', /换装/);
    assert.match(edit.body ?? '', /name="background"\r\n\r\ntransparent/);
    assert.match(edit.body ?? '', /name="output_format"\r\n\r\npng/);
    assert.deepEqual(await readFile(join(directory, 'edit.png')), pixel);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('codex 后端不可用时报错并提示替代后端', async () => {
  const directory = await tempDir();
  try {
    await assert.rejects(
      l2d(['imagegen', '--prompt', 'x', '--out', join(directory, 'x.png')],
        { L2D_IMAGE_BACKEND: 'codex', L2D_CODEX_PATH: '/nonexistent/codex' }),
      (error: { stderr?: string }) => /调用 Codex 失败/.test(error.stderr ?? '') && /L2D_IMAGE_BACKEND=api/.test(error.stderr ?? ''),
    );
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local 后端不支持生图时给出明确提示', async () => {
  const directory = await tempDir();
  try {
    await assert.rejects(
      l2d(['imagegen', '--prompt', 'x', '--out', join(directory, 'x.png')], { L2D_IMAGE_BACKEND: 'local' }),
      (error: { stderr?: string }) => /local 后端不支持生图/.test(error.stderr ?? ''),
    );
  } finally { await rm(directory, { recursive: true, force: true }); }
});
