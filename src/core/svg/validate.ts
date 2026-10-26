import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

export type Canvas = { width: number; height: number };
const boundsScale = 4;
const alphaThreshold = 128;
const maxPixels = 100_000_000;

async function svgDocument(path: string, canvas: Canvas) {
  const bytes = await readFile(path);
  const text = bytes.toString('utf8');
  const root = text.match(/<svg\b[^>]*>/)?.[0];
  const viewBox = root?.match(/\bviewBox\s*=\s*(['"])(.*?)\1/)?.[2].trim().split(/[\s,]+/).map(Number);
  if (!root || !viewBox || viewBox.length !== 4 ||
      viewBox.some((value, i) => value !== [0, 0, canvas.width, canvas.height][i])) {
    throw new Error(`SVG 必须沿用画布 viewBox="0 0 ${canvas.width} ${canvas.height}"：${path}`);
  }
  const metadata = await sharp(bytes, { limitInputPixels: maxPixels }).metadata();
  if (metadata.width !== canvas.width || metadata.height !== canvas.height) throw new Error(`SVG 画布尺寸不符：${path}`);
  return { bytes, text, root };
}

async function alpha(path: string, canvas: Canvas, scale = 1): Promise<Buffer> {
  const document = await svgDocument(path, canvas);
  const width = canvas.width * scale, height = canvas.height * scale;
  const root = document.root.replace(/\s(?:width|height)\s*=\s*(['"]).*?\1/g, '')
    .replace(/>$/, ` width="${width}" height="${height}">`);
  const bytes = scale === 1 ? document.bytes : Buffer.from(document.text.replace(document.root, root));
  const { data, info } = await sharp(bytes, { limitInputPixels: maxPixels })
    .ensureAlpha().extractChannel('alpha').raw().toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) throw new Error(`范围检查渲染尺寸不符：${path}`);
  return data;
}

// 同一四倍网格上先比较覆盖差，再二值化，避免共用曲线的抗锯齿差异被独立阈值放大。
// 不扩张父范围、不按越界数量放行；任一个未覆盖采样达到阈值即失败。
export async function checkParentBounds(path: string, parent: string, canvas: Canvas) {
  const [childMask, parentMask] = await Promise.all([
    alpha(path, canvas, boundsScale), alpha(parent, canvas, boundsScale),
  ]);
  const width = canvas.width * boundsScale, height = canvas.height * boundsScale;
  let outsideSamples = 0, left = width, top = height, right = -1, bottom = -1;
  for (let i = 0; i < childMask.length; i++) {
    if (childMask[i] - parentMask[i] < alphaThreshold) continue;
    outsideSamples++;
    const x = i % width, y = Math.floor(i / width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return {
    status: outsideSamples ? 'fail' : 'pass', parent, scale: boundsScale, alphaThreshold,
    outsideSamples, outsidePixels: outsideSamples / (boundsScale * boundsScale),
    outsideBox: outsideSamples ? [left / boundsScale, top / boundsScale,
      (right - left + 1) / boundsScale, (bottom - top + 1) / boundsScale] : null,
  };
}

export async function validateGroupSvg(
  path: string, id: string, canvas: Canvas, parent?: string, allowEmpty = false,
): Promise<Buffer> {
  const document = await svgDocument(path, canvas);
  if (/<(?:image|script|foreignObject)\b/.test(document.text)) throw new Error('组 SVG 必须是可编辑矢量，不嵌入位图或脚本');
  const bindings = [...document.text.matchAll(/\bdata-group-path\s*=\s*(['"])(.*?)\1/g)].map(match => match[2]);
  if (!bindings.length || bindings.some(value => value !== id) ||
      ![...document.text.matchAll(/<g\b[^>]*>/g)].some(match => /\sid\s*=/.test(match[0]) &&
        new RegExp(`\\bdata-group-path\\s*=\\s*(['"])${id}\\1`).test(match[0]))) {
    throw new Error(`SVG 必须仅绑定当前组 data-group-path="${id}"，容器须有 id`);
  }
  const mask = await alpha(path, canvas);
  if (!allowEmpty && !mask.some(value => value >= 128)) throw new Error('组 SVG 没有可见填色区域');
  if (parent) {
    const bounds = await checkParentBounds(path, parent, canvas);
    if (bounds.status !== 'pass') throw new Error(`子组超出父轮廓：${JSON.stringify(bounds)}`);
  }
  return document.bytes;
}
