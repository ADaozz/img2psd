import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { savePng } from './types.ts';
import type { ImageBackend, ImageGenerateJob } from './types.ts';

export type QwenConfig = { baseUrl: string; apiKey: string; model: string };

const mimeOf = (path: string) => /\.jpe?g$/i.test(path) ? 'image/jpeg'
  : /\.webp$/i.test(path) ? 'image/webp' : 'image/png';
const trim = (baseUrl: string) => baseUrl.replace(/\/+$/, '');

// 千问多模态生图（DashScope 兼容）：content 里先放图，再放文本；不扩写提示词。
export async function qwenRequest(job: ImageGenerateJob, model: string) {
  const content: Record<string, unknown>[] = [];
  const images: { path: string; bytes: number; mime: string }[] = [];
  for (const reference of job.references ?? []) {
    const bytes = await readFile(reference.path);
    const mime = mimeOf(reference.path);
    images.push({ path: reference.path, bytes: bytes.length, mime });
    content.push({ image: `data:${mime};base64,${bytes.toString('base64')}` });
  }
  content.push({ text: job.prompt });
  const body = {
    model: job.model ?? model,
    input: { messages: [{ role: 'user', content }] },
    parameters: {
      prompt_extend: false, watermark: false,
      ...(job.size ? { size: job.size.replace('x', '*') } : {}),
    },
  };
  return { body, images };
}

export function qwenEndpoint(baseUrl: string): string {
  return `${trim(baseUrl)}/services/aigc/multimodal-generation/generation`;
}

// 代理环境下的长请求偶发被重置；只对网络层失败重试，HTTP 4xx/5xx 由调用方判断。
async function withRetry<T>(label: string, operation: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await operation(); }
    catch (error) {
      last = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
  const cause = (last as { cause?: { message?: string; code?: string } } | undefined)?.cause;
  throw new Error(`${label}失败（已重试 ${attempts} 次）：${(last as Error)?.message ?? String(last)}`
    + (cause ? ` | ${cause.message ?? cause.code}` : ''));
}

export function qwenBackend(config: QwenConfig): ImageBackend {
  return {
    name: 'qwen',
    async imageGenerate(job: ImageGenerateJob) {
      const { body } = await qwenRequest(job, config.model);
      const response = await withRetry('千问生图请求', () => fetch(qwenEndpoint(config.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
      }));
      const text = await response.text();
      if (!response.ok) throw new Error(`千问生图返回 ${response.status}：${text.slice(0, 300)}`);
      let payload: Record<string, any>;
      try { payload = JSON.parse(text) as Record<string, any>; } catch { throw new Error(`千问生图响应不是 JSON：${text.slice(0, 200)}`); }
      if (payload.code) throw new Error(`千问生图失败：${payload.code} ${payload.message ?? ''}`.trim());
      const content = payload.output?.choices?.[0]?.message?.content;
      const url = (Array.isArray(content) ? content.find(item => typeof item?.image === 'string')?.image : undefined)
        ?? payload.output?.results?.[0]?.url;
      if (typeof url !== 'string' || !url) throw new Error(`千问响应缺少图片 URL：${text.slice(0, 300)}`);
      const downloaded = await withRetry('下载生成图', async () => {
        const attempt = await fetch(url);
        if (!attempt.ok) throw new Error(`HTTP ${attempt.status}`);
        return attempt;
      });
      const bytes = Buffer.from(await downloaded.arrayBuffer());
      // 模型可能返回 jpg/webp；统一转 PNG 再校验落盘。
      const png = await sharp(bytes).png().toBuffer();
      return savePng(png, job.output, 'qwen');
    },
  };
}
