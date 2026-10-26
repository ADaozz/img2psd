import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export type RasterStep = {
  id: string;
  title: string;
  prompt: string;
  required: string[];
  inputs?: string[];
  review?: { prompt: string; repairPrompt?: string; maxRounds?: number };
};
export type RasterConfig = { pipeline: string; upstream: string; steps: RasterStep[] };

// raster.json 描述步骤与上游位置；步骤产物写在其自身目录，完成标记由程序写。
export async function loadRasterConfig(run: string): Promise<RasterConfig> {
  const raw = JSON.parse(await readFile(join(run, 'raster.json'), 'utf8')) as Partial<RasterConfig>;
  if (typeof raw.pipeline !== 'string' || !raw.pipeline.trim()) throw new Error('raster.json 缺少 pipeline');
  if (typeof raw.upstream !== 'string' || !raw.upstream.trim()) throw new Error('raster.json 缺少 upstream');
  if (!Array.isArray(raw.steps) || !raw.steps.length) throw new Error('raster.json 缺少 steps');
  const seen = new Set<string>();
  const steps = raw.steps.map(item => {
    if (!item || typeof item !== 'object') throw new Error('steps 每项必须是对象');
    const step = item as RasterStep;
    if (typeof step.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(step.id) || seen.has(step.id)) {
      throw new Error(`无效或重复的步骤 id：${String(step.id)}`);
    }
    seen.add(step.id);
    if (typeof step.title !== 'string' || !step.title.trim()) throw new Error(`${step.id} 缺少 title`);
    if (typeof step.prompt !== 'string' || !step.prompt.trim()) throw new Error(`${step.id} 缺少 prompt`);
    if (!Array.isArray(step.required) || !step.required.length) throw new Error(`${step.id} 缺少 required`);
    if (step.review !== undefined) {
      if (!step.review || typeof step.review !== 'object' || typeof step.review.prompt !== 'string' || !step.review.prompt.trim()) {
        throw new Error(`${step.id} 的 review 配置无效`);
      }
      const rounds = step.review.maxRounds ?? 2;
      if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 4) throw new Error(`${step.id} 的 review.maxRounds 须为 1..4`);
      step.review = { ...step.review, maxRounds: rounds };
    }
    return step;
  });
  return { pipeline: raw.pipeline.trim(), upstream: raw.upstream.trim(), steps };
}

export function upstreamDirectory(run: string, config: RasterConfig): string {
  return isAbsolute(config.upstream) ? config.upstream : resolve(run, config.upstream);
}
