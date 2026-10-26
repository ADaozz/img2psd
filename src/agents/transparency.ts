import sharp from 'sharp';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Design reference: AstraLayering's background-selection / dual-background /
// image-background modules. Independent implementation of C = alpha F + (1-alpha) B.
type RGB = [number, number, number];
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((v, c) => v - b[c]));

async function pixels(bytes: Buffer) {
  const { data, info } = await sharp(bytes).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function alphaSummary(bytes: Buffer) {
  const { data, width, height } = await pixels(bytes);
  let clear = 0, visible = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 128) clear++;
    if (data[i] >= 128) visible++;
  }
  return { width, height, clear, visible, total: width * height };
}

// An all-clear image or an opaque RGBA container does not satisfy the contract.
export async function requireAlpha(bytes: Buffer) {
  const summary = await alphaSummary(bytes);
  if (!summary.clear || !summary.visible) throw new Error('图片缺少实际透明区域或可见主体，不能作为透明输出交付');
  return summary;
}

export async function sampleBackground(bytes: Buffer): Promise<RGB> {
  const { data, width, height } = await pixels(bytes);
  if (width < 2 || height < 2) throw new Error('双背景恢复至少需要 2×2 图像');
  const offsets: number[] = [];
  for (let x = 0; x < width; x++) offsets.push(x * 4, ((height - 1) * width + x) * 4);
  for (let y = 1; y < height - 1; y++) offsets.push(y * width * 4, (y * width + width - 1) * 4);
  const rgb = [0, 1, 2].map(c => {
    const values = offsets.map(i => data[i + c]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }) as RGB;
  const uniform = offsets.filter(i => data[i + 3] === 255 && rgb.every((v, c) => Math.abs(v - data[i + c]) <= 16)).length;
  if (uniform / offsets.length < 0.6) throw new Error('边缘均匀背景不足 60%，拒绝双背景恢复');
  return rgb;
}

export async function chooseBackground(source: Buffer) {
  // Only the edit target votes. Invisible RGB and inferred opaque backdrop do not.
  const thumb = await sharp(source).rotate().resize({ width: 192, height: 192, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  const { data } = await pixels(thumb);
  const summary = await alphaSummary(thumb);
  let backdrop: RGB | undefined;
  if (!summary.clear) backdrop = await sampleBackground(thumb).catch(() => undefined);
  const candidates = [
    { hex: '#00FF00', rgb: [0, 255, 0] as RGB },
    { hex: '#0000FF', rgb: [0, 0, 255] as RGB },
    { hex: '#FF0000', rgb: [255, 0, 0] as RGB },
  ].map(candidate => {
    let collisions = 0, risk = 0, count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const color = [data[i], data[i + 1], data[i + 2]];
      if (data[i + 3] < 128 || (backdrop && distance(color, backdrop) < 48)) continue;
      count++;
      const d = distance(color, candidate.rgb);
      if (d < 80) collisions++;
      risk += 1 / (1 + d);
    }
    return { ...candidate, collisions, score: collisions * 1000 + (count ? risk / count : 0) };
  });
  const selected = [...candidates].sort((a, b) => a.score - b.score)[0];
  return { ...selected, candidates };
}

// Solve the six-observation constrained least-squares objective. For fixed alpha,
// premultiplied RGB is the clipped mean of the two background-subtracted colors.
// Its breakpoints partition [0,1] into quadratic intervals; evaluate each minimum.
function fitAlpha(a: number[], b: number[], bg: RGB[], seed: number) {
  const mean = bg[0].map((v, c) => (v + bg[1][c]) / 2);
  const intercept = a.map((v, c) => (v + b[c]) / 2 - mean[c]);
  if (intercept.every((v, c) => v + seed * mean[c] >= 0 && v + seed * mean[c] <= 255 * seed)) return seed;
  const knots = [0, 1];
  for (let c = 0; c < 3; c++) {
    for (const value of [-intercept[c] / mean[c], intercept[c] / (255 - mean[c])]) {
      if (Number.isFinite(value) && value > 0 && value < 1) knots.push(value);
    }
  }
  knots.sort((a, b) => a - b);
  const loss = (alpha: number) => a.reduce((sum, v, c) => {
    const premult = clamp(intercept[c] + alpha * mean[c], 0, 255 * alpha);
    return sum + (v - premult - (1 - alpha) * bg[0][c]) ** 2
      + (b[c] - premult - (1 - alpha) * bg[1][c]) ** 2;
  }, 0);
  let best = seed, bestLoss = loss(seed);
  for (let k = 1; k < knots.length; k++) {
    const low = knots[k - 1], high = knots[k], midpoint = (low + high) / 2;
    let linear = 0, quadratic = 0;
    for (let c = 0; c < 3; c++) {
      const p = intercept[c] + midpoint * mean[c];
      const slope = p < 0 ? 0 : p > 255 * midpoint ? 255 : mean[c];
      const offset = p < 0 || p > 255 * midpoint ? 0 : intercept[c];
      for (let j = 0; j < 2; j++) {
        const residual = (j ? b : a)[c] - bg[j][c] - offset;
        const derivative = bg[j][c] - slope;
        linear += residual * derivative;
        quadratic += derivative ** 2;
      }
    }
    for (const value of [low, high, quadratic ? clamp(-linear / quadratic, low, high) : low]) {
      const error = loss(value);
      if (error < bestLoss) { best = value; bestLoss = error; }
    }
  }
  return best;
}

export async function recoverAlpha(first: Buffer, second: Buffer) {
  const [a, b, bg0, bg1] = await Promise.all([pixels(first), pixels(second), sampleBackground(first), sampleBackground(second)]);
  if (a.width !== b.width || a.height !== b.height) throw new Error('双背景画布尺寸不一致');
  const delta = bg1.map((v, c) => v - bg0[c]);
  const norm = delta.reduce((s, v) => s + v * v, 0);
  if (norm < 64 ** 2) throw new Error('背景 RGB 距离不足 64，拒绝恢复');
  const rgba = Buffer.alloc(a.width * a.height * 4);
  const mask = Buffer.alloc(a.width * a.height);
  let inconsistent = 0, foreground = 0, observedForeground = 0, squaredError = 0;
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    const c0 = [a.data[i], a.data[i + 1], a.data[i + 2]];
    const c1 = [b.data[i], b.data[i + 1], b.data[i + 2]];
    const seed = clamp(1 - delta.reduce((sum, v, c) => sum + v * (c1[c] - c0[c]), 0) / norm);
    let alpha = seed < 1 / 255 ? 0 : fitAlpha(c0, c1, [bg0, bg1], seed);
    if (alpha > 0.995) alpha = 1;
    mask[p] = rgba[i + 3] = Math.round(alpha * 255);
    let error = 0;
    for (let c = 0; c < 3; c++) {
      const meanBg = (bg0[c] + bg1[c]) / 2;
      const premult = clamp((c0[c] + c1[c]) / 2 - (1 - alpha) * meanBg, 0, 255 * alpha);
      error += (c0[c] - premult - (1 - alpha) * bg0[c]) ** 2 + (c1[c] - premult - (1 - alpha) * bg1[c]) ** 2;
      // Keep opaque artwork from pass one; fit both observations at soft edges.
      rgba[i + c] = !mask[p] ? 0 : alpha === 1 ? c0[c] : Math.round(premult / alpha);
    }
    squaredError += error;
    if (mask[p]) foreground++;
    // Include disappearing features: a poor fit must not escape validation by
    // being assigned alpha zero. Uniform backdrop noise does not vote.
    if (distance(c0, bg0) > 24 || distance(c1, bg1) > 24) {
      observedForeground++;
      if (Math.sqrt(error / 6) > 20) inconsistent++;
    }
  }
  const report = { method: 'dual-background', backgrounds: [bg0, bg1], size: [a.width, a.height],
    foregroundPixels: foreground, observedForegroundPixels: observedForeground, inconsistentPixels: inconsistent, rmse: Math.sqrt(squaredError / (mask.length * 6)),
    solver: 'bounded-least-squares', inconsistentFractionLimit: 0.02 };
  if (!foreground || inconsistent / Math.max(observedForeground, 1) > 0.02) {
    throw Object.assign(new Error(`两次主体不一致，恢复残差超限：${inconsistent}/${observedForeground} 像素`), { report });
  }
  const [png, alpha] = await Promise.all([
    sharp(rgba, { raw: { width: a.width, height: a.height, channels: 4 } }).png().toBuffer(),
    sharp(mask, { raw: { width: a.width, height: a.height, channels: 1 } }).toColourspace('b-w').png().toBuffer(),
  ]);
  await requireAlpha(png);
  return { png, alpha, report };
}

export function solidPrompt(prompt: string, hex: string) {
  return `${prompt}\n\n【本次模型输出约定】保留以上所有主体要求，仅将透明背景输出要求改为均匀纯色 ${hex} 背景。主体之外和正常开口使用该颜色；柔边、薄纱等半透明处按原透光程度混合该背景。不改变主体配色，不增加投影、渐变、纹理或棋盘格。输出同尺寸 PNG。透明通道由两次背景观测恢复。`;
}

export type TransparencyResult = { png: Buffer; artifactsDirectory: string; method: 'native' | 'dual-background' };
export async function transparentImage(options: {
  output: string; prompt: string; source?: Buffer; dual: boolean;
  request: (prompt: string, source?: Buffer) => Promise<Buffer>;
  finalize?: (png: Buffer) => Promise<Buffer>;
}): Promise<TransparencyResult> {
  await mkdir(dirname(options.output), { recursive: true });
  const directory = await mkdtemp(`${options.output}.transparency-`);
  const report: Record<string, unknown> = { version: 1, requestedBackground: 'transparent' };
  const save = (name: string, bytes: Buffer | string) => writeFile(join(directory, name), bytes, { mode: 0o600 });
  try {
    const selection = options.dual && options.source ? await chooseBackground(options.source) : undefined;
    report.selection = selection;
    const prompt = options.dual ? solidPrompt(options.prompt, selection?.hex ?? '#00FF00') : options.prompt;
    const first = await options.request(prompt);
    await save('original-response.bin', first);
    await save('original.png', await sharp(first).png().toBuffer());
    const summary = await alphaSummary(first);
    report.firstImage = summary;
    if (summary.clear) {
      await requireAlpha(first);
      report.method = 'native';
      const png = (await sharp(first).metadata()).format === 'png' ? first : await sharp(first).png().toBuffer();
      const final = options.finalize ? await options.finalize(png) : png;
      await save('report.json', JSON.stringify(report, null, 2));
      return { png: final, method: 'native', artifactsDirectory: directory };
    }
    if (!options.dual) throw new Error('模型未返回请求的原生 Alpha 透明区域');
    const bg = await sampleBackground(first);
    const hex = distance(bg, [255, 255, 255]) >= distance(bg, [0, 0, 0]) ? '#FFFFFF' : '#000000';
    const replacement = `仅把所附图的背景替换为均匀纯色 ${hex}。保持主体逐像素一致，不重绘、不移动、不缩放，不改变轮廓、颜色、表情和细节。半透明处保持原透光程度并自然混合新背景，开口内也换新背景。不要投影、渐变、纹理或棋盘格。输出 ${summary.width}×${summary.height} PNG。`;
    await save('counterpart-request.json', JSON.stringify({ prompt: replacement, background: hex }, null, 2));
    const second = await options.request(replacement, first);
    await save('counterpart-response.bin', second);
    await save('counterpart.png', await sharp(second).png().toBuffer());
    let observed = await sharp(second).flatten({ background: hex }).png().toBuffer();
    const size = await sharp(observed).metadata();
    if (size.width !== summary.width || size.height !== summary.height) {
      if (!size.width || !size.height || Math.abs((size.width / size.height) / (summary.width / summary.height) - 1) > 0.02) {
        throw new Error('第二次画布比例变化超过 2%，拒绝差分');
      }
      report.alignment = { from: [size.width, size.height], to: [summary.width, summary.height], fit: 'contain' };
      observed = await sharp(observed).resize(summary.width, summary.height, { fit: 'contain', background: hex }).png().toBuffer();
      await save('counterpart-aligned.png', observed);
    }
    const recovered = await recoverAlpha(first, observed);
    await save('transparent.png', recovered.png);
    await save('alpha.png', recovered.alpha);
    Object.assign(report, recovered.report);
    const final = options.finalize ? await options.finalize(recovered.png) : recovered.png;
    await save('report.json', JSON.stringify(report, null, 2));
    return { png: final, method: 'dual-background', artifactsDirectory: directory };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await save('error.json', JSON.stringify({ ...report, recovery: (error as { report?: unknown }).report, error: message }, null, 2));
    throw new Error(`透明输出失败：${message}；诊断文件：${directory}`, { cause: error });
  }
}
