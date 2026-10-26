import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { savePng } from './types.ts';
import { transparentImage } from './transparency.ts';
import type { ImageBackend, ImageGenerateJob } from './types.ts';

export type ApiConfig = { baseUrl: string; apiKey: string; model: string };

const trim = (baseUrl: string) => baseUrl.replace(/\/+$/, '');

// 兼容 Images API：无参考图走 /images/generations，有参考图走 /images/edits（multipart, image[]）。
export function apiBackend(config: ApiConfig): ImageBackend {
  return {
    name: 'api',
    async imageGenerate(job: ImageGenerateJob) {
      const generate = async (): Promise<Buffer> => {
        const model = job.model ?? config.model;
        const references = job.references ?? [];
        let response: Response;
        if (references.length) {
          const form = new FormData();
          form.set('model', model);
          form.set('prompt', job.prompt);
          if (job.size) form.set('size', job.size);
          if (job.background) {
            form.set('background', job.background);
            form.set('output_format', 'png');
          }
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
              ...(job.background ? { background: job.background, output_format: 'png' } : {}),
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
        return bytes;
      };
      if (job.background === 'transparent') {
        const generated = await transparentImage({ output: job.output, prompt: job.prompt, dual: false, request: generate });
        const saved = await savePng(generated.png, job.output, 'api');
        return { ...saved, transparency: { method: generated.method, artifactsDirectory: generated.artifactsDirectory } };
      }
      return savePng(await generate(), job.output, 'api');
    },
  };
}
