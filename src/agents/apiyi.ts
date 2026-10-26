import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import sharp from 'sharp';
import { savePng } from './types.ts';
import { chooseBackground, requireAlpha, solidPrompt, transparentImage } from './transparency.ts';
import type { GptImageBackground, GptImageQuality, ImageBackend, ImageGenerateJob, ImageResult, ImageSizeTier } from './types.ts';

// API易图片编辑。业务层是同一种请求；网络层按模型分成 gemini-native 与 openai-images。
// 文生图不走这里。Key 只放在服务端配置，不进入日志、错误文本或 dry-run。

export type ImageModelId =
  | 'gemini-nano-banana-2.1'
  | 'gpt-image-2.5-sunburst'
  | 'gpt-image-2.5-flare';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageAsset {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  filename?: string;
  width: number;
  height: number;
}

export type CanvasPolicy =
  | { mode: 'original'; strict: true }
  | { mode: 'original'; strict: false }
  | { mode: 'custom'; width: number; height: number };

export interface ImageEditRequest {
  model: ImageModelId;
  prompt: string;
  source: ImageAsset;
  references?: ImageAsset[];
  canvas: CanvasPolicy;
  outputMimeType?: ImageMimeType;
  gpt?: {
    quality?: GptImageQuality;
    background?: GptImageBackground;
    mask?: ImageAsset;
  };
  gemini?: {
    imageSize?: ImageSizeTier;
    aspectRatio?: string;
    thinkingLevel?: 'minimal' | 'medium' | 'high';
  };
}

export interface ImageEditResult {
  provider: 'apiyi';
  model: ImageModelId;
  image: ImageAsset;
  requestId?: string;
  usage?: Record<string, number | undefined>;
  canvasMatched: boolean;
  ratioMatched: boolean;
  aligned: boolean;
}

export type ImageEditErrorKind =
  | 'invalid_input' | 'unsupported_option' | 'unauthorized'
  | 'rate_limited' | 'quota_exceeded' | 'provider_error'
  | 'timeout' | 'network_error' | 'empty_image_response'
  | 'canvas_mismatch';

export class ImageEditError extends Error {
  readonly kind: ImageEditErrorKind;
  readonly status?: number;
  readonly requestId?: string;
  constructor(kind: ImageEditErrorKind, message: string, extra?: { status?: number; requestId?: string }) {
    super(`[${kind}] ${message}`);
    this.name = 'ImageEditError';
    this.kind = kind;
    this.status = extra?.status;
    this.requestId = extra?.requestId;
  }
}

export const APIYI_MODELS = [
  'gemini-nano-banana-2.1',
  'gpt-image-2.5-sunburst',
  'gpt-image-2.5-flare',
] as const;

export const APIYI_TASKS = {
  standardize: 'gpt-image-2.5-sunburst',
  body_reference: 'gpt-image-2.5-sunburst',
  fast_comparison: 'gpt-image-2.5-flare',
} as const;

const IMAGE_SIZES = new Set<ImageSizeTier>(['1K', '2K', '4K']);
const QUALITIES = new Set<GptImageQuality>(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
const BACKGROUNDS = new Set<GptImageBackground>(['auto', 'opaque', 'transparent']);
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_MASK_BYTES = 4 * 1024 * 1024;
const RATIO_EPSILON = 0.02;
const RETRYABLE = new Set<ImageEditErrorKind>(['rate_limited', 'provider_error', 'timeout', 'network_error']);

export type ApiyiConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
};

export function isApiyiModel(model: string): model is ImageModelId {
  return (APIYI_MODELS as readonly string[]).includes(model);
}

export function isGeminiModel(model: ImageModelId): boolean {
  return model === 'gemini-nano-banana-2.1';
}

export function taskModel(task: string): ImageModelId {
  const model = APIYI_TASKS[task as keyof typeof APIYI_TASKS];
  if (!model) throw new Error(`未知任务：${task}（可选 standardize / body_reference / fast_comparison）`);
  return model;
}

export function apiyiEndpoint(baseUrl: string, model: ImageModelId): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (isGeminiModel(model)) return `${base}/v1beta/models/${model}:generateContent`;
  return `${base}/v1/images/edits`;
}

export function mimeFromBytes(bytes: Uint8Array): ImageMimeType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return undefined;
}

export function gptSizeIssue(width: number, height: number): string | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return '宽高必须是正整数';
  if (width % 16 !== 0 || height % 16 !== 0) return '宽高必须是 16 的倍数';
  const ratio = width / height;
  if (ratio < 1 / 3 || ratio > 3) return '宽高比必须在 1:3 到 3:1';
  if (Math.max(width, height) > 3840 || Math.min(width, height) > 2160) return '超过 4K 上限（3840×2160 或转置）';
  return undefined;
}

function snap16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16);
}

// strict:false 时给 GPT 选一个合法画布。调用方仍要把结果补边回目标尺寸，不能非等比拉伸。
export function nearestGptSize(width: number, height: number): { width: number; height: number } {
  const aspect = Math.min(3, Math.max(1 / 3, width / Math.max(height, 1)));
  let w = snap16(width);
  let h = snap16(height);
  if (w / h > 3) w = snap16(h * 3);
  if (h / w > 3) h = snap16(w * 3);
  const scale = Math.min(1, 3840 / Math.max(w, h), 2160 / Math.min(w, h));
  if (scale < 1) {
    w = snap16(w * scale);
    h = snap16(h * scale);
  }
  if (gptSizeIssue(w, h)) {
    if (aspect >= 1) {
      w = Math.min(3840, snap16(width));
      h = snap16(w / aspect);
      if (h > 2160) {
        h = 2160;
        w = Math.min(3840, snap16(h * aspect));
      }
    } else {
      h = Math.min(3840, snap16(height));
      w = snap16(h * aspect);
      if (w > 2160) {
        w = 2160;
        h = Math.min(3840, snap16(w / aspect));
      }
    }
  }
  if (gptSizeIssue(w, h)) return { width: 1024, height: 1024 };
  return { width: w, height: h };
}

export function ratiosClose(width: number, height: number, targetWidth: number, targetHeight: number): boolean {
  const actual = width / height;
  const target = targetWidth / targetHeight;
  return Math.abs(actual - target) / Math.max(actual, target) <= RATIO_EPSILON;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

function providerMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; type?: unknown; code?: unknown }; message?: unknown };
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message
      : typeof parsed.message === 'string' ? parsed.message : undefined;
    const code = parsed.error?.code ?? parsed.error?.type;
    if (message) return clip([typeof code === 'string' || typeof code === 'number' ? String(code) : '', message].filter(Boolean).join(' '));
  } catch { /* 保留原文 */ }
  return clip(text);
}

function kindFromStatus(status: number, body: string): ImageEditErrorKind {
  const lower = body.toLowerCase();
  if (/insufficient[_\s-]?quota|quota_exceeded|billing|余额不足|欠费/.test(lower)) return 'quota_exceeded';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'quota_exceeded';
  if (status === 400) return 'invalid_input';
  return 'provider_error';
}

function assertEnum<T extends string>(value: string, allowed: Set<T>, label: string): T {
  if (!allowed.has(value as T)) {
    throw new ImageEditError('unsupported_option', `${label} 不支持 ${value}`);
  }
  return value as T;
}

async function inspect(bytes: Uint8Array): Promise<{ mimeType: ImageMimeType; width: number; height: number }> {
  const mimeType = mimeFromBytes(bytes);
  if (!mimeType) throw new ImageEditError('invalid_input', '结果不是 PNG、JPEG 或 WebP');
  const metadata = await sharp(bytes).metadata();
  const oriented = metadata.autoOrient;
  const width = oriented?.width ?? metadata.width;
  const height = oriented?.height ?? metadata.height;
  if (!width || !height) throw new ImageEditError('invalid_input', '无法从图片内容读取宽高');
  return { mimeType, width, height };
}

export async function loadImageAsset(path: string): Promise<ImageAsset> {
  const bytes = await readFile(path);
  const mimeType = mimeFromBytes(bytes);
  if (!mimeType) throw new ImageEditError('invalid_input', `${path} 不是 PNG、JPEG 或 WebP`);
  const { width, height } = await inspect(bytes);
  return { bytes, mimeType, width, height, filename: basename(path) };
}

function decodeBase64(data: string): Buffer {
  const matched = data.match(/^data:[^;]+;base64,([\s\S]+)$/);
  const raw = (matched?.[1] ?? data).replace(/\s/g, '');
  if (!raw) throw new ImageEditError('empty_image_response', '图片 Base64 为空');
  return Buffer.from(raw, 'base64');
}

function numericUsage(source: unknown): Record<string, number | undefined> | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const usage: Record<string, number | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number') usage[key] = value;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function targetCanvas(request: ImageEditRequest): { width: number; height: number } {
  const size = request.canvas.mode === 'custom'
    ? { width: request.canvas.width, height: request.canvas.height }
    : { width: request.source.width, height: request.source.height };
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) {
    throw new ImageEditError('invalid_input', '画布宽高必须是正整数');
  }
  return size;
}

type FitPolicy = 'none' | 'same-ratio' | 'letterbox';

// strict 不做任何缩放。Gemini 的宽松模式只接受比例接近时的等比例留边。
// GPT 的宽松模式允许补边回目标画布，仍然禁止非等比拉伸。
function fitPolicy(request: ImageEditRequest): FitPolicy {
  const strict = request.canvas.mode === 'original' ? request.canvas.strict : true;
  if (strict) return 'none';
  return isGeminiModel(request.model) ? 'same-ratio' : 'letterbox';
}

function gptWireSize(request: ImageEditRequest): string | undefined {
  const target = targetCanvas(request);
  const issue = gptSizeIssue(target.width, target.height);
  if (!issue) return `${target.width}x${target.height}`;
  const strict = request.canvas.mode === 'original' ? request.canvas.strict : true;
  if (strict || request.canvas.mode === 'custom') {
    throw new ImageEditError('unsupported_option', `目标画布 ${target.width}x${target.height} 不符合 GPT 尺寸限制（${issue}）`);
  }
  const nearest = nearestGptSize(target.width, target.height);
  return `${nearest.width}x${nearest.height}`;
}

function assertImages(request: ImageEditRequest): ImageAsset[] {
  const images = [request.source, ...(request.references ?? [])];
  for (const image of images) {
    if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ImageEditError('invalid_input', `${image.filename ?? '图片'} 超过 50MB`);
    }
    if (!image.width || !image.height) throw new ImageEditError('invalid_input', '图片缺少从内容读出的宽高');
  }
  if (!isGeminiModel(request.model) && images.length > 16) {
    throw new ImageEditError('invalid_input', 'GPT 图片编辑最多 16 张图');
  }
  return images;
}

function assertModelOptions(request: ImageEditRequest): void {
  if (isGeminiModel(request.model) && request.gpt) {
    throw new ImageEditError('unsupported_option', 'Nano Banana 不接受 GPT 参数');
  }
  if (!isGeminiModel(request.model) && request.gemini) {
    throw new ImageEditError('unsupported_option', 'GPT 图片编辑不接受 Gemini 参数');
  }
  if (request.gemini?.imageSize) assertEnum(request.gemini.imageSize, IMAGE_SIZES, 'imageSize');
  if (request.gemini?.thinkingLevel && !['minimal', 'medium', 'high'].includes(request.gemini.thinkingLevel)) {
    throw new ImageEditError('unsupported_option', `thinkingLevel 不支持 ${request.gemini.thinkingLevel}`);
  }
  if (request.gpt?.quality) assertEnum(request.gpt.quality, QUALITIES, 'quality');
  if (request.gpt?.background) assertEnum(request.gpt.background, BACKGROUNDS, 'background');
  const format = request.outputMimeType ?? 'image/png';
  if (request.gpt?.background === 'transparent' && format === 'image/jpeg') {
    throw new ImageEditError('unsupported_option', '透明背景只能输出 PNG 或 WebP');
  }
  if (!isGeminiModel(request.model) && request.prompt.length > 32_000) {
    throw new ImageEditError('invalid_input', 'prompt 超过 32000 字符');
  }
  const mask = request.gpt?.mask;
  if (mask) {
    if (mask.mimeType !== 'image/png') throw new ImageEditError('invalid_input', 'mask 必须是 PNG');
    if (mask.bytes.byteLength > MAX_MASK_BYTES) throw new ImageEditError('invalid_input', 'mask 超过 4MB');
    if (mask.width !== request.source.width || mask.height !== request.source.height) {
      throw new ImageEditError('invalid_input', 'mask 必须与第一张图同尺寸');
    }
  }
}

export function buildGeminiBody(request: ImageEditRequest): {
  contents: { role: string; parts: Record<string, unknown>[] }[];
  generationConfig: Record<string, unknown>;
} {
  assertModelOptions(request);
  const images = assertImages(request);
  const parts: Record<string, unknown>[] = [{ text: request.prompt }];
  for (const image of images) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType,
        data: Buffer.from(image.bytes).toString('base64'),
      },
    });
  }
  const imageConfig: Record<string, string> = { imageSize: request.gemini?.imageSize ?? '2K' };
  if (request.gemini?.aspectRatio) imageConfig.aspectRatio = request.gemini.aspectRatio;
  const generationConfig: Record<string, unknown> = {
    responseModalities: ['IMAGE'],
    imageConfig,
  };
  if (request.gemini?.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: request.gemini.thinkingLevel };
  return { contents: [{ role: 'user', parts }], generationConfig };
}

function outputFormat(mime: ImageMimeType | undefined): string {
  if (mime === 'image/jpeg') return 'jpeg';
  if (mime === 'image/webp') return 'webp';
  return 'png';
}

export function buildGptForm(request: ImageEditRequest, size: string | undefined): FormData {
  assertModelOptions(request);
  const images = assertImages(request);
  const form = new FormData();
  form.set('model', request.model);
  form.set('prompt', request.prompt);
  const field = images.length > 1 ? 'image[]' : 'image';
  for (const image of images) {
    form.append(field, new Blob([Buffer.from(image.bytes)], { type: image.mimeType }), image.filename || 'image.png');
  }
  if (size) form.set('size', size);
  form.set('quality', request.gpt?.quality ?? 'high');
  form.set('background', request.gpt?.background ?? 'auto');
  form.set('output_format', outputFormat(request.outputMimeType));
  if (request.gpt?.mask) {
    form.append('mask', new Blob([Buffer.from(request.gpt.mask.bytes)], { type: 'image/png' }), request.gpt.mask.filename || 'mask.png');
  }
  return form;
}

function geminiImage(payload: unknown): { data: string; mimeType?: string } {
  const parts = (payload as { candidates?: { content?: { parts?: unknown[] } }[] })?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const record = part as { inlineData?: { data?: unknown; mimeType?: unknown }; inline_data?: { data?: unknown; mimeType?: unknown; mime_type?: unknown } };
    const inline = record.inlineData ?? record.inline_data;
    if (inline && typeof inline.data === 'string' && inline.data) {
      const mime = inline.mimeType ?? ('mime_type' in inline ? inline.mime_type : undefined);
      return { data: inline.data, mimeType: typeof mime === 'string' ? mime : undefined };
    }
  }
  throw new ImageEditError('empty_image_response', '响应中没有图片');
}

function gptImage(payload: unknown): string {
  const data = (payload as { data?: { b64_json?: unknown }[] })?.data?.[0]?.b64_json;
  if (typeof data !== 'string' || !data) throw new ImageEditError('empty_image_response', '响应中没有 b64_json');
  return data;
}

async function finalizeImage(bytes: Buffer, request: ImageEditRequest): Promise<ImageEditResult['image'] & { canvasMatched: boolean; ratioMatched: boolean; aligned: boolean }> {
  const target = targetCanvas(request);
  const actual = await inspect(bytes);
  const ratioMatched = ratiosClose(actual.width, actual.height, target.width, target.height);
  const exact = actual.width === target.width && actual.height === target.height;
  let png = bytes;
  let aligned = false;
  if (!exact) {
    const policy = fitPolicy(request);
    if (policy === 'none' || (policy === 'same-ratio' && !ratioMatched)) {
      throw new ImageEditError('canvas_mismatch',
        `输出 ${actual.width}x${actual.height} 与目标 ${target.width}x${target.height} 不一致`
        + (ratioMatched ? '；strict 模式不会缩放对齐' : '；比例不同，已拒绝拉伸'));
    }
    png = await sharp(bytes).resize(target.width, target.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png().toBuffer();
    aligned = true;
  } else if (actual.mimeType !== 'image/png') {
    png = await sharp(bytes).png().toBuffer();
  }
  const saved = await inspect(png);
  if (saved.width !== target.width || saved.height !== target.height) {
    throw new ImageEditError('canvas_mismatch', '对齐后的画布仍与目标不一致');
  }
  return {
    bytes: png, mimeType: 'image/png', width: saved.width, height: saved.height, filename: 'output.png',
    canvasMatched: true, ratioMatched, aligned,
  };
}

async function readResponse(response: Response, secret: string): Promise<{ payload: unknown; requestId?: string }> {
  const text = await response.text();
  const requestId = response.headers.get('x-request-id') ?? undefined;
  if (!response.ok) {
    throw new ImageEditError(kindFromStatus(response.status, text), redact(`API易返回 ${response.status}：${providerMessage(text)}`, secret), {
      status: response.status, requestId,
    });
  }
  try {
    return { payload: JSON.parse(text) as unknown, requestId };
  } catch {
    throw new ImageEditError('provider_error', redact(`API易响应不是 JSON：${clip(text)}`, secret), { status: response.status, requestId });
  }
}

async function requestImage(request: ImageEditRequest, config: ApiyiConfig): Promise<{ bytes: Buffer; requestId?: string; usage?: Record<string, number | undefined> }> {
  if (!isApiyiModel(request.model)) {
    throw new ImageEditError('unsupported_option', `不是 API易编辑模型：${String(request.model)}`);
  }
  const baseUrl = config.baseUrl?.trim() || 'https://api.apiyi.com';
  const fetchImpl = config.fetch ?? fetch;
  const sleep = config.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = config.maxAttempts ?? 3;
  const timeoutMs = config.timeoutMs ?? 300_000;
  const url = apiyiEndpoint(baseUrl, request.model);
  const gemini = isGeminiModel(request.model);
  const init = (): RequestInit => gemini
    ? {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildGeminiBody(request)),
      signal: AbortSignal.timeout(timeoutMs),
    }
    : {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: buildGptForm(request, gptWireSize(request)),
      signal: AbortSignal.timeout(timeoutMs),
    };

  let last: ImageEditError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let response: Response;
      let requestInit: RequestInit;
      try {
        requestInit = init();
      } catch (error) {
        if (error instanceof ImageEditError) throw error;
        throw new ImageEditError('invalid_input', redact((error as Error).message, config.apiKey));
      }
      try {
        response = await fetchImpl(url, requestInit);
      } catch (error) {
        if (error instanceof ImageEditError) throw error;
        const name = (error as { name?: string }).name;
        const kind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network_error';
        throw new ImageEditError(kind, redact(`${kind === 'timeout' ? '请求超时' : '网络错误'}：${(error as Error).message}`, config.apiKey));
      }
      const { payload, requestId } = await readResponse(response, config.apiKey);
      const encoded = gemini ? geminiImage(payload).data : gptImage(payload);
      const usage = numericUsage(gemini
        ? (payload as { usageMetadata?: unknown }).usageMetadata
        : (payload as { usage?: unknown }).usage);
      return { bytes: decodeBase64(encoded), requestId, usage };
    } catch (error) {
      if (!(error instanceof ImageEditError) || !RETRYABLE.has(error.kind) || attempt === attempts) {
        if (error instanceof ImageEditError && attempt > 1 && RETRYABLE.has(error.kind)) {
          throw new ImageEditError(error.kind, `${error.message}（已请求 ${attempt} 次）`, { status: error.status, requestId: error.requestId });
        }
        throw error;
      }
      last = error;
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw last ?? new ImageEditError('provider_error', 'API易请求失败');
}

// Low-level editing remains a single request; transparent Gemini orchestration is
// performed by the backend, before any resize or transparent letterboxing.
export async function editImage(request: ImageEditRequest, config: ApiyiConfig): Promise<ImageEditResult> {
  const raw = await requestImage(request, config);
  if (request.gpt?.background === 'transparent') await requireAlpha(raw.bytes);
  const image = await finalizeImage(raw.bytes, request);
  return {
    provider: 'apiyi', model: request.model, requestId: raw.requestId, usage: raw.usage,
    image, canvasMatched: image.canvasMatched, ratioMatched: image.ratioMatched, aligned: image.aligned,
  };
}

function parseSize(size: string): { width: number; height: number } {
  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) throw new ImageEditError('invalid_input', 'size 须为 WIDTHxHEIGHT');
  return { width: Number(match[1]), height: Number(match[2]) };
}

export async function imageEditRequestFromJob(job: ImageGenerateJob, fallbackModel: string): Promise<ImageEditRequest> {
  const model = job.model ?? fallbackModel;
  if (!isApiyiModel(model)) throw new ImageEditError('unsupported_option', `不是 API易编辑模型：${model}`);
  const paths = job.references ?? [];
  if (!paths.length) throw new ImageEditError('invalid_input', 'API易图片编辑需要至少一张输入图（--ref）');
  const source = await loadImageAsset(paths[0].path);
  const references: ImageAsset[] = [];
  for (const reference of paths.slice(1)) references.push(await loadImageAsset(reference.path));
  if (job.background) assertEnum(job.background, BACKGROUNDS, 'background');
  if (isGeminiModel(model) && job.quality) {
    throw new ImageEditError('unsupported_option', 'Nano Banana 不接受 quality');
  }
  if (!isGeminiModel(model) && job.imageSize) {
    throw new ImageEditError('unsupported_option', 'GPT 图片编辑不接受 --image-size');
  }
  let canvas: CanvasPolicy = job.strict === false
    ? { mode: 'original', strict: false }
    : { mode: 'original', strict: true };
  if (job.size) {
    const size = parseSize(job.size);
    if (size.width !== source.width || size.height !== source.height) canvas = { mode: 'custom', width: size.width, height: size.height };
  }
  return {
    model, prompt: job.prompt, source, references, canvas, outputMimeType: 'image/png',
    ...(isGeminiModel(model) ? { gemini: { imageSize: job.imageSize ?? '2K' } } : {}),
    ...(!isGeminiModel(model) && (job.quality || job.background)
      ? { gpt: { ...(job.quality ? { quality: job.quality } : {}), ...(job.background ? { background: job.background } : {}) } }
      : {}),
  };
}

export async function previewApiyi(job: ImageGenerateJob, options: { baseUrl?: string; model?: string } = {}): Promise<Record<string, unknown>> {
  const request = await imageEditRequestFromJob(job, options.model || 'gpt-image-2.5-sunburst');
  const transparency = job.background === 'transparent'
    ? { method: isGeminiModel(request.model) ? 'native-or-dual-background' : 'native',
      maxGenerationPasses: isGeminiModel(request.model) ? 2 : 1, validatesAlphaBeforeAlignment: true }
    : undefined;
  if (transparency && isGeminiModel(request.model)) {
    const selection = await chooseBackground(Buffer.from(request.source.bytes));
    request.prompt = solidPrompt(request.prompt, selection.hex);
  }
  const images = [request.source, ...(request.references ?? [])].map(image => ({
    filename: image.filename, bytes: image.bytes.byteLength, mimeType: image.mimeType, width: image.width, height: image.height,
  }));
  const endpoint = apiyiEndpoint(options.baseUrl || 'https://api.apiyi.com', request.model);
  if (isGeminiModel(request.model)) {
    const body = buildGeminiBody(request);
    return {
      provider: 'apiyi', protocol: 'gemini-native', endpoint, model: request.model, transparency,
      promptChars: request.prompt.length, canvas: request.canvas, images,
      body: {
        contents: [{
          role: 'user',
          parts: body.contents[0].parts.map(part => (
            'inlineData' in part
              ? { inlineData: { mimeType: (part.inlineData as { mimeType: string }).mimeType, base64Chars: String((part.inlineData as { data: string }).data).length } }
              : { textChars: String(part.text).length }
          )),
        }],
        generationConfig: body.generationConfig,
      },
    };
  }
  const size = gptWireSize(request);
  const form = buildGptForm(request, size);
  const fields: string[] = [];
  for (const [name] of form.entries()) fields.push(name);
  return {
    provider: 'apiyi', protocol: 'openai-images', endpoint, model: request.model, transparency,
    promptChars: request.prompt.length, canvas: request.canvas, images, size, fields,
  };
}

export function apiyiBackend(config: ApiyiConfig): ImageBackend {
  return {
    name: 'apiyi',
    async imageGenerate(job: ImageGenerateJob): Promise<ImageResult> {
      const request = await imageEditRequestFromJob(job, config.model || 'gpt-image-2.5-sunburst');
      let transparency: { method: 'native' | 'dual-background'; artifactsDirectory: string } | undefined;
      let edited: ImageEditResult;
      if (job.background === 'transparent') {
        let firstResponse: Awaited<ReturnType<typeof requestImage>> | undefined;
        let finalized: Awaited<ReturnType<typeof finalizeImage>> | undefined;
        const generated = await transparentImage({
          output: job.output, prompt: request.prompt, source: Buffer.from(request.source.bytes),
          dual: isGeminiModel(request.model),
          finalize: async png => {
            finalized = await finalizeImage(png, request);
            return Buffer.from(finalized.bytes);
          },
          request: async (prompt, replacementSource) => {
            let current = { ...request, prompt };
            if (replacementSource) {
              const meta = await inspect(replacementSource);
              current = { ...current, source: { bytes: replacementSource, ...meta, filename: 'original.png' }, references: [] };
            }
            const result = await requestImage(current, config);
            if (!replacementSource) firstResponse = result;
            return result.bytes;
          },
        });
        // finalize is called only after checking/recovering the unpadded pixels.
        const image = finalized!;
        edited = { provider: 'apiyi', model: request.model, image,
          requestId: firstResponse?.requestId, usage: firstResponse?.usage,
          canvasMatched: image.canvasMatched, ratioMatched: image.ratioMatched, aligned: image.aligned };
        transparency = { method: generated.method, artifactsDirectory: generated.artifactsDirectory };
      } else {
        edited = await editImage(request, config);
      }
      const saved = await savePng(Buffer.from(edited.image.bytes), job.output, 'apiyi');
      return {
        ...saved, model: edited.model, requestId: edited.requestId,
        ...(transparency ? { transparency } : {}),
        canvasMatched: edited.canvasMatched, ratioMatched: edited.ratioMatched, aligned: edited.aligned,
      };
    },
  };
}
