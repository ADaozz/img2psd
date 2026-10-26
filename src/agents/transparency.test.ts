import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alphaSummary, chooseBackground, recoverAlpha, transparentImage } from './transparency.ts';
import { apiyiBackend, previewApiyi } from './apiyi.ts';

type RGB = [number, number, number];
const size = { width: 32, height: 48 };
// Known ground truth: opaque green/white details and 25%, 50%, 90%, 95% material.
async function scene(background?: RGB) {
  const raw = Buffer.alloc(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const i = (y * size.width + x) * 4;
    const inside = x >= 6 && x < 26 && y >= 6 && y < 42;
    const alpha = !inside ? 0 : [0.25, 0.5, 0.9, 0.95, 1, 1][Math.floor((y - 6) / 6)];
    const color: RGB = y >= 36 ? [0, 255, 0] : y >= 30 ? [255, 255, 255] : [200, 80, 120];
    for (let c = 0; c < 3; c++) raw[i + c] = Math.round(background ? alpha * color[c] + (1 - alpha) * background[c] : color[c]);
    raw[i + 3] = background ? 255 : Math.round(alpha * 255);
  }
  return sharp(raw, { raw: { ...size, channels: 4 } }).png().toBuffer();
}

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'l2d-transparency-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const rgba = (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
const payload = (bytes: Buffer) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }] } }],
}));

test('双背景恢复已知 Alpha 和 RGB，保留同背景色前景、白色和半透明材料', async () => {
  const recovered = await recoverAlpha(await scene([0, 255, 0]), await scene([255, 255, 255]));
  const actual = await rgba(recovered.png), expected = await rgba(await scene());
  for (let i = 0; i < actual.length; i += 4) {
    assert.ok(Math.abs(actual[i + 3] - expected[i + 3]) <= 2, `alpha at ${i}`);
    if (expected[i + 3]) for (let c = 0; c < 3; c++) assert.ok(Math.abs(actual[i + c] - expected[i + c]) <= 4, `RGB at ${i + c}`);
  }
  assert.equal(recovered.report.inconsistentPixels, 0);
  assert.equal((await sharp(recovered.alpha).metadata()).channels, 1);
});

test('背景选择避开主体绿色，不受透明 RGB 干扰', async () => {
  const raw = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i + 2] = 255; // hidden blue should not vote
    if (i >= 16 * 4 && i < 32 * 4) { raw[i + 1] = 255; raw[i + 2] = 0; raw[i + 3] = 255; }
  }
  const source = await sharp(raw, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
  assert.notEqual((await chooseBackground(source)).hex, '#00FF00');
});

test('拒绝近色背景、非均匀边缘、主体重绘和无主体输出', async () => {
  await assert.rejects(recoverAlpha(await scene([0, 255, 0]), await scene([0, 250, 0])), /距离不足/);
  const raw = await rgba(await scene([0, 255, 0]));
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    if (x && y && x !== size.width - 1 && y !== size.height - 1) continue;
    const i = (y * size.width + x) * 4;
    const color = (x + y) % 2 ? [255, 0, 0] : [0, 0, 255];
    for (let c = 0; c < 3; c++) raw[i + c] = color[c];
  }
  const noise = await sharp(raw, { raw: { ...size, channels: 4 } }).png().toBuffer();
  await assert.rejects(recoverAlpha(noise, await scene([255, 255, 255])), /60%/);
  const changed = await rgba(await scene([255, 255, 255]));
  for (let y = 12; y < 36; y++) for (let x = 6; x < 26; x++) {
    const i = (y * size.width + x) * 4;
    changed[i] = 0; changed[i + 1] = 0; changed[i + 2] = 255;
  }
  await assert.rejects(recoverAlpha(await scene([0, 255, 0]), await sharp(changed, { raw: { ...size, channels: 4 } }).png().toBuffer()), /主体不一致/);
  const flat = (rgb: RGB) => sharp({ create: { ...size, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();
  await assert.rejects(recoverAlpha(await flat([0, 255, 0]), await flat([255, 255, 255])), /主体不一致|可见主体/);
});

test('原生 Alpha 优先：只请求一次，保留原始字节并记录报告', async () => temporary(async dir => {
  const native = await scene();
  let calls = 0;
  const result = await transparentImage({ output: join(dir, 'out.png'), prompt: '角色', dual: true, source: native,
    request: async () => { calls++; return native; } });
  assert.equal(calls, 1);
  assert.equal(result.method, 'native');
  assert.deepEqual(result.png, native);
  assert.deepEqual(await readFile(join(result.artifactsDirectory, 'original-response.bin')), native);
  assert.equal(JSON.parse(await readFile(join(result.artifactsDirectory, 'report.json'), 'utf8')).method, 'native');
}));

test('Nano 透明 API：二次仅使用第一次原图，保存恢复产物；dry-run 不请求模型', async () => temporary(async dir => {
  const first = await scene([0, 255, 0]), second = await scene([255, 255, 255]);
  const ref = join(dir, 'ref.png');
  await writeFile(ref, await scene());
  const calls: any[] = [];
  const backend = apiyiBackend({ apiKey: 'not-in-artifacts', maxAttempts: 1,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return payload(calls.length === 1 ? first : second);
    } });
  const job = { prompt: '标准化角色，透明 PNG', model: 'gemini-nano-banana-2.1', background: 'transparent' as const,
    references: [{ path: ref }, { path: ref }], output: join(dir, 'out.png') };
  const preview = await previewApiyi(job);
  assert.equal((preview.transparency as any).maxGenerationPasses, 2);
  assert.equal(calls.length, 0);
  const result = await backend.imageGenerate!(job);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].contents[0].parts.length, 3);
  assert.equal(calls[1].contents[0].parts.length, 2);
  assert.equal(calls[1].contents[0].parts[1].inlineData.data, first.toString('base64'));
  assert.match(calls[1].contents[0].parts[0].text, /仅把所附图.*#FFFFFF/);
  assert.equal(calls[0].generationConfig.background, undefined);
  assert.equal(result.transparency?.method, 'dual-background');
  assert.ok((await alphaSummary(await readFile(job.output))).clear > 0);
  const artifacts = result.transparency!.artifactsDirectory;
  for (const name of ['original.png', 'counterpart.png', 'transparent.png', 'alpha.png', 'report.json']) {
    assert.ok((await readFile(join(artifacts, name))).length > 0);
  }
  assert.doesNotMatch(await readFile(join(artifacts, 'report.json'), 'utf8'), /not-in-artifacts/);
}));

test('GPT 不透明响应在补边前失败，保留诊断且不覆盖已有输出', async () => temporary(async dir => {
  const ref = join(dir, 'ref.png'), output = join(dir, 'out.png');
  await writeFile(ref, await scene());
  const original = Buffer.from('previous-deliverable');
  await writeFile(output, original);
  const opaque = await sharp(await scene([0, 255, 0])).resize(16, 24).png().toBuffer();
  let calls = 0;
  const backend = apiyiBackend({ apiKey: 'key', maxAttempts: 1, fetch: async (_url, init) => {
    calls++;
    const form = init!.body as FormData;
    assert.equal(form.get('background'), 'transparent');
    assert.equal(form.get('output_format'), 'png');
    return new Response(JSON.stringify({ data: [{ b64_json: opaque.toString('base64') }] }));
  } });
  await assert.rejects(backend.imageGenerate!({ prompt: '素体', model: 'gpt-image-2.5-sunburst', output,
    references: [{ path: ref }], background: 'transparent', strict: false }), /原生 Alpha/);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(output), original);
  const artifacts = (await readdir(dir)).find(name => name.startsWith('out.png.transparency-'))!;
  assert.deepEqual(await readFile(join(dir, artifacts, 'original-response.bin')), opaque);
  assert.match(await readFile(join(dir, artifacts, 'error.json'), 'utf8'), /原生 Alpha/);
}));

test('第二次失败保留第一张图；拒绝比例变化，接受同比例尺寸适配', async () => temporary(async dir => {
  const first = await scene([0, 255, 0]);
  const run = (second: () => Promise<Buffer>) => {
    let calls = 0;
    return transparentImage({ output: join(dir, 'out.png'), prompt: '角色', dual: true,
      request: async () => ++calls === 1 ? first : second() });
  };
  await assert.rejects(run(async () => { throw new Error('network failed'); }), /network failed/);
  await assert.rejects(run(() => sharp(first).resize(24, 24).png().toBuffer()), /比例变化/);
  const second = await sharp(await scene([255, 255, 255])).resize(64, 96, { kernel: 'nearest' }).png().toBuffer();
  const result = await run(async () => second);
  assert.equal(result.method, 'dual-background');
  const report = JSON.parse(await readFile(join(result.artifactsDirectory, 'report.json'), 'utf8'));
  assert.deepEqual(report.alignment.from, [64, 96]);
  const directories = (await readdir(dir)).filter(name => name.startsWith('out.png.transparency-'));
  assert.equal(directories.length, 3);
  for (const directory of directories) assert.deepEqual(await readFile(join(dir, directory, 'original-response.bin')), first);
}));
