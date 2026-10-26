import { localBackend } from './local.ts';
import { apiBackend } from './api.ts';
import { codexBackend } from './codex.ts';
import { qwenBackend } from './qwen.ts';
import { apiyiBackend, isApiyiModel } from './apiyi.ts';
import type { ImageBackend, ImageGenerateJob, ImageResult, Operation, UpscaleJob } from './types.ts';

export type { ImageGenerateJob, ImageReference, ImageResult, Operation, UpscaleJob } from './types.ts';
export { qwenRequest, qwenEndpoint } from './qwen.ts';
export { isApiyiModel, previewApiyi, taskModel } from './apiyi.ts';

export const QWEN_IMAGE_3 = 'qwen-image-3.0-pro';

const QWEN_ALIASES = new Set(['qwen-image-3.0-pro', 'qwen-image-3.0', 'qwen-image-3', 'qwenimage3']);

// qwen-image-3 与 API易编辑模型共用 imagegen。写明的模型决定后端；别名归一成正式 id。
export function canonicalModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  return QWEN_ALIASES.has(trimmed.toLowerCase()) ? QWEN_IMAGE_3 : trimmed;
}

export function providerForModel(model: string | undefined): 'qwen' | 'apiyi' | undefined {
  const canonical = canonicalModel(model);
  if (!canonical) return undefined;
  if (canonical === QWEN_IMAGE_3) return 'qwen';
  if (isApiyiModel(canonical)) return 'apiyi';
  return undefined;
}

function modelFor(name: string, requested: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  for (const candidate of [requested, canonicalModel(env.L2D_IMAGE_MODEL)]) {
    if (!candidate) continue;
    const provider = providerForModel(candidate);
    if (provider && provider !== name) continue;
    return candidate;
  }
  return undefined;
}

// 选后端：放大默认本地。生图优先使用本次模型所属后端，其次是显式后端，再按已配置的密钥回退。
export function resolveBackendName(operation: Operation, env: NodeJS.ProcessEnv = process.env, model?: string): string {
  const override = (operation === 'upscale' ? env.L2D_UPSCALE_BACKEND : env.L2D_IMAGE_BACKEND)?.trim();
  const requested = providerForModel(model);
  if (operation === 'imagegen' && requested) return requested;
  if (override) return override;
  if (operation === 'upscale') return 'local';
  const configured = providerForModel(env.L2D_IMAGE_MODEL);
  if (configured) return configured;
  if (env.L2D_IMAGE_BASE_URL && env.L2D_IMAGE_API_KEY) return 'api';
  if (env.DASHSCOPE_API_KEY || env.L2D_QWEN_API_KEY) return 'qwen';
  if (env.APIYI_API_KEY) return 'apiyi';
  return 'codex';
}

export function selectBackend(operation: Operation, env: NodeJS.ProcessEnv = process.env, model?: string): ImageBackend {
  const name = resolveBackendName(operation, env, canonicalModel(model));
  const chosen = canonicalModel(model);

  if (name === 'local') {
    if (operation === 'imagegen') throw new Error('local 后端不支持生图；请设置 L2D_IMAGE_BACKEND=api、qwen、apiyi 或 codex');
    return localBackend;
  }
  if (name === 'api') {
    const baseUrl = env.L2D_IMAGE_BASE_URL, apiKey = env.L2D_IMAGE_API_KEY;
    if (!baseUrl || !apiKey) throw new Error('api 后端需要 L2D_IMAGE_BASE_URL 与 L2D_IMAGE_API_KEY');
    return apiBackend({ baseUrl, apiKey, model: modelFor('api', chosen, env) || 'gpt-image-1' });
  }
  if (name === 'qwen') {
    const apiKey = env.DASHSCOPE_API_KEY?.trim() || env.L2D_QWEN_API_KEY?.trim();
    if (!apiKey) throw new Error('qwen 后端需要 DASHSCOPE_API_KEY（或 L2D_QWEN_API_KEY）');
    return qwenBackend({
      apiKey,
      baseUrl: env.L2D_IMAGE_BASE_URL?.trim() || 'https://cn-beijing.maas.qianwenaiapi.com/api/v1',
      model: modelFor('qwen', chosen, env) || QWEN_IMAGE_3,
    });
  }
  if (name === 'apiyi') {
    const apiKey = env.APIYI_API_KEY?.trim();
    if (!apiKey) throw new Error('apiyi 后端需要 APIYI_API_KEY');
    const timeout = Number(env.APIYI_TIMEOUT_MS);
    return apiyiBackend({
      apiKey,
      baseUrl: env.APIYI_BASE_URL?.trim() || 'https://api.apiyi.com',
      model: modelFor('apiyi', chosen, env) || 'gemini-nano-banana-2.1',
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    });
  }
  if (name === 'codex') return codexBackend();
  throw new Error(`未知图片后端：${name}（可选 local / api / qwen / apiyi / codex）`);
}

export async function imageGenerate(job: ImageGenerateJob, env: NodeJS.ProcessEnv = process.env): Promise<ImageResult> {
  const model = canonicalModel(job.model);
  const backend = selectBackend('imagegen', env, model);
  if (!backend.imageGenerate) throw new Error(`${backend.name} 后端不支持生图`);
  return backend.imageGenerate(model ? { ...job, model } : job);
}

export async function upscale(job: UpscaleJob, env: NodeJS.ProcessEnv = process.env): Promise<ImageResult> {
  const backend = selectBackend('upscale', env);
  if (!backend.upscale) throw new Error(`${backend.name} 后端不支持放大`);
  return backend.upscale(job);
}
