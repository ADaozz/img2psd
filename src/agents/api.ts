import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { savePng } from './types.ts';
import type { ImageBackend, ImageGenerateJob } from './types.ts';

export type ApiConfig = { baseUrl: string; apiKey: string; model: string };

const trim = (baseUrl: string) => baseUrl.replace(/\/+$/, '');

// 兼容 Images API：无参考图走 /images/generations，有参考图走 /images/edits（multipart, image[]）。
export function apiBackend(config: ApiConfig): ImageBackend {
  return {
    name: 'api',
    async imageGenerate(job: ImageGenerateJob) {
      const model = job.model ?? config.model;
      const references = job.references ?? [];
      let response: Response;
      if (references.length) {
        const form = new FormData();
        form.set('model', model);
        form.set('prompt', job.prompt);
        if (job.size) form.set('size', job.size);
        for (const reference of references) {
          form.append('image[]', new Blob([await readFile(reference.path)], { type: 'image/png' }), basename(reference.path));
        }
        response = await fetch(`${trim(config.baseUrl)}/images/edits`, {
          method: 'POST', headers: { authorization: `Bearer ${config.apiKey}` }, body: form,
        });
      } else {
        response = await fetch(`${trim(config.baseUrl)}/images/generations`, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model, prompt: job.prompt, n: 1, response_format: 'b64_json',
            ...(job.size ? { size: job.size } : {}),
          }),
        });
      }
      if (!response.ok) throw new Error(`生图服务返回 ${response.status}：${(await response.text()).slice(0, 300)}`);
      const payload = await response.json() as { data?: { b64_json?: string; url?: string }[] };
      const first = payload.data?.[0];
      const bytes = first?.b64_json ? Buffer.from(first.b64_json, 'base64')
        : first?.url ? Buffer.from(await (await fetch(first.url)).arrayBuffer())
        : undefined;
      if (!bytes) throw new Error('生图响应缺少 b64_json 或 url');
      return savePng(bytes, job.output, 'api');
    },
  };
}
