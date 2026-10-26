import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bytesHash, svgHash } from '../facts/hash.ts';
import { writeAtomic } from '../facts/groups.ts';
import { writeMergedPreview } from '../svg/merged-preview.ts';
import { mergePartSvgs } from '../svg/merge.ts';
import { walkGroups, type GroupNode } from '../facts/groups.ts';
import {
  jobDirectory, outlinePath, type Plan, type PlanItem,
} from './plan.ts';
import type { Canvas } from '../svg/validate.ts';

// job 目录是给执行者的完整任务包。这里不画 SVG，也不调用生图或放大。

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const promptsRoot = join(repoRoot, 'prompts');

const imageTools = [
  '生图和局部放大由执行者自己调用，程序不代画：',
  '- 千问 qwen-image-3：`l2d imagegen --model qwenimage3`',
  '- API易标准化：`l2d imagegen --task standardize`（gemini-nano-banana-2.1）',
  '- API易素体：`l2d imagegen --task body_reference`（gpt-image-2.5-sunburst）',
  '- API易快速对照：`l2d imagegen --task fast_comparison`（gpt-image-2.5-flare）',
  '- 局部放大：`l2d upscale --backend local`',
  '白底结果要透明背景时加 `--matte`。',
  '调度也由执行者推进：完成本 job 后执行 `l2d next` 领取下一步。SVG 只写入本 job 的草稿，正式文件由 `l2d submit` 发布。',
].join('\n');

export type JobRecord = {
  id: string;
  kind: string;
  reason: string;
  groupId: string;
  run: string;
  canvas: Canvas;
  inputs: {
    candidate?: string;
    reference?: string;
    parentSvg?: string;
    source?: string;
    merged?: string;
    deliverable?: string;
  };
  output: { draft: string; published?: string };
  draftHash?: string;
  reductions?: Record<string, string>;
  layerIds?: string[];
  depth?: number;
  candidateHash?: string;
  required?: string[];
  outputDir?: string;
  expectsReview?: boolean;
  reviewRounds?: number;
  proposal?: { id?: string; level?: number; note?: string }[];
};

async function promptText(names: string[]): Promise<string> {
  const parts = [];
  for (const name of names) parts.push((await readFile(join(promptsRoot, name), 'utf8')).trim());
  return parts.join('\n\n');
}

export async function readJob(jobDir: string): Promise<JobRecord> {
  const raw = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8')) as JobRecord;
  if (!raw || raw.run === undefined || !raw.kind) throw new Error(`无效 job：${jobDir}`);
  return raw;
}

async function previous(jobDir: string): Promise<Partial<JobRecord>> {
  return readJob(jobDir).catch(() => ({}));
}

export async function materialize(plan: Plan, item: PlanItem, _maxRounds: number): Promise<JobRecord> {
  const dir = jobDirectory(plan.run, item.kind, item.groupId);
  await mkdir(join(dir, 'out'), { recursive: true });
  await mkdir(join(dir, 'inputs'), { recursive: true });
  const prior = await previous(dir);
  const reference = join(plan.run, 'references/base-subject.png');
  const draft = join(dir, 'out/draft.svg');
  const record: JobRecord = {
    id: `${item.kind}:${item.groupId}`,
    kind: item.kind, reason: item.reason, groupId: item.groupId, run: plan.run, canvas: plan.canvas,
    inputs: {},
    output: { draft },
    ...(prior.draftHash ? { draftHash: prior.draftHash } : {}),
    ...(prior.reductions ? { reductions: prior.reductions } : {}),
    ...(item.layerIds ? { layerIds: item.layerIds } : {}),
    ...(item.depth !== undefined ? { depth: item.depth } : {}),
    ...(item.required ? { required: item.required } : {}),
    ...(item.outputDir ? { outputDir: item.outputDir } : {}),
    ...(item.expectsReview ? { expectsReview: true } : {}),
    ...(item.reviewRounds ? { reviewRounds: item.reviewRounds } : {}),
    ...(prior.proposal ? { proposal: prior.proposal } : {}),
  };

  if (item.kind === 'preparation') {
    const original = join(plan.run, 'input/original.png');
    record.inputs.reference = original;
    record.inputs.candidate = original;
    record.output.published = join(plan.run, 'references/preparation.json');
  } else if (item.kind === 'grouping') {
    record.inputs.reference = reference;
    record.inputs.candidate = reference;
    record.output.published = join(plan.run, 'groups.json');
  } else if (item.kind === 'outline') {
    record.inputs.reference = reference;
    record.inputs.candidate = draft;
    if (item.source) record.inputs.parentSvg = item.source;
    record.output.published = outlinePath(plan.run, item.groupId);
    if (item.reason === 'repair' && item.prefill) await copyFile(item.prefill, draft);
  } else if (item.kind === 'review') {
    record.inputs.reference = reference;
    record.inputs.candidate = item.prefill;
    record.inputs.source = item.prefill;
    record.output.draft = item.prefill ?? draft;
    record.output.published = join(plan.run, 'stages/review', `${item.groupId}.review.json`);
    if (item.prefill) record.candidateHash = svgHash(await readFile(item.prefill));
  } else if (item.kind === 'reduction') {
    const merged = join(dir, 'inputs/merged.svg');
    await writeMergedPreview(plan.run, item.layerIds ?? [], plan.canvas, merged);
    record.inputs.reference = reference;
    record.inputs.merged = merged;
    record.inputs.candidate = merged;
    record.output.published = join(plan.run, 'stages/outline-reduce/layers', `${item.depth}.json`);
  } else if (item.kind === 'completion') {
    record.inputs.reference = reference;
    record.inputs.source = item.source;
    record.inputs.candidate = draft;
    record.output.published = join(plan.run, 'parts', `${item.groupId}.svg`);
    if (item.source && !await readFile(draft).then(() => true, () => false)) await copyFile(item.source, draft);
  } else if (item.kind === 'children') {
    record.inputs.reference = reference;
    record.inputs.candidate = item.source;
    record.inputs.source = item.source;
    record.output.published = join(plan.run, 'groups.json');
  } else if (item.kind === 'occlusion') {
    record.inputs.reference = reference;
    record.inputs.candidate = join(plan.run, 'stages/occlusion/candidate.svg');
    record.inputs.source = join(plan.run, 'preview.svg');
    record.output.published = join(plan.run, 'occlusion.json');
    if (item.mergePreview) {
      const raw = JSON.parse(await readFile(join(plan.run, 'groups.json'), 'utf8')) as { groups: GroupNode[] };
      const leaves = walkGroups(raw.groups).filter(entry => !entry.group.groups.length);
      await mergePartSvgs({
        directory: plan.run, outputPath: join(plan.run, 'preview.svg'), groups: raw.groups,
        parts: leaves.map(entry => ({ groupId: entry.group.id, path: join(plan.run, 'parts', `${entry.group.id}.svg`) })),
      });
    }
  } else if (item.kind === 'raster' || item.kind === 'raster-review') {
    record.inputs.reference = item.reference ?? reference;
    record.inputs.candidate = item.kind === 'raster-review' ? (item.deliverable ?? record.inputs.reference) : (item.outputDir ?? draft);
    record.inputs.deliverable = item.deliverable;
    record.output.published = item.outputDir;
    if (item.kind === 'raster-review' && item.deliverable) record.candidateHash = bytesHash(await readFile(item.deliverable));
  }

  await writeAtomic(join(dir, 'job.json'), JSON.stringify(record, null, 2) + '\n');
  await writeAtomic(join(dir, 'INSTRUCTIONS.md'), await instructions(plan, item, dir, record));
  return record;
}

async function instructions(plan: Plan, item: PlanItem, dir: string, record: JobRecord): Promise<string> {
  const lines: string[] = [`# ${item.kind} · ${item.groupId}`, ''];
  if (item.kind === 'preparation') {
    const original = join(plan.run, 'input/original.png');
    lines.push(
      '先看原图与画风参考，判断是否需要简化。',
      '需要简化时，用下面的生图命令写出 simplified-subject.png；不需要则把原图复制过去。',
      '然后做素体换装，写出 base-subject.png。白底图加 --matte。',
      '',
      `原图：${original}`,
      `简化参考：${join(repoRoot, 'resources/简化参考图片.png')}`,
      `连体服参考：${join(repoRoot, 'resources/连体服参考.jpg')}`,
      `简化输出：${join(plan.run, 'references/simplified-subject.png')}`,
      `素体输出：${join(plan.run, 'references/base-subject.png')}`,
      `尺寸：${plan.canvas.width}x${plan.canvas.height}`,
      '',
      imageTools,
      '',
      await promptText(['1-参考判断.md', '2-简化图片.md', '3-素体参考.md']),
    );
  } else if (item.kind === 'grouping') {
    lines.push('只提交一层 name/note。程序生成 id 并写入 groups.json。', '', imageTools, '', await promptText(['4-初始分组.md']));
  } else if (item.kind === 'outline' && item.reason === 'repair') {
    lines.push('返修要求', item.feedback ?? '', '', `草稿：${record.output.draft}`, `参考：${record.inputs.reference ?? ''}`, '', imageTools, '', await promptText(['7-轮廓返修.md']));
    lines.push('', `看图并提交：l2d preview --job ${dir} --mode blend && l2d submit --job ${dir}`);
  } else if (item.kind === 'outline') {
    lines.push(`组：${item.groupId}`, `草稿：${record.output.draft}`, `参考：${record.inputs.reference ?? ''}`);
    if (record.inputs.parentSvg) lines.push(`父轮廓：${record.inputs.parentSvg}`);
    lines.push('', imageTools, '', await promptText(['5-组轮廓.md']));
  } else if (item.kind === 'review') {
    lines.push('本步只给结论，不改 SVG。', `候选：${record.inputs.candidate ?? ''}`, '', await promptText(['6-轮廓review.md']));
  } else if (item.kind === 'reduction') {
    lines.push('先查看整层合成预览，再只提交真正改动的组。未提交的组由程序原样复制。', `合成图：${record.inputs.merged ?? ''}`, '', await promptText(['8-同层轮廓去重.md']));
  } else if (item.kind === 'completion') {
    lines.push('只提交新增闭合路径。程序从只读底稿合成草稿，并保留原形。', `底稿：${record.inputs.source ?? ''}`, `草稿：${record.output.draft}`, '', await promptText(['9-正面遮挡补全.md', '9-补全操作约定.md']));
  } else if (item.kind === 'children') {
    lines.push('只提交直属 name/kind/note。程序生成完整 ID。空列表表示当前节点终止。不要用单个 part 包装。', '', await promptText(['10-直属结构拆分.md', '10-拆分操作约定.md']));
  } else if (item.kind === 'occlusion') {
    lines.push('先看 preview.svg，再提交覆盖全部终止 part 的 level。看过候选叠放后，逐件给出检查依据。', `预览：${join(plan.run, 'preview.svg')}`, `候选：${record.inputs.candidate ?? ''}`, '', await promptText(['11-遮挡层级规划.md']));
  } else if (item.kind === 'raster' || item.kind === 'raster-review') {
    lines.push(item.stepTitle ?? item.groupId);
    if (item.feedback) lines.push('', '返修要求', item.feedback);
    lines.push('', `产出到 ${item.outputDir}`, `交付：${(item.required ?? []).join('、')}`);
    if (item.kind === 'raster-review') lines.push('本步只给结论，不改文件。');
    lines.push('', imageTools);
    if (item.prompt) lines.push('', await promptText([join('raster', item.prompt)]));
  }
  lines.push('', `job 目录：${dir}`);
  return lines.join('\n') + '\n';
}
