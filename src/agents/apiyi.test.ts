import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { selectBackend, resolveBackendName } from './image.ts';
import {
  ImageEditError, editImage, gptSizeIssue, nearestGptSize, type ImageAsset, type ImageEditRequest,
} from './apiyi.ts';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const l2d = (args: string[], env: Record<string, string> = {}) =>
  run(process.execPath, [cli, ...args], { env: { ...process.env, L2D_NO_DOTENV: '1', ...env } });

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'l2d-apiyi-'));
}

function png(width: number, height: number, color = { r: 220, g: 10, b: 10, alpha: 1 }) {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

function asset(bytes: Buffer, width: number, height: number, filename = 'source.png'): ImageAsset {
  return { bytes, mimeType: 'image/png', width, height, filename };
}

function request(partial: Partial<ImageEditRequest> & Pick<ImageEditRequest, 'model' | 'source'>): ImageEditRequest {
  return {
    prompt: '把图1标准化',
    canvas: { mode: 'original', strict: true },
    outputMimeType: 'image/png',
    ...partial,
  };
}

function geminiPayload(bytes: Buffer) {
  return {
    candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }] } }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22 },
  };
}

test('API易模型选择后端，已移除的 Qwen 模型明确报错', () => {
  const env = { APIYI_API_KEY: 'yi', L2D_IMAGE_BACKEND: 'api', L2D_IMAGE_BASE_URL: 'http://localhost', L2D_IMAGE_API_KEY: 'test' };
  for (const model of ['qwenimage3', 'Qwen-Image-3', 'qwen-image-3.0-pro']) {
    assert.throws(() => selectBackend('imagegen', env, model), /已移除/);
  }
  for (const model of ['gemini-nano-banana-2.1', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare']) {
    assert.equal(selectBackend('imagegen', env, model).name, 'apiyi');
  }
  assert.equal(selectBackend('imagegen', env).name, 'api');
  assert.equal(resolveBackendName('imagegen', { APIYI_API_KEY: 'yi' }), 'apiyi');
  assert.throws(() => selectBackend('imagegen', { L2D_IMAGE_MODEL: 'gemini-nano-banana-2.1' }), /APIYI_API_KEY/);
});

test('Nano Banana 用 inlineData，不带 data URL，也不带 aspectRatio', async () => {
  const source = await png(16, 24);
  const extra = await png(16, 24, { r: 1, g: 2, b: 3, alpha: 1 });
  let seen: { url?: string; headers?: Record<string, string>; body?: Record<string, any> } = {};
  const fetchImpl: typeof fetch = async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    seen = { url: String(url), headers, body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify(geminiPayload(source)), { status: 200, headers: { 'x-request-id': 'gem-1' } });
  };
  const result = await editImage(request({
    model: 'gemini-nano-banana-2.1',
    source: asset(source, 16, 24),
    references: [asset(extra, 16, 24, 'ref.png')],
    gemini: { imageSize: '2K' },
  }), { apiKey: 'secret-key', baseUrl: 'https://api.apiyi.com', fetch: fetchImpl, maxAttempts: 1 });

  assert.equal(seen.url, 'https://api.apiyi.com/v1beta/models/gemini-nano-banana-2.1:generateContent');
  assert.equal(seen.headers?.authorization, 'Bearer secret-key');
  assert.equal(seen.headers?.['content-type'], 'application/json');
  const parts = seen.body?.contents[0].parts;
  assert.equal(parts[0].text, '把图1标准化');
  assert.equal(parts[1].inlineData.data, source.toString('base64'));
  assert.equal(parts[2].inlineData.mimeType, 'image/png');
  assert.equal(parts[2].inlineData.data, extra.toString('base64'));
  assert.equal(parts[1].inlineData.data.includes('data:image'), false);
  assert.equal(seen.body?.generationConfig.responseModalities[0], 'IMAGE');
  assert.equal(seen.body?.generationConfig.imageConfig.imageSize, '2K');
  assert.equal(seen.body?.generationConfig.imageConfig.aspectRatio, undefined);
  assert.equal(seen.body?.generationConfig.thinkingConfig, undefined);
  assert.equal(result.requestId, 'gem-1');
  assert.equal(result.canvasMatched, true);
  assert.equal(result.ratioMatched, true);
  assert.equal(result.aligned, false);
  assert.equal(result.usage?.promptTokenCount, 11);
  assert.equal(result.image.width, 16);
  assert.equal(result.image.height, 24);
});

test('GPT 单图用 image，多图用 image[]，不传 response_format / input_fidelity', async () => {
  const source = await png(32, 48);
  const extra = await png(32, 48);
  const seen: { headers?: Record<string, string>; names: string[] }[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const form = init?.body as FormData;
    seen.push({ headers: init?.headers as Record<string, string>, names: [...form.keys()] });
    assert.equal(form.get('response_format'), null);
    assert.equal(form.get('input_fidelity'), null);
    return new Response(JSON.stringify({
      data: [{ b64_json: source.toString('base64') }],
      usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
    }), { status: 200, headers: { 'x-request-id': 'gpt-1' } });
  };
  const config = { apiKey: 'secret-key', fetch: fetchImpl, maxAttempts: 1 };
  await editImage(request({ model: 'gpt-image-2.5-sunburst', source: asset(source, 32, 48) }), config);
  await editImage(request({
    model: 'gpt-image-2.5-flare',
    source: asset(source, 32, 48),
    references: [asset(extra, 32, 48, 'ref.png')],
    gpt: { quality: 'high', background: 'auto' },
  }), config);

  assert.equal(seen[0].headers?.['content-type'], undefined);
  assert.equal(seen[0].headers?.authorization, 'Bearer secret-key');
  assert.deepEqual(seen[0].names, ['model', 'prompt', 'image', 'size', 'quality', 'background', 'output_format']);
  assert.equal(seen[1].names.filter(name => name === 'image[]').length, 2);
  assert.equal(seen[1].names.includes('image'), false);
  assert.equal(seen[1].names.includes('response_format'), false);
  assert.equal(seen[1].names.includes('input_fidelity'), false);
});

test('strict 尺寸不一致时失败，不把结果拉伸成目标画布', async () => {
  const source = await png(8, 12);
  const wrong = await png(8, 8);
  let called = 0;
  const fetchImpl: typeof fetch = async () => {
    called += 1;
    return new Response(JSON.stringify(geminiPayload(wrong)), { status: 200 });
  };
  await assert.rejects(
    editImage(request({ model: 'gemini-nano-banana-2.1', source: asset(source, 8, 12) }), { apiKey: 'k', fetch: fetchImpl, maxAttempts: 1 }),
    (error: ImageEditError) => error instanceof ImageEditError && error.kind === 'canvas_mismatch' && /拒绝拉伸|不会缩放/.test(error.message),
  );
  assert.equal(called, 1);
});

test('宽松模式只等比例对齐；比例不同则失败', async () => {
  const small = await png(4, 6);
  const square = await png(4, 4);
  const fetchOf = (bytes: Buffer): typeof fetch => async () => new Response(JSON.stringify(geminiPayload(bytes)), { status: 200 });
  const fitted = await editImage(request({
    model: 'gemini-nano-banana-2.1',
    source: asset(await png(8, 12), 8, 12),
    canvas: { mode: 'original', strict: false },
  }), { apiKey: 'k', fetch: fetchOf(small), maxAttempts: 1 });
  assert.equal(fitted.aligned, true);
  assert.equal(fitted.image.width, 8);
  assert.equal(fitted.image.height, 12);
  const center = await sharp(fitted.image.bytes).raw().toBuffer({ resolveWithObject: true });
  const pixel = center.data.subarray(center.info.width * 4 + 4, center.info.width * 4 + 8);
  assert.equal(pixel[3], 255);

  await assert.rejects(
    editImage(request({
      model: 'gemini-nano-banana-2.1',
      source: asset(await png(8, 12), 8, 12),
      canvas: { mode: 'original', strict: false },
    }), { apiKey: 'k', fetch: fetchOf(square), maxAttempts: 1 }),
    (error: ImageEditError) => error.kind === 'canvas_mismatch',
  );
});

test('GPT 非法尺寸在 strict 下请求前失败；宽松时补边且不拉伸', async () => {
  const source = await png(32, 48);
  let called = false;
  await assert.rejects(
    editImage(request({ model: 'gpt-image-2.5-sunburst', source: asset(source, 30, 40) }), {
      apiKey: 'k', fetch: async () => { called = true; return new Response('no'); }, maxAttempts: 1,
    }),
    (error: ImageEditError) => error.kind === 'unsupported_option',
  );
  assert.equal(called, false);

  let size = '';
  const fitted = await editImage(request({
    model: 'gpt-image-2.5-flare',
    source: asset(source, 30, 40),
    canvas: { mode: 'original', strict: false },
  }), {
    apiKey: 'k',
    maxAttempts: 1,
    fetch: async (_url, init) => {
      size = String((init?.body as FormData).get('size'));
      return new Response(JSON.stringify({ data: [{ b64_json: source.toString('base64') }] }), { status: 200 });
    },
  });
  assert.equal(size, '32x48');
  assert.equal(fitted.image.width, 30);
  assert.equal(fitted.image.height, 40);
  const raw = await sharp(fitted.image.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(raw.data[3], 0);
  const mid = (Math.floor(raw.info.height / 2) * raw.info.width + Math.floor(raw.info.width / 2)) * 4;
  assert.equal(raw.data[mid + 3], 255);
});

test('GPT 合法尺寸与最近合法尺寸', () => {
  assert.equal(gptSizeIssue(1024, 1536), undefined);
  assert.match(gptSizeIssue(30, 40) ?? '', /16/);
  assert.match(gptSizeIssue(64, 3840) ?? '', /1:3/);
  assert.match(gptSizeIssue(4000, 2160) ?? '', /4K/);
  for (const [width, height] of [[100, 100], [30, 40], [5000, 4000], [8, 8], [1, 10000]] as const) {
    const nearest = nearestGptSize(width, height);
    assert.equal(gptSizeIssue(nearest.width, nearest.height), undefined, `${width}x${height} -> ${nearest.width}x${nearest.height}`);
  }
  assert.deepEqual(nearestGptSize(1024, 1536), { width: 1024, height: 1536 });
});

test('错误映射：401 脱敏、400 不重试、429 重试、空图与跨模型参数', async () => {
  const source = await png(16, 16);
  const base = request({ model: 'gemini-nano-banana-2.1', source: asset(source, 16, 16) });
  const secret = 'sk-secret-value';

  await assert.rejects(
    editImage(base, {
      apiKey: secret, maxAttempts: 3, sleep: async () => {},
      fetch: async () => new Response(JSON.stringify({ error: { message: `bad ${secret}` } }), { status: 401 }),
    }),
    (error: ImageEditError) => error.kind === 'unauthorized' && !error.message.includes(secret) && error.message.includes('[redacted]'),
  );

  let attempts = 0;
  await assert.rejects(
    editImage(base, {
      apiKey: 'k', maxAttempts: 3, sleep: async () => {},
      fetch: async () => { attempts += 1; return new Response('{"error":{"message":"bad size"}}', { status: 400 }); },
    }),
    (error: ImageEditError) => error.kind === 'invalid_input',
  );
  assert.equal(attempts, 1);

  attempts = 0;
  const recovered = await editImage(base, {
    apiKey: 'k', maxAttempts: 3, sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) return new Response('busy', { status: 429 });
      return new Response(JSON.stringify(geminiPayload(source)), { status: 200 });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(recovered.image.width, 16);

  await assert.rejects(
    editImage(base, {
      apiKey: 'k', maxAttempts: 1,
      fetch: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'none' }] } }] }), { status: 200 }),
    }),
    (error: ImageEditError) => error.kind === 'empty_image_response',
  );

  await assert.rejects(
    editImage({ ...base, gpt: { quality: 'high' } }, { apiKey: 'k', fetch: async () => { throw new Error('no'); }, maxAttempts: 1 }),
    (error: ImageEditError) => error.kind === 'unsupported_option',
  );

  await assert.rejects(
    editImage(request({ model: 'gpt-image-2.5-flare', source: asset(source, 16, 16), gemini: { imageSize: '4K' } }), {
      apiKey: 'k', fetch: async () => { throw new Error('no'); }, maxAttempts: 1,
    }),
    (error: ImageEditError) => error.kind === 'unsupported_option',
  );
});

async function origin(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取端口');
  return `http://127.0.0.1:${address.port}`;
}

test('CLI：dry-run 不泄露密钥，真实请求按模型走两条协议', async () => {
  const directory = await tempDir();
  const source = await png(32, 48);
  const square = await png(8, 8);
  const clearSource = await sharp(source).ensureAlpha().raw().toBuffer();
  clearSource[3] = 0;
  const transparent = await sharp(clearSource, { raw: { width: 32, height: 48, channels: 4 } }).png().toBuffer();
  await sharp(source).toFile(join(directory, 'ref.png'));
  await sharp(source).toFile(join(directory, 'extra.png'));
  const calls: { url?: string; type?: string; authorization?: string; body: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({
        url: request.url, type: String(request.headers['content-type']),
        authorization: String(request.headers.authorization), body,
      });
      response.setHeader('content-type', 'application/json');
      if (body.includes('mismatch')) {
        response.end(JSON.stringify(geminiPayload(square)));
        return;
      }
      if (request.url?.includes(':generateContent')) {
        const parsed = JSON.parse(body) as { contents: { parts: { inlineData?: { data: string } }[] }[] };
        const data = parsed.contents[0].parts.find(part => part.inlineData)?.inlineData?.data;
        response.end(JSON.stringify(geminiPayload(Buffer.from(data ?? '', 'base64'))));
        return;
      }
      response.end(JSON.stringify({ data: [{ b64_json: transparent.toString('base64') }] }));
    });
  });
  const base = await origin(server);
  const env = { APIYI_API_KEY: 'sk-cli-secret', APIYI_BASE_URL: base, L2D_IMAGE_BACKEND: 'api' };
  try {
    const preview = await l2d([
      'imagegen', '--task', 'standardize', '--prompt', '标准化',
      '--ref', join(directory, 'ref.png'), '--ref', join(directory, 'extra.png'),
      '--out', join(directory, 'dry.png'), '--dry-run',
    ], env);
    assert.match(preview.stdout, /openai-images/);
    assert.match(preview.stdout, /gpt-image-2.5-sunburst/);
    assert.doesNotMatch(preview.stdout, /sk-cli-secret/);
    assert.doesNotMatch(preview.stdout, new RegExp(source.toString('base64').slice(0, 40)));
    assert.equal(calls.length, 0);

    await assert.rejects(
      l2d(['imagegen', '--backend', 'api', '--model', 'gpt-image-2.5-sunburst', '--prompt', 'x', '--out', join(directory, 'x.png')], env),
      (error: { stderr?: string }) => /不一致/.test(error.stderr ?? ''),
    );

    await l2d([
      'imagegen', '--model', 'gemini-nano-banana-2.1', '--prompt', '标准化',
      '--ref', join(directory, 'ref.png'), '--out', join(directory, 'banana.png'),
    ], env);
    assert.match(calls[0].url ?? '', /\/v1beta\/models\/gemini-nano-banana-2.1:generateContent$/);
    assert.equal(calls[0].authorization, 'Bearer sk-cli-secret');
    assert.match(calls[0].type ?? '', /application\/json/);
    const banana = await sharp(join(directory, 'banana.png')).metadata();
    assert.equal(banana.width, 32);
    assert.equal(banana.height, 48);

    await l2d([
      'imagegen', '--model', 'gpt-image-2.5-sunburst', '--prompt', '素体',
      '--ref', join(directory, 'ref.png'), '--ref', join(directory, 'extra.png'),
      '--out', join(directory, 'sunburst.png'), '--background', 'transparent',
    ], env);
    const edit = calls[1];
    assert.equal(edit.url, '/v1/images/edits');
    assert.match(edit.type ?? '', /multipart\/form-data; boundary=/);
    assert.match(edit.body, /name="image\[\]"/);
    assert.match(edit.body, /name="background"\r\n\r\ntransparent/);
    assert.match(edit.body, /name="output_format"\r\n\r\npng/);
    assert.doesNotMatch(edit.body, /response_format|input_fidelity/);
    const sunburst = await sharp(join(directory, 'sunburst.png')).metadata();
    assert.equal(sunburst.width, 32);
    assert.equal(sunburst.height, 48);

    await assert.rejects(
      l2d([
        'imagegen', '--model', 'gemini-nano-banana-2.1', '--prompt', 'mismatch',
        '--ref', join(directory, 'ref.png'), '--out', join(directory, 'bad.png'),
      ], env),
      (error: { stderr?: string }) => /canvas_mismatch/.test(error.stderr ?? ''),
    );
    await assert.rejects(() => stat(join(directory, 'bad.png')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('缺少参考图时 API易编辑直接失败', async () => {
  const directory = await tempDir();
  try {
    await assert.rejects(
      l2d(['imagegen', '--model', 'gemini-nano-banana-2.1', '--prompt', '只要文字', '--out', join(directory, 'x.png')], {
        APIYI_API_KEY: 'k', APIYI_BASE_URL: 'http://127.0.0.1:9',
      }),
      (error: { stderr?: string }) => /至少一张输入图/.test(error.stderr ?? ''),
    );
    assert.equal(await readFile(join(directory, 'x.png')).then(() => true, () => false), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
