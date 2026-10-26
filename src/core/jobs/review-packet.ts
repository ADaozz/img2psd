import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { bytesHash, svgHash } from '../facts/hash.ts';
import { writeAtomic, walkGroups, type GroupNode } from '../facts/groups.ts';
import { readReviewReport } from '../facts/review.ts';
import { renderPreview, type PreviewMode } from '../svg/render.ts';
import { validateGroupSvg } from '../svg/validate.ts';
import { assertCompletionPreserves } from '../svg/completion.ts';
import { appendObservation } from './observations.ts';
import { reviewPlan } from './review-policy.ts';
import { reviewFile } from './review-control.ts';
import { readJob } from './materialize.ts';
import type { VisionImage } from '../../agents/vision/client.ts';

export type PacketImage = { id: string; path: string; hash: string; crop: [number, number, number, number]; scale: number; width: number; height: number };
export async function buildReviewPacket(jobDir: string, attemptId: string) {
  const job = await readJob(jobDir);
  if (job.kind === 'raster-review') throw new Error('自动 PNG 审核不能证明 KRA 图层结构；当前栅格 review 仍需具备 Krita 能力的独立 Agent');
  reviewFile(job);
  const candidate = job.inputs.candidate!, reference = job.inputs.reference!;
  await validateGroupSvg(candidate, job.groupId, job.canvas, job.inputs.parentSvg);
  if (job.inputs.beforeCompletion) await assertCompletionPreserves(await readFile(job.inputs.beforeCompletion, 'utf8'), await readFile(candidate, 'utf8'));
  const plan = await reviewPlan(candidate, reference, job.canvas);
  if (job.candidateHash !== plan.candidateHash || (job.referenceHash && job.referenceHash !== plan.referenceHash)) throw new Error('任务版本已变化，请重新 next');
  const directory = join(jobDir, 'attempts', attemptId);
  const images: PacketImage[] = [];
  async function imageFile(id: string, path: string, crop = plan.full, scale = 1) {
    const bytes = await readFile(path);
    const png = await sharp(bytes).png().toBuffer();
    const saved = join(directory, `${id}.png`);
    await writeAtomic(saved, png);
    const meta = await sharp(png).metadata();
    images.push({ id, path: saved, hash: bytesHash(png), crop, scale, width: meta.width!, height: meta.height! });
  }
  await writeAtomic(join(directory, 'candidate.svg'), await readFile(candidate));
  await imageFile('reference', reference);
  for (const [id, path] of [['parent', job.inputs.parentSvg], ['before-completion', job.inputs.beforeCompletion]] as const) {
    if (path) { await writeAtomic(join(directory, `${id}.svg`), await readFile(path)); await imageFile(id, path); }
  }
  const tree = JSON.parse(await readFile(join(job.run, 'groups.json'), 'utf8')) as { groups: GroupNode[] };
  const entries = walkGroups(tree.groups);
  const entry = entries.find(e => e.group.id === job.groupId);
  if (!entry) throw new Error('找不到审核 group');
  // Same-level neighbours provide ownership context without inheriting their drawing responsibilities.
  const neighbours = entries.filter(e => e.group.id !== job.groupId && e.parent?.id === entry.parent?.id);
  const contexts = [];
  for (const n of neighbours) {
    const path = join(job.run, job.kind === 'completion-review' ? 'parts' : 'stages/outline', `${n.group.id}.svg`);
    const bytes = await readFile(path).catch(() => undefined);
    if (bytes) { contexts.push({ id: n.group.id, name: n.group.name, note: n.group.note, hash: svgHash(bytes) }); await imageFile(`neighbour-${contexts.length}`, path); }
  }
  async function view(mode: PreviewMode, crop = plan.full, scale = 1) {
    const result = await renderPreview({ directory: job.run, reference, canvas: job.canvas, observationDirectory: directory }, { path: candidate, mode, crop, scale });
    await appendObservation(jobDir, { ...result, reference, at: new Date().toISOString() });
    const id = `${mode}-${images.length}`;
    images.push({ id, path: result.savedPath, hash: bytesHash(await readFile(result.savedPath)), crop, scale, width: result.width, height: result.height });
  }
  for (const mode of ['svg', 'blend', 'edge'] as const) await view(mode);
  const history = await readReviewReport(reviewFile(job), job.groupId);
  const packet = { version: 1, attemptId, jobId: job.id, stage: job.kind, candidateHash: plan.candidateHash, referenceHash: plan.referenceHash,
    canvas: job.canvas, plan, regions: [...plan.regions], group: entry.group, contexts, history, images, directory,
    instructions: await readFile(join(jobDir, 'INSTRUCTIONS.md'), 'utf8') };
  async function save() { await writeAtomic(join(directory, 'packet.json'), JSON.stringify(packet, null, 2) + '\n'); }
  await save();
  return { packet, job, async addRegions(extra: [number, number, number, number][]) {
    const seen = new Set<string>();
    for (const crop of [...plan.regions, ...extra]) {
      const key = crop.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      if (!packet.regions.some(r => r.join(',') === key)) packet.regions.push(crop);
      for (const mode of ['blend', 'edge'] as const) await view(mode, crop, 2);
    }
    await save();
  } };
}

export async function packetImages(images: PacketImage[]): Promise<VisionImage[]> {
  return Promise.all(images.map(async image => {
    const bytes = await readFile(image.path);
    if (bytesHash(bytes) !== image.hash) throw new Error(`审查包图片已变化：${image.id}`);
    return { id: `${image.id} crop=${image.crop.join(',')} scale=${image.scale} size=${image.width}x${image.height}`, bytes, hash: image.hash };
  }));
}
