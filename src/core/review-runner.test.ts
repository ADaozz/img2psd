import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { planJobs, jobDirectory } from './jobs/plan.ts';
import { materialize } from './jobs/materialize.ts';
import { submit } from './jobs/submit.ts';
import { runReview } from './jobs/review-runner.ts';
import { reviewControl } from './jobs/review-control.ts';
import { readReviewReport, qualityRounds } from './facts/review.ts';
import { appendObservation } from './jobs/observations.ts';
import { renderPreview } from './svg/render.ts';
import type { VisionConfig } from '../agents/vision/client.ts';
import type { VisionReport } from '../agents/vision/report.ts';

const square = (x: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><g id="shape" data-group-path="shape"><path d="M ${x} 16 H 48 V 48 H ${x} Z" fill="#e89b7d" stroke="none"/></g></svg>`;
const options = { maxRounds: 3, expand: false };

test('自动审核协议：故障阻塞/恢复 → 双阶段 revise → 原绘制 job 返修 → 双阶段 pass（模拟接口，非质量验收）', async () => {
  const run = await mkdtemp(join(tmpdir(), 'img2psd-auto-review-'));
  try {
    await mkdir(join(run, 'references'), { recursive: true });
    await mkdir(join(run, 'stages/outline'), { recursive: true });
    await writeFile(join(run, 'groups.json'), JSON.stringify({ version: 1, groups: [{ id: 'shape', name: 'shape', note: 'synthetic rectangle', kind: 'part', groups: [] }] }));
    await writeFile(join(run, 'stages/outline/shape.svg'), square(16));
    await sharp(Buffer.from(square(12))).png().toFile(join(run, 'references/base-subject.png'));
    let plan = await planJobs(run, options);
    await materialize(plan, plan.items[0], 3);
    const review = jobDirectory(run, 'review', 'shape');
    await assert.rejects(runReview(review, { apiKey: 'secret', model: 'vision-test', maxRetries: 0, fetch: async () => new Response('{}', { status: 401 }) }), /401/);
    let history = await readReviewReport(join(run, 'stages/review/shape.review.json'), 'shape');
    assert.equal(history.reviews.at(-1)?.verdict, 'blocked');
    assert.equal(qualityRounds(history), 0);
    assert.equal((await planJobs(run, options)).items.length, 0);
    await reviewControl(review, 'reopen', 'test endpoint repaired');

    const finding = { id: 'F1', rule: 'coverage', severity: 'major', region: [12, 16, 4, 32], description: 'fixture left edge misses strip', evidence: 'known fixture coordinates', repairInstruction: 'set left edge to x=12', targetStage: 'outline', status: 'open' };
    let calls = 0;
    const config = (pass: boolean): VisionConfig => ({ apiKey: 'secret', model: 'vision-test', maxRetries: 0, fetch: async (_url, init) => {
      calls++;
      const text = JSON.parse(init!.body as string).messages[1].content[0].text as string;
      const result = JSON.parse(text.split('完整字段模板：\n')[1].split('\n没有缺陷')[0]) as VisionReport;
      result.verdict = pass ? 'pass' : 'revise';
      result.feedback = 'Synthetic fixture transport and state test, not a visual benchmark';
      result.findings = [{ ...finding, status: pass ? 'resolved' : 'open' }] as VisionReport['findings'];
      for (const value of Object.values(result.checks.items)) { value.verdict = pass ? 'pass' : 'revise'; value.detail = 'Known fixture geometry'; }
      for (const value of result.checks.regions) value.detail = 'Known fixture region';
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], usage: { total_tokens: 10 } });
    } });
    await runReview(review, config(false));
    assert.equal(calls, 2);
    await assert.rejects(runReview(review, config(true)), /repair/);
    assert.equal(calls, 2);
    plan = await planJobs(run, options);
    assert.equal(plan.items[0].reason, 'repair');
    const repair = await materialize(plan, plan.items[0], 3);
    assert.match(plan.items[0].feedback!, /F1/);
    await writeFile(repair.output.draft, square(12));
    const dir = jobDirectory(run, 'outline', 'shape');
    const preview = await renderPreview({ directory: run, reference: repair.inputs.reference!, canvas: repair.canvas, observationDirectory: join(dir, 'out') }, { path: repair.output.draft, mode: 'blend' });
    await appendObservation(dir, { ...preview, reference: repair.inputs.reference, at: new Date().toISOString() });
    await submit(dir, {});
    plan = await planJobs(run, options);
    assert.equal(plan.items[0].kind, 'review');
    await materialize(plan, plan.items[0], 3);
    await runReview(review, config(true));
    history = await readReviewReport(join(run, 'stages/review/shape.review.json'), 'shape');
    assert.equal(history.reviews.at(-1)?.verdict, 'pass');
    assert.equal(qualityRounds(history), 2);
    assert.equal(history.repairs, 1);
    assert.equal((await planJobs(run, options)).items[0].kind, 'completion');
    const packet = JSON.parse(await readFile(join(review, 'last-review-attempt.json'), 'utf8'));
    assert.equal(packet.requests.length, 2);
    await assert.rejects(runReview(review, config(true)), /done/);
  } finally { await rm(run, { recursive: true, force: true }); }
});
