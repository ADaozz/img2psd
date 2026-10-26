import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ImageReference = { path: string; description?: string };
export type ImageSizeTier = '1K' | '2K' | '4K';
export type GptImageQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type GptImageBackground = 'auto' | 'opaque' | 'transparent';
export type ImageGenerateJob = {
  prompt: string;
  references?: ImageReference[];
  output: string;
  size?: string;
  model?: string;
  // 缺省 true：输出画布必须与目标一致，不允许缩放补边。
  // false：只做等比例缩放加留边，比例差太多则失败。
  strict?: boolean;
  imageSize?: ImageSizeTier;
  quality?: GptImageQuality;
  background?: GptImageBackground;
};
export type UpscaleJob = { input: string; output: string; scale?: number };
export type ImageResult = {
  savedPath: string;
  bytes: number;
  backend: string;
  model?: string;
  requestId?: string;
  canvasMatched?: boolean;
  ratioMatched?: boolean;
  aligned?: boolean;
};
export type Operation = 'imagegen' | 'upscale';

export type ImageBackend = {
  name: string;
  imageGenerate?(job: ImageGenerateJob): Promise<ImageResult>;
  upscale?(job: UpscaleJob): Promise<ImageResult>;
};

export const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');

export function assertPng(bytes: Buffer, source: string): void {
  if (!bytes.subarray(0, 8).equals(pngMagic)) throw new Error(`${source} 不是 PNG 图片`);
}

// 先写临时文件再改名；失败不会留下半张图。
export async function savePng(bytes: Buffer, output: string, backend: string): Promise<ImageResult> {
  assertPng(bytes, '生成结果');
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, output);
  return { savedPath: output, bytes: bytes.length, backend };
}

export async function readPng(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  assertPng(bytes, path);
  return bytes;
}
