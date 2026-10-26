import { localBackend } from './local.ts';
import { apiBackend } from './api.ts';
import { codexBackend } from './codex.ts';
import { qwenBackend } from './qwen.ts';
import type { ImageBackend, ImageGenerateJob, ImageResult, Operation, UpscaleJob } from './types.ts';

export type { ImageGenerateJob, ImageReference, ImageResult, Operation, UpscaleJob } from './types.ts';
export { qwenRequest, qwenEndpoint } from './qwen.ts';

// 选后端：放大默认本地（不联网），生图默认 api（有配置时）或 codex。
// 显式覆盖：L2D_IMAGE_BACKEND（生图）、L2D_UPSCALE_BACKEND（放大）。
export function selectBackend(operation: Operation, env: NodeJS.ProcessEnv = process.env): ImageBackend {
  const override = (operation === 'upscale' ? env.L2D_UPSCALE_BACKEND : env.L2D_IMAGE_BACKEND)?.trim();
  const apiReady = !!(env.L2D_IMAGE_BASE_URL && env.L2D_IMAGE_API_KEY);
  const qwenReady = !!(env.DASHSCOPE_API_KEY || env.L2D_QWEN_API_KEY);
  const name = override || (operation === 'upscale' ? 'local' : apiReady ? 'api' : qwenReady ? 'qwen' : 'codex');

  if (name === 'local') {
    if (operation === 'imagegen') throw new Error('local 后端不支持生图；请设置 L2D_IMAGE_BACKEND=api 或 codex');
    return localBackend;
  }
  if (name === 'api') {
    const baseUrl = env.L2D_IMAGE_BASE_URL, apiKey = env.L2D_IMAGE_API_KEY;
    if (!baseUrl || !apiKey) throw new Error('api 后端需要 L2D_IMAGE_BASE_URL 与 L2D_IMAGE_API_KEY');
    return apiBackend({ baseUrl, apiKey, model: env.L2D_IMAGE_MODEL?.trim() || 'gpt-image-1' });
  }
  if (name === 'qwen') {
    const apiKey = env.DASHSCOPE_API_KEY?.trim() || env.L2D_QWEN_API_KEY?.trim();
    if (!apiKey) throw new Error('qwen 后端需要 DASHSCOPE_API_KEY（或 L2D_QWEN_API_KEY）');
    return qwenBackend({
      apiKey,
      baseUrl: env.L2D_IMAGE_BASE_URL?.trim() || 'https://cn-beijing.maas.qianwenaiapi.com/api/v1',
      model: env.L2D_IMAGE_MODEL?.trim() || 'qwen-image-3.0-pro',
    });
  }
  if (name === 'codex') return codexBackend();
  throw new Error(`未知图片后端：${name}（可选 local / api / codex）`);
}

export async function imageGenerate(job: ImageGenerateJob, env: NodeJS.ProcessEnv = process.env): Promise<ImageResult> {
  const backend = selectBackend('imagegen', env);
  if (!backend.imageGenerate) throw new Error(`${backend.name} 后端不支持生图`);
  return backend.imageGenerate(job);
}

export async function upscale(job: UpscaleJob, env: NodeJS.ProcessEnv = process.env): Promise<ImageResult> {
  const backend = selectBackend('upscale', env);
  if (!backend.upscale) throw new Error(`${backend.name} 后端不支持放大`);
  return backend.upscale(job);
}
