import sharp from 'sharp';
import { savePng } from './types.ts';
import type { ImageBackend, UpscaleJob } from './types.ts';

// 纯本地后端：放大用 Lanczos，不联网、不依赖任何模型。
export const localBackend: ImageBackend = {
  name: 'local',
  async upscale(job: UpscaleJob) {
    const scale = job.scale ?? 2;
    if (!Number.isSafeInteger(scale) || scale < 2 || scale > 8) throw new Error('放大倍数须为 2..8 的整数');
    const metadata = await sharp(job.input).metadata();
    const width = Math.round((metadata.width ?? 0) * scale);
    const height = Math.round((metadata.height ?? 0) * scale);
    if (!width || !height) throw new Error(`无法读取输入图片尺寸：${job.input}`);
    const bytes = await sharp(job.input).resize(width, height, { kernel: 'lanczos3' }).png().toBuffer();
    return savePng(bytes, job.output, 'local');
  },
};
