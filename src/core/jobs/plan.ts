import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { walkGroups, type GroupNode } from '../facts/groups.ts';
import { readReviewReport, reviewPhase } from '../facts/review.ts';
import { bytesHash, matchesHash } from '../facts/hash.ts';
import { loadRasterConfig, upstreamDirectory, type RasterStep } from '../raster/config.ts';
import { rasterDeliverablesHash } from '../raster/hash.ts';
import type { Canvas } from '../svg/validate.ts';

// 程序只根据已落盘的事实决定「下一件可以领的 job」。
// 调度循环、SVG 绘制、生图和局部放大都由执行者完成。

export type PlanItem = {
  kind: string;
  groupId: string;
  reason: string;
  depth?: number;
  layerIds?: string[];
  feedback?: string;
  prefill?: string;
  source?: string;
  prompt?: string;
  stepTitle?: string;
  required?: string[];
  deliverable?: string;
  outputDir?: string;
  mergePreview?: boolean;
  parentSvg?: string;
  expectsReview?: boolean;
  reviewRounds?: number;
  reference?: string;
};

export type Plan = {
  run: string;
  canvas: Canvas;
  items: PlanItem[];
  blocked: { id: string; message: string }[];
  completed: string[];
};

const exists = async (path: string) => readFile(path).then(() => true, () => false);

export function outlinePath(run: string, id: string): string {
  return join(run, 'stages/outline', `${id}.svg`);
}

export function reviewPath(run: string, id: string): string {
  return join(run, 'stages/review', `${id}.review.json`);
}

export function reductionPath(run: string, id: string): string {
  return join(run, 'stages/outline-reduce', `${id}.svg`);
}

export function partPath(run: string, id: string): string {
  return join(run, 'parts', `${id}.svg`);
}

export function jobDirectory(run: string, kind: string, groupId: string): string {
  return join(run, 'jobs', `${kind}-${groupId.replaceAll('/', '--')}`);
}

async function canvasFrom(path: string): Promise<Canvas> {
  const metadata = await sharp(path).metadata();
  const width = metadata.autoOrient.width;
  const height = metadata.autoOrient.height;
  if (!width || !height) throw new Error(`无法读取画布：${path}`);
  return { width, height };
}

async function readGroups(run: string): Promise<{ subject?: string; groups: GroupNode[] }> {
  const raw = JSON.parse(await readFile(join(run, 'groups.json'), 'utf8')) as { subject?: string; groups?: GroupNode[] };
  if (!Array.isArray(raw.groups)) throw new Error('groups.json 缺少 groups');
  return { subject: raw.subject, groups: raw.groups };
}

type Phase = 'draw' | 'review' | 'repair' | 'done' | 'blocked' | 'exhausted';

export async function outlinePhase(run: string, id: string, maxRounds: number): Promise<Phase> {
  return reviewedPhase(run, id, maxRounds, outlinePath(run, id), reviewPath(run, id));
}

async function reviewedPhase(run: string, id: string, maxRounds: number, candidatePath: string, reportPath: string): Promise<Phase> {
  if (!await exists(candidatePath)) return 'draw';
  const report = await readReviewReport(reportPath, id);
  const phase = reviewPhase(report, maxRounds);
  if (phase === 'done') {
    const last = report.reviews.at(-1)!;
    const [candidate, reference] = await Promise.all([readFile(candidatePath), readFile(join(run, 'references/base-subject.png'))]);
    return reviewPhase(report, maxRounds, { candidateHash: matchesHash(candidate, last.candidateHash) ? last.candidateHash : bytesHash(candidate), referenceHash: bytesHash(reference), requireChecks: true });
  }
  return phase;
}

async function planParts(run: string, options: { maxRounds: number; expand: boolean }): Promise<Plan> {
  const original = join(run, 'input/original.png');
  const base = join(run, 'references/base-subject.png');
  const hasBase = await exists(base);
  if (!hasBase) {
    if (!await exists(original)) throw new Error('缺少原图 input/original.png，无法开始参考准备');
    const canvas = await canvasFrom(original);
    return {
      run, canvas, completed: [], blocked: [],
      items: [{ kind: 'preparation', groupId: 'references', reason: 'preparation' }],
    };
  }
  const canvas = await canvasFrom(base);
  const { groups } = await readGroups(run);
  if (!groups.length) {
    return {
      run, canvas, completed: [], blocked: [],
      items: [{ kind: 'grouping', groupId: 'initial', reason: 'grouping' }],
    };
  }

  const entries = walkGroups(groups);
  const items: PlanItem[] = [];
  const blocked: { id: string; message: string }[] = [];
  const completed: string[] = [];
  for (const entry of entries) {
    const id = entry.group.id;
    if (await exists(partPath(run, id)) && await reviewedPhase(run, id, options.maxRounds, partPath(run, id),
      join(run, 'stages/completion-review', `${id}.review.json`)) === 'done') completed.push(id);
  }

  const depths = [...new Set(entries.map(entry => entry.depth))].sort((a, b) => a - b);
  let settled = true;
  for (const depth of depths) {
    const layer = entries.filter(entry => entry.depth === depth);
    const phases = await Promise.all(layer.map(async entry => ({
      entry, phase: await outlinePhase(run, entry.group.id, options.maxRounds),
    })));
    const outlineOpen = phases.some(item => item.phase !== 'done');
    if (outlineOpen) {
      settled = false;
      for (const item of phases) {
        if (item.phase === 'done') continue;
        const id = item.entry.group.id;
        if (item.phase === 'blocked' || item.phase === 'exhausted') {
          blocked.push({ id, message: `review ${item.phase}：审查未通过；停止下游，处理反馈后重新审查` });
          continue;
        }
        const feedback = item.phase === 'repair'
          ? (await readReviewReport(reviewPath(run, id), id)).reviews.filter(entry => entry.verdict === 'revise').at(-1)?.feedback
          : undefined;
        items.push({
          kind: item.phase === 'review' ? 'review' : 'outline',
          groupId: id, reason: item.phase === 'draw' ? 'draw' : item.phase,
          depth, ...(feedback ? { feedback } : {}),
          ...(item.phase === 'repair' || item.phase === 'review' ? { prefill: outlinePath(run, id) } : {}),
          ...(item.entry.parent ? { source: outlinePath(run, item.entry.parent.id) } : {}),
        });
      }
      for (const entry of entries) if (entry.depth > depth) {
        blocked.push({ id: entry.group.id, message: `深度 ${depth} 层的轮廓或 review 尚未全部完成` });
      }
      break;
    }

    const layerIds = layer.map(entry => entry.group.id);
    const reductionReady = layer.length < 2 || await exists(join(run, 'stages/outline-reduce/layers', `${depth}.json`));
    if (!reductionReady) {
      settled = false;
      items.push({ kind: 'reduction', groupId: `depth-${depth}`, reason: 'reduction', depth, layerIds });
      for (const entry of entries) if (entry.depth > depth) {
        blocked.push({ id: entry.group.id, message: `深度 ${depth} 层尚未完成` });
      }
      break;
    }

    const pendingCompletion = [];
    for (const entry of layer) {
      if (!await exists(partPath(run, entry.group.id))) pendingCompletion.push(entry);
    }
    if (pendingCompletion.length) {
      settled = false;
      for (const entry of pendingCompletion) {
        const id = entry.group.id;
        const reduced = reductionPath(run, id);
        items.push({
          kind: 'completion', groupId: id, reason: 'completion', depth,
          source: await exists(reduced) ? reduced : outlinePath(run, id),
          ...(entry.parent ? { parentSvg: partPath(run, entry.parent.id) } : {}),
        });
      }
      for (const entry of entries) if (entry.depth > depth) {
        blocked.push({ id: entry.group.id, message: `深度 ${depth} 层尚未完成` });
      }
      break;
    }

    const completionOpen: PlanItem[] = [];
    let completionBlocked = false;
    for (const entry of layer) {
      const id = entry.group.id;
      const reportPath = join(run, 'stages/completion-review', `${id}.review.json`);
      const phase = await reviewedPhase(run, id, options.maxRounds, partPath(run, id), reportPath);
      if (phase === 'done') continue;
      if (phase === 'blocked' || phase === 'exhausted') {
        completionBlocked = true;
        blocked.push({ id, message: `补全 review ${phase}：未通过，不能拆分子层或发布最终叠放` });
        continue;
      }
      const reduced = reductionPath(run, id);
      const report = await readReviewReport(reportPath, id);
      completionOpen.push({ kind: phase === 'repair' ? 'completion' : 'completion-review',
        groupId: id, reason: phase === 'repair' ? 'repair' : 'review', depth,
        source: await exists(reduced) ? reduced : outlinePath(run, id), prefill: partPath(run, id),
        ...(phase === 'repair' ? { feedback: report.reviews.at(-1)?.feedback } : {}),
        ...(entry.parent ? { parentSvg: partPath(run, entry.parent.id) } : {}),
      });
    }
    if (completionOpen.length || completionBlocked) {
      settled = false;
      items.push(...completionOpen);
      break;
    }

    if (options.expand) {
      const splittable = layer.filter(entry => entry.group.kind !== 'part' && !entry.group.groups.length && !entry.group.childrenAnalysis);
      if (splittable.length) {
        settled = false;
        for (const entry of splittable) {
          items.push({
            kind: 'children', groupId: entry.group.id, reason: 'children', depth,
            source: partPath(run, entry.group.id),
          });
        }
        break;
      }
    }
  }

  if (settled && !items.length) {
    const leaves = entries.filter(entry => !entry.group.groups.length);
    const ready = leaves.length > 0 && await Promise.all(leaves.map(entry => exists(partPath(run, entry.group.id)))).then(flags => flags.every(Boolean));
    if (ready && !await exists(join(run, 'occlusion.json'))) {
      items.push({ kind: 'occlusion', groupId: 'tree', reason: 'occlusion', mergePreview: true });
    }
  }
  return { run, canvas, items, blocked, completed };
}

async function rasterPhase(run: string, step: RasterStep): Promise<Phase> {
  if (!step.review || !await exists(join(run, step.id, '.drawn'))) return 'draw';
  const report = await readReviewReport(join(run, step.id, 'review.json'), step.id);
  const phase = reviewPhase(report, step.review.maxRounds ?? 3);
  if (phase === 'done') {
    const png = step.required.find(name => name.toLowerCase().endsWith('.png'));
    if (!png) return 'blocked';
    const [candidate, reference, files] = await Promise.all([
      readFile(join(run, step.id, png)), readFile(join(upstreamDirectory(run, await loadRasterConfig(run)), 'references/base-subject.png')),
      rasterDeliverablesHash(join(run, step.id), step.required),
    ]);
    return reviewPhase(report, step.review.maxRounds ?? 3, { candidateHash: bytesHash(candidate), referenceHash: bytesHash(reference), deliverablesHash: files });
  }
  return phase;
}

async function planRaster(run: string): Promise<Plan> {
  const config = await loadRasterConfig(run);
  const upstream = upstreamDirectory(run, config);
  const reference = join(upstream, 'references/base-subject.png');
  const canvas = await exists(reference) ? await canvasFrom(reference) : { width: 0, height: 0 };
  const occlusion = join(upstream, 'occlusion.json');
  if (!await exists(occlusion)) {
    return {
      run, canvas, items: [], completed: [],
      blocked: [{ id: config.pipeline, message: `上游缺少 ${occlusion}` }],
    };
  }
  const items: PlanItem[] = [];
  const blocked: { id: string; message: string }[] = [];
  const completed: string[] = [];
  for (const step of config.steps) {
    if (await exists(join(run, step.id, '.completed')) && (!step.review || await rasterPhase(run, step) === 'done')) { completed.push(step.id); continue; }
    const missing = [];
    for (const input of step.inputs ?? []) if (!await exists(join(run, input))) missing.push(input);
    if (missing.length) {
      blocked.push({ id: step.id, message: `缺少输入 ${missing.join('、')}` });
      break;
    }
    const phase = await rasterPhase(run, step);
    if (phase === 'blocked' || phase === 'exhausted') {
      blocked.push({ id: step.id, message: `raster review ${phase}：未通过，停止下游` });
      break;
    }
    const png = step.required.find(name => name.toLowerCase().endsWith('.png'));
    const feedback = phase === 'repair'
      ? (await readReviewReport(join(run, step.id, 'review.json'), step.id)).reviews.filter(entry => entry.verdict === 'revise').at(-1)?.feedback
      : undefined;
    const prompt = phase === 'review' ? step.review?.prompt
      : phase === 'repair' ? (step.review?.repairPrompt ?? step.prompt)
      : step.prompt;
    items.push({
      kind: phase === 'review' ? 'raster-review' : 'raster',
      groupId: step.id,
      reason: phase === 'repair' ? 'raster' : phase === 'review' ? 'review' : 'draw',
      ...(prompt ? { prompt } : {}), stepTitle: step.title, required: step.required,
      outputDir: join(run, step.id),
      expectsReview: !!step.review,
      reference,
      ...(step.review ? { reviewRounds: step.review.maxRounds ?? 3 } : {}),
      ...(png ? { deliverable: join(run, step.id, png) } : { deliverable: reference }),
      ...(feedback ? { feedback } : {}),
    });
    break;
  }
  return { run, canvas, items, blocked, completed };
}

export async function planJobs(run: string, options: { maxRounds: number; expand: boolean }): Promise<Plan> {
  if (await exists(join(run, 'raster.json'))) return planRaster(run);
  return planParts(run, options);
}
