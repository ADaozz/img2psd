import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { assertReviewEvidence, evidenceTemplate, reviewPlan } from './jobs/review-policy.ts';
import { appendObservation } from './jobs/observations.ts';
import { renderPreview } from './svg/render.ts';
import { groupPrompt, groupReferences } from './jobs/group-prompts.ts';

const canvas = { width: 320, height: 64 };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="64" viewBox="0 0 320 64"><g id="face" data-group-path="face"><path d="M 8 8 H 312 V 56 H 8 Z" fill="#f00"/></g></svg>';

test('review 通过须有全部整图、放大选框和逐项依据，并绑定候选/参考/预览像素', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'review-policy-'));
  const candidate = join(dir, 'face.svg'), reference = join(dir, 'base.png');
  try {
    await writeFile(candidate, svg);
    await sharp({ create: { ...canvas, channels: 4, background: '#ffffff' } }).png().toFile(reference);
    const plan = await reviewPlan(candidate, reference, canvas);
    assert.ok(plan.regions.length > 1);
    const evidence = evidenceTemplate(plan);
    for (const item of Object.values(evidence.items)) { item.verdict = 'pass'; item.detail = '固定矩形覆盖 (8,8)-(312,56)，没有孔洞或额外组件'; }
    for (const region of evidence.regions) region.detail = '测试矩形在当前选框内边界连续';
    const check = () => assertReviewEvidence(dir, candidate, reference, canvas, evidence);
    await assert.rejects(check, /整图/);
    const preview = async (mode: 'svg' | 'blend' | 'edge', crop = plan.full, scale = 1) => {
      const result = await renderPreview({ directory: dir, reference, canvas, observationDirectory: join(dir, 'out') }, { path: candidate, mode, crop, scale });
      await appendObservation(dir, { source: candidate, mode, savedPath: result.savedPath, reference, crop, scale, at: new Date().toISOString() });
      return result.savedPath;
    };
    for (const mode of ['svg', 'blend', 'edge'] as const) await preview(mode);
    await assert.rejects(check, /2 倍/);
    for (const crop of plan.regions) {
      await preview('blend', crop, 2);
      await preview('edge', crop, 2);
    }
    await check();
    evidence.items.ownership.verdict = 'revise';
    await assert.rejects(check, /ownership/);
    evidence.items.ownership.verdict = 'pass';
    const observations = JSON.parse(await readFile(join(dir, 'observations.json'), 'utf8'));
    const edge = observations.find((item: { mode: string; scale: number }) => item.mode === 'edge' && item.scale === 2);
    const image = await readFile(edge.savedPath);
    await writeFile(edge.savedPath, 'tampered-preview');
    await assert.rejects(check, /2 倍/);
    await writeFile(edge.savedPath, image);
    await check();
    await sharp({ create: { ...canvas, channels: 4, background: '#000000' } }).png().toFile(reference);
    await assert.rejects(check, /哈希已失效/);
    const current = await reviewPlan(candidate, reference, canvas);
    evidence.referenceHash = current.referenceHash;
    // Merely updating a JSON hash cannot reuse previews of the old reference.
    await assert.rejects(check, /整图/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('组特化正文精确匹配，不继承祖先；头发参考与真实掌片参考可用', async () => {
  const face = await groupPrompt('face', 'completion', '9-正面遮挡补全.md');
  assert.match(face.text, /脸颈连接由 neck/);
  const hair = await groupPrompt('hair', 'completion', '9-正面遮挡补全.md');
  assert.match(hair.text, /头盖/);
  const child = await groupPrompt('hair/unknown', 'completion', '9-正面遮挡补全.md');
  assert.ok(child.path.endsWith('/9-正面遮挡补全.md'));
  const dir = await mkdtemp(join(tmpdir(), 'group-prompts-'));
  try {
    await mkdir(join(dir, 'inputs'), { recursive: true });
    const references = await groupReferences('hair', 'children', dir, dir);
    assert.equal(references.length, 3);
    for (const reference of references) assert.ok((await sharp(reference.path).metadata()).width);
    const sibling = join(dir, 'stages/outline-reduce/arms/arm_left/hand/palm.svg');
    await mkdir(join(dir, 'stages/outline-reduce/arms/arm_left/hand'), { recursive: true });
    await writeFile(sibling, svg);
    const finger = await groupReferences('arms/arm_left/hand/thumb', 'completion', dir, dir);
    assert.equal(finger.length, 2);
    assert.equal(finger[0].sourceSvg, sibling);
    assert.equal((await sharp(finger[0].path).metadata()).width, canvas.width);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
