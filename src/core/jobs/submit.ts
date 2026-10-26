import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { bytesHash, matchesHash, svgHash } from '../facts/hash.ts';
import { writeAtomic, type GroupNode } from '../facts/groups.ts';
import { readReviewReport, writeReviewReport, type Verdict } from '../facts/review.ts';
import { assertCompletionPreserves, composeCompletion } from '../svg/completion.ts';
import { writeCandidatePreview } from '../svg/candidate.ts';
import { validateGroupSvg } from '../svg/validate.ts';
import { assertObserved, clearObservations } from './observations.ts';
import { outlinePath, partPath, reductionPath, reviewPath } from './plan.ts';
import { readJob, type JobRecord } from './materialize.ts';

// 执行者提交的是草稿、路径、名字或结论。程序只校验并发布事实，不绘制、不调度下一步。

const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex');
const namePattern = /^[a-z][a-z0-9_]*$/;

export type SubmitInput = {
  svg?: string;
  verdict?: Verdict;
  feedback?: string;
  paths?: string;
  note?: string;
  group?: string;
  children?: string;
  levels?: string;
  checks?: string;
  groups?: string;
  subject?: string;
};

async function readJson(value: string): Promise<unknown> {
  const text = value.startsWith('@') ? await readFile(resolve(value.slice(1)), 'utf8') : value;
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error('提交的 JSON 无法解析'); }
}

async function inside(jobDir: string, file: string): Promise<void> {
  const root = await realpath(jobDir);
  const target = await realpath(file);
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('提交的 SVG 必须位于当前 job 目录内');
  }
}

export type SubmitResult = {
  job: string;
  published?: string;
  draft?: string;
  paths?: number;
  levels?: number;
  occlusion?: string;
  changed?: number;
  added?: string[];
  verdict?: string;
  repairs?: number;
  drawn?: string;
  group?: string;
  additions?: number;
};

async function save<T extends SubmitResult>(jobDir: string, result: T): Promise<T> {
  await writeAtomic(join(jobDir, 'result.json'), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2) + '\n');
  return result;
}

async function publishOutline(job: JobRecord, jobDir: string): Promise<SubmitResult> {
  const draft = job.output.draft;
  await assertObserved(jobDir, draft, ['svg', 'blend', 'edge']);
  const parent = job.inputs.parentSvg && await readFile(job.inputs.parentSvg).then(() => job.inputs.parentSvg, () => undefined);
  await validateGroupSvg(draft, job.groupId, job.canvas, parent);
  const bytes = await readFile(draft);
  const published = outlinePath(job.run, job.groupId);
  await writeAtomic(published, bytes);
  const reportPath = reviewPath(job.run, job.groupId);
  const report = await readReviewReport(reportPath, job.groupId);
  const last = report.reviews.at(-1);
  const revises = report.reviews.filter(entry => entry.verdict === 'revise').length;
  if (last?.verdict === 'revise' && !matchesHash(bytes, last.candidateHash) && report.repairs < revises) {
    report.repairs += 1;
    await writeReviewReport(reportPath, report);
  }
  return save(jobDir, { job: jobDir, published });
}

async function publishReview(job: JobRecord, jobDir: string, input: SubmitInput, reportFile: string): Promise<SubmitResult> {
  if (input.verdict !== 'pass' && input.verdict !== 'revise' && input.verdict !== 'blocked') {
    throw new Error('review 需要 --verdict pass|revise|blocked');
  }
  if (!input.feedback?.trim()) throw new Error('review 需要 --feedback');
  const candidate = job.inputs.candidate ?? job.inputs.source;
  if (!candidate) throw new Error('review 缺少候选');
  await assertObserved(jobDir, candidate, ['svg', 'blend', 'edge', 'view']);
  const bytes = await readFile(candidate);
  if (job.candidateHash && !matchesHash(bytes, job.candidateHash) && !bytesHash(bytes).startsWith(job.candidateHash)) {
    throw new Error('候选 SVG 已变化，不能按旧候选提交结论');
  }
  const report = await readReviewReport(reportFile, job.groupId);
  report.reviews.push({
    verdict: input.verdict, feedback: input.feedback.trim(),
    candidateHash: /\.svg$/i.test(candidate) ? svgHash(bytes) : bytesHash(bytes), at: new Date().toISOString(),
  });
  await writeReviewReport(reportFile, report);
  return save(jobDir, { job: jobDir, verdict: input.verdict, published: reportFile });
}

function treeIds(nodes: GroupNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) { into.add(node.id); treeIds(node.groups, into); }
  return into;
}

function findNode(nodes: GroupNode[], id: string): GroupNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.groups, id);
    if (child) return child;
  }
  return undefined;
}

export async function submit(jobDir: string, input: SubmitInput): Promise<SubmitResult> {
  const job = await readJob(jobDir);
  if (job.kind === 'preparation') return submitPreparation(job, jobDir, input);
  if (job.kind === 'grouping') return submitGrouping(job, jobDir, input);
  if (job.kind === 'outline') return publishOutline(job, jobDir);
  if (job.kind === 'review') return publishReview(job, jobDir, input, reviewPath(job.run, job.groupId));
  if (job.kind === 'reduction') return submitReduction(job, jobDir, input);
  if (job.kind === 'completion') return submitCompletion(job, jobDir, input);
  if (job.kind === 'children') return submitChildren(job, jobDir, input);
  if (job.kind === 'occlusion') return submitOcclusion(job, jobDir, input);
  if (job.kind === 'raster') return submitRaster(job, jobDir, input);
  if (job.kind === 'raster-review') return submitRasterReview(job, jobDir, input);
  throw new Error(`未知 job：${job.kind}`);
}

async function submitPreparation(job: JobRecord, jobDir: string, input: SubmitInput): Promise<SubmitResult> {
  if (!input.note?.trim()) throw new Error('参考准备需要 --note');
  const original = join(job.run, 'input/original.png');
  const simplified = join(job.run, 'references/simplified-subject.png');
  const base = join(job.run, 'references/base-subject.png');
  const originalBytes = await readFile(original);
  const simplifiedBytes = await readFile(simplified).catch(() => { throw new Error('缺少 simplified-subject.png'); });
  const baseBytes = await readFile(base).catch(() => { throw new Error('缺少 base-subject.png'); });
  for (const [name, bytes] of [['simplified-subject.png', simplifiedBytes], ['base-subject.png', baseBytes]] as const) {
    if (!bytes.subarray(0, 8).equals(pngMagic)) throw new Error(`${name} 不是 PNG 图片`);
  }
  const meta = async (bytes: Buffer) => {
    const info = await sharp(bytes).metadata();
    return { width: info.autoOrient.width, height: info.autoOrient.height };
  };
  const baseSize = await meta(baseBytes);
  const simplifiedSize = await meta(simplifiedBytes);
  if (baseSize.width !== job.canvas.width || baseSize.height !== job.canvas.height
    || simplifiedSize.width !== job.canvas.width || simplifiedSize.height !== job.canvas.height) {
    throw new Error(`参考图尺寸必须与原图 ${job.canvas.width}x${job.canvas.height} 一致`);
  }
  const { data, info } = await sharp(baseBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 128) transparent++;
  const ratio = transparent / (info.width * info.height);
  if (ratio < 0.05) throw new Error(`素体参考透明面积不足 5%（当前 ${(ratio * 100).toFixed(1)}%）`);
  const preparation = {
    version: 1,
    simplifiedKept: bytesHash(simplifiedBytes) === bytesHash(originalBytes),
    canvas: job.canvas,
    note: input.note.trim(),
    hashes: { baseSubject: bytesHash(baseBytes), simplified: bytesHash(simplifiedBytes), original: bytesHash(originalBytes) },
  };
  const published = join(job.run, 'references/preparation.json');
  await writeAtomic(published, JSON.stringify(preparation, null, 2) + '\n');
  return save(jobDir, { job: jobDir, published });
}

async function submitGrouping(job: JobRecord, jobDir: string, input: SubmitInput): Promise<SubmitResult> {
  if (!input.groups) throw new Error('初始分组需要 --groups');
  const reference = job.inputs.reference ?? join(job.run, 'references/base-subject.png');
  await assertObserved(jobDir, reference, ['blend', 'view']);
  const raw = await readJson(input.groups);
  if (!Array.isArray(raw) || !raw.length) throw new Error('初始分组至少提交一个 group');
  const seen = new Set<string>();
  const groups: GroupNode[] = raw.map(item => {
    const node = item as { name?: string; note?: string };
    if (!node || typeof node.name !== 'string' || !namePattern.test(node.name)) throw new Error(`名称须为小写 snake_case：${String(node?.name)}`);
    if (typeof node.note !== 'string' || !node.note.trim()) throw new Error(`${node.name} 缺少 note`);
    if (seen.has(node.name)) throw new Error(`名称重复：${node.name}`);
    seen.add(node.name);
    return { id: node.name, kind: 'group', name: node.name, note: node.note.trim(), groups: [] };
  });
  const document = JSON.parse(await readFile(join(job.run, 'groups.json'), 'utf8')) as { version?: number; groups?: GroupNode[] };
  if (document.groups?.length) throw new Error('组树已有内容，不能再次初始分组');
  const subject = input.subject;
  if (subject !== undefined && subject !== 'character' && subject !== 'other') throw new Error('subject 只能是 character 或 other');
  const next = { ...document, version: document.version ?? 1, ...(subject ? { subject } : {}), groups };
  await writeAtomic(join(job.run, 'groups.json'), JSON.stringify(next, null, 2) + '\n');
  return save(jobDir, { job: jobDir, published: join(job.run, 'groups.json'), added: groups.map(group => group.id) });
}

async function submitReduction(job: JobRecord, jobDir: string, input: SubmitInput): Promise<SubmitResult> {
  if (input.group || input.svg) {
    if (!input.group || !input.svg) throw new Error('去重单组需要同时给出 --group 与 --svg');
    if (!job.layerIds?.includes(input.group)) throw new Error(`本组不在当前层：${input.group}`);
    await inside(jobDir, input.svg);
    await validateGroupSvg(input.svg, input.group, job.canvas, undefined, true);
    const reductions = { ...(job.reductions ?? {}), [input.group]: await realpath(input.svg) };
    job.reductions = reductions;
    await writeAtomic(join(jobDir, 'job.json'), JSON.stringify(job, null, 2) + '\n');
    return save(jobDir, { job: jobDir, group: input.group });
  }
  if (!input.note?.trim()) throw new Error('整层去重需要 --note');
  const merged = job.inputs.merged ?? join(jobDir, 'inputs/merged.svg');
  await assertObserved(jobDir, merged, ['blend']);
  const groups = [];
  let changed = 0;
  for (const id of job.layerIds ?? []) {
    const source = outlinePath(job.run, id);
    const submitted = job.reductions?.[id];
    const bytes = submitted ? await readFile(submitted) : await readFile(source);
    const same = !submitted || bytes.equals(await readFile(source));
    if (!same) changed += 1;
    await writeAtomic(reductionPath(job.run, id), bytes);
    groups.push({ id, changed: !same });
  }
  const record = { depth: job.depth, note: input.note.trim(), groups };
  const published = join(job.run, 'stages/outline-reduce/layers', `${job.depth}.json`);
  await writeAtomic(published, JSON.stringify(record, null, 2) + '\n');
  return save(jobDir, { job: jobDir, published, changed });
}

async function submitCompletion(job: JobRecord, jobDir: string, input: SubmitInput): Promise<SubmitResult> {
  const sourcePath = job.inputs.source;
  if (!sourcePath) throw new Error('补全缺少只读底稿');
  if (input.paths !== undefined) {
    const source = await readFile(sourcePath, 'utf8');
    const composed = composeCompletion(source, await readJson(input.paths));
    await writeAtomic(job.output.draft, composed);
    const count = composed === source ? 0 : assertCompletionPreserves(source, composed);
    job.draftHash = svgHash(composed);
    await writeAtomic(join(jobDir, 'job.json'), JSON.stringify(job, null, 2) + '\n');
    await clearObservations(jobDir);
    return save(jobDir, { paths: count, draft: job.output.draft, job: jobDir });
  }
  if (!input.note?.trim()) throw new Error('补全需要 --note');
  if (!job.draftHash) throw new Error('尚未提交补全路径');
  const draft = await readFile(job.output.draft);
  if (svgHash(draft) !== job.draftHash) throw new Error('草稿在提交路径后被改动');
  await assertObserved(jobDir, job.output.draft, ['svg', 'blend'], true);
  const source = await readFile(sourcePath, 'utf8');
  const additions = assertCompletionPreserves(source, draft.toString());
  const published = partPath(job.run, job.groupId);
  await writeAtomic(published, draft);
  const check = {
    passed: true, additions, note: input.note.trim(), at: new Date().toISOString(),
  };
  await writeAtomic(join(job.run, 'stages/completion-check', `${job.groupId}.json`), JSON.stringify(check, null, 2) + '\n');
  return save(jobDir, { job: jobDir, published, additions });
}

async function submitChildren(job: JobRecord, jobDir: string, input: SubmitInput): Promise<SubmitResult> {
  if (input.children === undefined) throw new Error('拆分需要 --children');
  if (!input.note?.trim()) throw new Error('拆分需要 --note');
  const seenFile = job.inputs.candidate ?? job.inputs.source;
  if (!seenFile) throw new Error('拆分缺少参考');
  await assertObserved(jobDir, seenFile, ['blend', 'svg', 'view']);
  const raw = await readJson(input.children);
  if (!Array.isArray(raw)) throw new Error('children 须为数组');
  if (raw.length === 1 && (raw[0] as { kind?: string }).kind === 'part') {
    throw new Error('不要用单个 part 包装当前组；不可再拆时提交空 children');
  }
  const names = new Set<string>();
  const children: GroupNode[] = raw.map(item => {
    const node = item as { name?: string; kind?: string; note?: string };
    if (!node || typeof node.name !== 'string' || !namePattern.test(node.name)) throw new Error(`名称须为小写 snake_case：${String(node?.name)}`);
    if (node.kind !== 'group' && node.kind !== 'part') throw new Error(`${node.name} 的 kind 须为 group 或 part`);
    if (typeof node.note !== 'string' || !node.note.trim()) throw new Error(`${node.name} 缺少 note`);
    if (names.has(node.name)) throw new Error(`名称重复：${node.name}`);
    names.add(node.name);
    return { id: `${job.groupId}/${node.name}`, kind: node.kind, name: node.name, note: node.note.trim(), groups: [] };
  });
  const path = join(job.run, 'groups.json');
  const document = JSON.parse(await readFile(path, 'utf8')) as { groups: GroupNode[] };
  const ids = treeIds(document.groups);
  for (const child of children) if (ids.has(child.id)) throw new Error(`ID 已存在：${child.id}`);
  const parent = findNode(document.groups, job.groupId);
  if (!parent) throw new Error(`找不到组：${job.groupId}`);
  const part = partPath(job.run, job.groupId);
  parent.childrenAnalysis = { sourceHash: svgHash(await readFile(part)), note: input.note.trim() };
  if (!children.length) parent.kind = 'part';
  parent.groups = children;
  await writeAtomic(path, JSON.stringify(document, null, 2) + '\n');
  return save(jobDir, { job: jobDir, published: path, added: children.map(child => child.id) });
}

type LevelInput = { id?: string; level?: number; note?: string };

async function submitOcclusion(job: JobRecord, jobDir: string, input: SubmitInput): Promise<SubmitResult> {
  const document = JSON.parse(await readFile(join(job.run, 'groups.json'), 'utf8')) as { groups: GroupNode[] };
  const leaves = [...treeIds(document.groups)].filter(id => {
    const node = findNode(document.groups, id);
    return node && !node.groups.length;
  });
  if (input.levels !== undefined) {
    const raw = await readJson(input.levels);
    if (!Array.isArray(raw)) throw new Error('levels 须为数组');
    const entries = raw as LevelInput[];
    const ids = entries.map(entry => entry.id);
    if (leaves.some(id => !ids.includes(id)) || ids.some(id => !id || !leaves.includes(id))) {
      throw new Error('levels 必须覆盖全部终止 part，且不能包含树外 id');
    }
    const levels = entries.map(entry => entry.level);
    if (levels.some(level => typeof level !== 'number' || !Number.isInteger(level) || level < 0)) {
      throw new Error('level 须为非负整数');
    }
    if (new Set(levels).size !== levels.length) throw new Error('level 不能重复');
    if (entries.some(entry => typeof entry.note !== 'string' || !entry.note.trim())) throw new Error('每个 part 都需要 note');
    const candidate = job.inputs.candidate ?? join(job.run, 'stages/occlusion/candidate.svg');
    await writeCandidatePreview(entries.map(entry => ({
      id: entry.id!, level: entry.level!, path: partPath(job.run, entry.id!),
    })), job.canvas, candidate);
    job.draftHash = svgHash(await readFile(candidate));
    await writeAtomic(join(jobDir, 'job.json'), JSON.stringify({ ...job, proposal: entries }, null, 2) + '\n');
    await clearObservations(jobDir);
    return save(jobDir, { job: jobDir, levels: entries.length });
  }
  if (!input.checks || !input.note?.trim()) throw new Error('遮挡发布需要 --checks 与 --note');
  const candidate = job.inputs.candidate ?? join(job.run, 'stages/occlusion/candidate.svg');
  await assertObserved(jobDir, candidate, ['blend', 'svg']);
  const proposal = (job as JobRecord & { proposal?: LevelInput[] }).proposal;
  if (!proposal?.length) throw new Error('尚未提交 levels');
  const checks = await readJson(input.checks) as Record<string, unknown>;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) throw new Error('checks 须为对象');
  for (const id of leaves) {
    if (typeof checks[id] !== 'string' || !checks[id].trim()) throw new Error(`缺少 ${id} 的检查依据`);
  }
  const preview = join(job.run, 'preview.svg');
  const occlusion = {
    version: 3,
    direction: 'back-to-front',
    sourceHash: bytesHash(await readFile(preview)),
    note: input.note.trim(),
    layers: proposal.map(entry => ({
      id: entry.id, level: entry.level, note: entry.note, check: String(checks[entry.id!]).trim(),
    })),
  };
  const published = join(job.run, 'occlusion.json');
  await writeAtomic(published, JSON.stringify(occlusion, null, 2) + '\n');
  return save(jobDir, { job: jobDir, occlusion: published });
}

async function fileOk(path: string): Promise<void> {
  const bytes = await readFile(path).catch(() => { throw new Error(`缺少交付文件：${path}`); });
  if (!bytes.length) throw new Error(`交付文件为空：${path}`);
  if (path.toLowerCase().endsWith('.kra') && !bytes.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error(`KRA 不是 zip：${path}`);
  if (path.toLowerCase().endsWith('.png') && !bytes.subarray(0, 8).equals(pngMagic)) throw new Error(`PNG 魔数不正确：${path}`);
}

async function finishRaster(job: JobRecord, outcome: string, rounds: number): Promise<void> {
  const directory = job.outputDir ?? join(job.run, job.groupId);
  const marker = {
    step: job.groupId, files: job.required ?? [], outcome, rounds, at: new Date().toISOString(),
  };
  await writeAtomic(join(directory, '.completed'), JSON.stringify(marker, null, 2) + '\n');
}

async function submitRasterReview(job: JobRecord, jobDir: string, input: SubmitInput): Promise<SubmitResult> {
  const reportFile = join(job.run, job.groupId, 'review.json');
  const result = await publishReview(job, jobDir, input, reportFile);
  const report = await readReviewReport(reportFile, job.groupId);
  const revises = report.reviews.filter(entry => entry.verdict === 'revise').length;
  const rounds = job.reviewRounds ?? 2;
  const done = input.verdict === 'pass' || input.verdict === 'blocked'
    || (report.reviews.length >= rounds && report.repairs >= revises);
  if (done) await finishRaster(job, input.verdict === 'pass' ? 'pass' : 'repaired', report.reviews.length);
  return result;
}

async function submitRaster(job: JobRecord, jobDir: string, input: SubmitInput): Promise<SubmitResult> {
  if (!input.note?.trim()) throw new Error('栅格步骤需要 --note');
  const directory = job.outputDir ?? join(job.run, job.groupId);
  for (const name of job.required ?? []) await fileOk(join(directory, name));
  if (job.reason === 'raster') {
    const reportFile = join(directory, 'review.json');
    const report = await readReviewReport(reportFile, job.groupId);
    const revises = report.reviews.filter(entry => entry.verdict === 'revise').length;
    if (report.repairs < revises) {
      report.repairs += 1;
      await writeReviewReport(reportFile, report);
    }
    if (report.reviews.length >= (job.reviewRounds ?? 2) && report.repairs >= revises) {
      await finishRaster(job, 'repaired', report.reviews.length);
    }
    return save(jobDir, { job: jobDir, repairs: report.repairs });
  }
  if (job.expectsReview) {
    const drawn = join(directory, '.drawn');
    await writeAtomic(drawn, JSON.stringify({ at: new Date().toISOString(), note: input.note.trim(), files: job.required ?? [] }, null, 2) + '\n');
    return save(jobDir, { job: jobDir, drawn });
  }
  const marker = { step: job.groupId, files: job.required ?? [], note: input.note.trim(), at: new Date().toISOString() };
  const published = join(directory, '.completed');
  await writeAtomic(published, JSON.stringify(marker, null, 2) + '\n');
  return save(jobDir, { job: jobDir, published });
}
