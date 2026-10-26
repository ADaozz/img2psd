import { execFile } from 'node:child_process';
import { copyFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { savePng } from './types.ts';
import type { ImageBackend, ImageGenerateJob, UpscaleJob } from './types.ts';

const run = promisify(execFile);

// 唯一允许调用 Codex 的模块。
// 用法：codex exec --json ... 让内置 image_generation 落盘，再从事件流里取 savedPath。
// 说明：不同 Codex 版本的特性开关与事件字段可能不同；失败时提示改用 api/local 后端。
export function codexBackend(executable = process.env.L2D_CODEX_PATH ?? 'codex'): ImageBackend {
  async function exec(prompt: string, workdir: string): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await run(executable, [
        'exec', '--json', '--sandbox', 'workspace-write', '-C', workdir,
        '-c', 'features.image_generation=true', prompt,
      ], { maxBuffer: 64 * 1024 * 1024, env: process.env }));
    } catch (error) {
      throw new Error(`调用 Codex 失败（${executable}）：${(error as Error).message}。`
        + '可以改用 L2D_IMAGE_BACKEND=api 或（放大）L2D_UPSCALE_BACKEND=local。');
    }
    const matches = [...stdout.matchAll(/"(?:savedPath|saved_path)"\s*:\s*"([^"]+)"/g)];
    const saved = matches.at(-1)?.[1];
    if (!saved) throw new Error('Codex 回合结束但没有返回图片路径；确认已登录且启用 image_generation。');
    return resolve(workdir, saved);
  }

  return {
    name: 'codex',
    async imageGenerate(job: ImageGenerateJob) {
      const workdir = dirname(job.output);
      const refs = (job.references ?? []).map(reference => `参考图：${reference.path}${reference.description ? `（${reference.description}）` : ''}`).join('\n');
      const saved = await exec([
        '使用内置 image_generation 生成一张 PNG 图片。',
        `要求：${job.prompt}`,
        job.size ? `尺寸：${job.size}` : '',
        refs,
        `保存到：${job.output}`,
        '只调用一次，完成后只回复保存路径。',
      ].filter(Boolean).join('\n'), workdir);
      if (resolve(saved) !== resolve(job.output)) await copyFile(saved, job.output);
      return savePng(await readFile(job.output), job.output, 'codex');
    },
    async upscale(job: UpscaleJob) {
      const workdir = dirname(job.output);
      const saved = await exec([
        `使用内置 image_generation 把 ${job.input} 放大 ${job.scale ?? 2} 倍。`,
        '只改变分辨率，不改变内容、颜色、构图和线条；不添加也不删除细节。',
        `保存到：${job.output}`,
        '只调用一次，完成后只回复保存路径。',
      ].join('\n'), workdir);
      if (resolve(saved) !== resolve(job.output)) await copyFile(saved, job.output);
      return savePng(await readFile(job.output), job.output, 'codex');
    },
  };
}
