import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { checkParentBounds, type Canvas } from './validate.ts';

export type PreviewMode = 'svg' | 'blend' | 'edge' | 'view';
export type PreviewRequest = {
  path: string;
  mode?: PreviewMode;
  crop?: [number, number, number, number];
  scale?: number;
};
export type PreviewOptions = {
  directory: string;
  reference: string;
  canvas: Canvas;
  parent?: string;
  observationDirectory: string;
};
export type PreviewResult = {
  source: string; mode: PreviewMode; crop: number[]; scale: number;
  width: number; height: number; savedPath: string;
  bounds?: Awaited<ReturnType<typeof checkParentBounds>>;
};

function document(text: string, canvas: Canvas, path: string) {
  const root = text.match(/<svg\b[^>]*>/)?.[0];
  const viewBox = root?.match(/\bviewBox\s*=\s*(['"])(.*?)\1/)?.[2].trim().split(/[\s,]+/).map(Number);
  if (!root || !viewBox || viewBox.length !== 4 ||
      viewBox.some((value, i) => value !== [0, 0, canvas.width, canvas.height][i])) {
    throw new Error(`SVG 必须沿用画布 viewBox="0 0 ${canvas.width} ${canvas.height}"：${path}`);
  }
  return { root, text };
}

// 渲染只在本次运行目录内进行；crop 使用原图像素坐标，scale 直接放大矢量。
export async function renderPreview(options: PreviewOptions, request: PreviewRequest): Promise<PreviewResult> {
  const root = await realpath(options.directory);
  const source = await realpath(resolve(root, request.path));
  const rel = relative(root, source);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('SVG 必须位于本次运行目录内');

  const raster = /\.(png|jpe?g|webp)$/i.test(source);
  const mode = request.mode ?? (raster ? 'view' : 'svg');
  if (!['svg', 'blend', 'edge', 'view'].includes(mode)) throw new Error('mode 只能是 svg、blend、edge 或 view');
  const scale = request.scale ?? 1;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 1 || scale > 8) throw new Error('scale 须为 1..8');

  const crop = request.crop ?? [0, 0, options.canvas.width, options.canvas.height];
  if (!Array.isArray(crop) || crop.length !== 4 || crop.some(n => !Number.isSafeInteger(n) || n < 0) || !crop[2] || !crop[3]) {
    throw new Error('crop 须为 [x,y,width,height] 整数选框，宽高大于零');
  }
  const [left, top, width, height] = crop;
  const outWidth = Math.round(width * scale), outHeight = Math.round(height * scale);
  if (left + width > options.canvas.width || top + height > options.canvas.height) throw new Error('crop 超出画布');
  if (outWidth * outHeight > 16_000_000) throw new Error('预览过大，请缩小选框或 scale');

  if (raster) {
    if (mode === 'edge') throw new Error('edge 只支持 SVG 输入');
    const metadata = await sharp(source).metadata();
    if (metadata.width !== options.canvas.width || metadata.height !== options.canvas.height) {
      throw new Error(`参考图尺寸 ${metadata.width}x${metadata.height} 与画布 ${options.canvas.width}x${options.canvas.height} 不一致`);
    }
    const base = await sharp(source).ensureAlpha().extract({ left, top, width, height })
      .resize(outWidth, outHeight).png().toBuffer();
    let data: Buffer;
    if (mode === 'view') {
      data = await sharp(base).flatten({ background: 'white' }).png().toBuffer();
    } else {
      const overlay = await sharp(base).ensureAlpha().raw().toBuffer();
      for (let i = 3; i < overlay.length; i += 4) overlay[i] = Math.round(overlay[i] * 0.5);
      const reference = await sharp(options.reference).autoOrient().extract({ left, top, width, height })
        .resize(outWidth, outHeight).png().toBuffer();
      data = await sharp(reference)
        .composite([{ input: overlay, raw: { width: outWidth, height: outHeight, channels: 4 } }])
        .flatten({ background: 'white' }).png().toBuffer();
    }
    const bounds = options.parent && source !== resolve(options.parent)
      ? await checkParentBounds(source, options.parent, options.canvas) : undefined;
    await mkdir(options.observationDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const savedPath = join(options.observationDirectory, `${stamp}-${mode}-${randomUUID()}.png`);
    await writeFile(savedPath, data);
    return { source, mode, crop, scale, width: outWidth, height: outHeight, savedPath, ...(bounds ? { bounds } : {}) };
  }

  const bytes = await readFile(source);
  const parsed = document(bytes.toString('utf8'), options.canvas, source);
  // 修改临时渲染的视口，在裁剪区域内直接放大矢量，不修改输入文件。
  const tag = parsed.root.replace(/\s(?:width|height|viewBox)\s*=\s*(['"]).*?\1/g, '')
    .replace(/>$/, ` width="${outWidth}" height="${outHeight}" viewBox="${crop.join(' ')}">`);
  const vector = await sharp(Buffer.from(parsed.text.replace(parsed.root, tag))).ensureAlpha().raw().toBuffer();
  let data: Buffer;
  if (mode === 'svg') {
    data = await sharp(vector, { raw: { width: outWidth, height: outHeight, channels: 4 } })
      .flatten({ background: 'white' }).png().toBuffer();
  } else {
    const overlay = Buffer.from(vector);
    for (let i = 0; i < overlay.length; i += 4) {
      if (mode === 'blend') { overlay[i + 3] = Math.round(overlay[i + 3] * 0.5); continue; }
      const pixel = i / 4, x = pixel % outWidth, y = Math.floor(pixel / outWidth);
      const edge = vector[i + 3] >= 128 && (x === 0 || x === outWidth - 1 || y === 0 || y === outHeight - 1 ||
        vector[i - 1] < 128 || vector[i + 7] < 128 || vector[i - outWidth * 4 + 3] < 128 || vector[i + outWidth * 4 + 3] < 128);
      overlay[i] = 235; overlay[i + 1] = 35; overlay[i + 2] = 55; overlay[i + 3] = edge ? 255 : 0;
    }
    const reference = await sharp(options.reference).autoOrient().extract({ left, top, width, height })
      .resize(outWidth, outHeight).png().toBuffer();
    data = await sharp(reference).composite([{ input: overlay, raw: { width: outWidth, height: outHeight, channels: 4 } }])
      .flatten({ background: 'white' }).png().toBuffer();
  }
  if (data.length > 10 * 1024 * 1024) throw new Error('预览文件过大，请缩小选框或 scale');

  const bounds = options.parent && source !== resolve(options.parent)
    ? await checkParentBounds(source, options.parent, options.canvas) : undefined;
  await mkdir(options.observationDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const savedPath = join(options.observationDirectory, `${stamp}-${mode}-${randomUUID()}.png`);
  await writeFile(savedPath, data);
  return { source, mode, crop, scale, width: outWidth, height: outHeight, savedPath, ...(bounds ? { bounds } : {}) };
}
