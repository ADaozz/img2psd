import sharp from 'sharp';
import { savePng } from '../../agents/types.ts';

export type MatteOptions = { tolerance?: number; feather?: number };

// 从四边灌水去掉连通背景，保留内部同色区域（例如白色连体服不被误删）。
// 只适合纯色/近纯色背景；渐变或场景背景需要换方案。
export async function matteBackground(
  input: string, output: string, options: MatteOptions = {},
): Promise<{ width: number; height: number; removed: number; total: number; background: string }> {
  const tolerance = options.tolerance ?? 12;
  const feather = options.feather ?? 1;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0 || tolerance > 120) throw new Error('tolerance 须为 0..120 的整数');
  if (!Number.isSafeInteger(feather) || feather < 0 || feather > 4) throw new Error('feather 须为 0..4 的整数');

  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const total = width * height;

  // 背景色取四角 6x6 的中位数，避免单个角落有噪点。
  const samples: number[][] = [[], [], []];
  for (const [cornerX, cornerY] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
    for (let dy = 0; dy < 6; dy++) {
      for (let dx = 0; dx < 6; dx++) {
        const x = Math.min(width - 1, Math.max(0, cornerX + (cornerX === 0 ? dx : -dx)));
        const y = Math.min(height - 1, Math.max(0, cornerY + (cornerY === 0 ? dy : -dy)));
        const index = (y * width + x) * 4;
        samples[0].push(data[index]); samples[1].push(data[index + 1]); samples[2].push(data[index + 2]);
      }
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const background = [median(samples[0]), median(samples[1]), median(samples[2])];

  const isBackground = (index: number) =>
    Math.abs(data[index] - background[0]) <= tolerance &&
    Math.abs(data[index + 1] - background[1]) <= tolerance &&
    Math.abs(data[index + 2] - background[2]) <= tolerance;

  const mask = new Uint8Array(total); // 1 = 背景
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  const push = (pixel: number) => {
    if (mask[pixel]) return;
    if (!isBackground(pixel * 4)) return;
    mask[pixel] = 1;
    queue[tail++] = pixel;
  };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width, y = (pixel - x) / width;
    if (x > 0) push(pixel - 1);
    if (x < width - 1) push(pixel + 1);
    if (y > 0) push(pixel - width);
    if (y < height - 1) push(pixel + width);
  }

  let removed = 0;
  for (let i = 0; i < total; i++) removed += mask[i];

  // 软边：对「前景=1」的掩码做方形盒滤波，得到 1..2 像素的过渡，避免锯齿。
  // 积分图和索引独立计算，不依赖图像库的通道解释。
  const foreground = new Uint8Array(total);
  for (let i = 0; i < total; i++) foreground[i] = mask[i] ? 0 : 1;
  const radius = feather;
  if (radius === 0) {
    for (let i = 0; i < total; i++) data[i * 4 + 3] = foreground[i] ? 255 : 0;
  } else {
    const stride = width + 1;
    const integral = new Float64Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      for (let x = 0; x < width; x++) {
        rowSum += foreground[y * width + x];
        integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
      }
    }
    for (let y = 0; y < height; y++) {
      const top = Math.max(0, y - radius), bottom = Math.min(height - 1, y + radius);
      for (let x = 0; x < width; x++) {
        const left = Math.max(0, x - radius), right = Math.min(width - 1, x + radius);
        const sum = integral[(bottom + 1) * stride + (right + 1)] - integral[top * stride + (right + 1)]
          - integral[(bottom + 1) * stride + left] + integral[top * stride + left];
        const area = (right - left + 1) * (bottom - top + 1);
        data[(y * width + x) * 4 + 3] = Math.round(255 * sum / area);
      }
    }
  }
  const png = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  await savePng(png, output, 'matte');
  return { width, height, removed, total,
    background: `#${background.map(value => value.toString(16).padStart(2, '0')).join('')}` };
}
