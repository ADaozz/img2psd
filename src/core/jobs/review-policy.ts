import { readFile, realpath } from 'node:fs/promises';
import sharp from 'sharp';
import { bytesHash, svgHash } from '../facts/hash.ts';
import type { Canvas } from '../svg/validate.ts';
import { readObservations } from './observations.ts';

type Crop = [number, number, number, number];
export const reviewItems = ['silhouette', 'ownership', 'coverage', 'holes', 'connections', 'accessories'] as const;
export type ReviewEvidence = {
  candidateHash: string;
  referenceHash: string;
  items: Record<typeof reviewItems[number], { verdict: 'pass' | 'revise' | 'blocked'; detail: string }>;
  regions: { crop: Crop; detail: string }[];
};

// Review only plans views. Producing a plan does not register any observation.
export async function reviewPlan(candidate: string, reference: string, canvas: Canvas) {
  const [bytes, referenceBytes] = await Promise.all([readFile(candidate), readFile(reference)]);
  const mask = await sharp(bytes).ensureAlpha().extractChannel('alpha').raw().toBuffer({ resolveWithObject: true });
  if (mask.info.width !== canvas.width || mask.info.height !== canvas.height) throw new Error('review 候选画布与参考不一致');
  let x0 = canvas.width, y0 = canvas.height, x1 = -1, y1 = -1;
  for (let p = 0; p < mask.data.length; p++) {
    if (mask.data[p] < 128) continue;
    const x = p % canvas.width, y = Math.floor(p / canvas.width);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (x1 < 0) throw new Error('review 候选没有可见区域');
  x0 = Math.max(0, x0 - 16); y0 = Math.max(0, y0 - 16);
  x1 = Math.min(canvas.width - 1, x1 + 16); y1 = Math.min(canvas.height - 1, y1 + 16);
  const regions: Crop[] = [];
  for (let y = y0; y <= y1; y += 232) {
    for (let x = x0; x <= x1; x += 232) regions.push([x, y, Math.min(256, x1 - x + 1), Math.min(256, y1 - y + 1)]);
  }
  return { version: 1, candidateHash: svgHash(bytes), referenceHash: bytesHash(referenceBytes), canvas,
    full: [0, 0, canvas.width, canvas.height] as Crop, scale: 2, regions };
}

export function evidenceTemplate(plan: Awaited<ReturnType<typeof reviewPlan>>) {
  return { candidateHash: plan.candidateHash, referenceHash: plan.referenceHash,
    items: Object.fromEntries(reviewItems.map(key => [key, { verdict: 'pending', detail: '' }])),
    regions: plan.regions.map(crop => ({ crop, detail: '' })) };
}

export async function assertReviewEvidence(jobDir: string, candidate: string, reference: string, canvas: Canvas, value: unknown): Promise<ReviewEvidence> {
  const plan = await reviewPlan(candidate, reference, canvas);
  const evidence = value as ReviewEvidence | null;
  if (!evidence || evidence.candidateHash !== plan.candidateHash || evidence.referenceHash !== plan.referenceHash) {
    throw new Error('review --checks 的候选或参考哈希已失效，请重新领取并检查当前图片');
  }
  for (const key of reviewItems) {
    const item = evidence.items?.[key];
    if (item?.verdict !== 'pass' || typeof item.detail !== 'string' || !item.detail.trim()) {
      throw new Error(`review pass 需要 ${key} 的通过结论及具体图像依据；存在疑点请 revise/blocked`);
    }
  }
  const sameCrop = (a: unknown, b: Crop) => Array.isArray(a) && a.length === 4 && a.every((v, i) => v === b[i]);
  if (!Array.isArray(evidence.regions) || plan.regions.some(crop => !evidence.regions.some(region =>
    sameCrop(region.crop, crop) && typeof region.detail === 'string' && !!region.detail.trim()))) {
    throw new Error('review pass 必须逐块填写 review-plan.json 中全部选框的检查依据');
  }
  const source = await realpath(candidate);
  const referencePath = await realpath(reference);
  const seen = (await readObservations(jobDir)).filter(item => item.source === source && item.hash === plan.candidateHash
    && item.reference === referencePath && item.referenceHash === plan.referenceHash);
  // Check that the cited previews still exist and contain the registered pixels.
  const intact: typeof seen = [];
  for (const item of seen) {
    const bytes = await readFile(item.savedPath).catch(() => undefined);
    if (bytes && item.imageHash === bytesHash(bytes)) intact.push(item);
  }
  const viewed = (mode: string, crop: Crop, scale: number) => intact.some(item => item.mode === mode
    && sameCrop(item.crop, crop) && typeof item.scale === 'number' && item.scale >= scale);
  if (['svg', 'blend', 'edge'].some(mode => !viewed(mode, plan.full, 1))) {
    throw new Error('review pass 前必须生成并查看当前候选的整图 svg、blend、edge 三种预览');
  }
  if (plan.regions.some(crop => ['blend', 'edge'].some(mode => !viewed(mode, crop, plan.scale)))) {
    throw new Error('review pass 前必须按 review-plan.json 查看全部选框的 2 倍 blend 和 edge 预览');
  }
  return evidence;
}
