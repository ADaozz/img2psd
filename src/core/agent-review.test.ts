import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import { validateAgentReviewReport, type AgentReviewReport } from './facts/agent-review.ts';
import { reviewItems } from './jobs/review-policy.ts';
import { materialize } from './jobs/materialize.ts';
import { planJobs, jobDirectory } from './jobs/plan.ts';
import { renderPreview } from './svg/render.ts';
import { appendObservation } from './jobs/observations.ts';
import { writeHandoff } from './jobs/handoff.ts';

const exec = promisify(execFile);
const expected = { jobId: 'review:shape', attemptId: 'attempt-1', candidateHash: 'candidate', referenceHash: 'reference', canvas: { width: 32, height: 32 } };
const report = (): AgentReviewReport => ({ ...expected, reviewerModel: 'external-agent', verdict: 'pass', findings: [], verifiedRegions: ['0,0,32,32'], feedback: 'Synthetic geometry fixture, not visual quality certification',
  checks: { candidateHash: 'candidate', referenceHash: 'reference', items: Object.fromEntries(reviewItems.map(k => [k, { verdict: 'pass', detail: 'Fixed fixture geometry' }])) as AgentReviewReport['checks']['items'], regions: [{ crop: [0, 0, 32, 32], detail: 'Fixture region' }] } });

test('Agent 结构化报告保留严重缺陷、版本与禁止自行接受的校验', () => {
  const finding = { id: 'F1', rule: 'holes', severity: 'major', region: [0, 0, 5, 5], description: 'hole', evidence: 'fixture coordinates', repairInstruction: 'fill', targetStage: 'outline', status: 'open' };
  for (const update of [{ findings: [finding] }, { candidateHash: 'old' }, { findings: [{ ...finding, status: 'accepted' }] }, { checks: {} }, { verdict: 'revise' }]) {
    assert.throws(() => validateAgentReviewReport({ ...report(), ...update }, expected));
  }
  assert.equal(validateAgentReviewReport({ ...report(), verdict: 'revise', findings: [finding] }, expected).verdict, 'revise');
});

test('Agent 从 CLI 提交结构化问题；handoff 只保存路径/哈希且不放行或重置预算', async () => {
  const run = await mkdtemp(join(tmpdir(), 'img2psd-agent-handoff-'));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g id="shape" data-group-path="shape"><path d="M 4 4 H 24 V 24 H 4 Z" fill="#e89b7d" stroke="none"/></g></svg>';
  try {
    await mkdir(join(run, 'references'), { recursive: true });
    await mkdir(join(run, 'stages/outline'), { recursive: true });
    await writeFile(join(run, 'groups.json'), JSON.stringify({ version: 1, groups: [{ id: 'shape', name: 'shape', note: 'synthetic shape', kind: 'part', groups: [] }] }));
    await writeFile(join(run, 'stages/outline/shape.svg'), svg);
    await sharp(Buffer.from(svg)).png().toFile(join(run, 'references/base-subject.png'));
    const options = { maxRounds: 3, expand: false };
    let plan = await planJobs(run, options);
    const job = await materialize(plan, plan.items[0], 3);
    const dir = jobDirectory(run, 'review', 'shape');
    const preview = await renderPreview({ directory: run, reference: job.inputs.reference!, canvas: job.canvas, observationDirectory: join(dir, 'out') }, { path: job.inputs.candidate!, mode: 'blend' });
    await appendObservation(dir, { ...preview, reference: job.inputs.reference, at: new Date().toISOString() });
    const value = report();
    Object.assign(value, { jobId: job.id, candidateHash: job.review!.candidateHash, referenceHash: job.review!.referenceHash, verdict: 'revise',
      findings: [{ id: 'F1', rule: 'coverage', severity: 'major', region: [1, 1, 3, 3], description: 'Missing fixture region', evidence: 'Known fixture', repairInstruction: 'restore fixture region', targetStage: 'outline', status: 'open' }] });
    Object.assign(value.checks, { candidateHash: value.candidateHash, referenceHash: value.referenceHash });
    const file = join(dir, 'out/agent-review.json');
    await writeFile(file, JSON.stringify(value));
    const cli = new URL('../cli/main.ts', import.meta.url).pathname;
    await exec(process.execPath, [cli, 'submit', '--job', dir, '--verdict', 'revise', '--report', `@${file}`, '--feedback', 'Agent reports F1']);
    const reportPath = join(run, 'stages/review/shape.review.json');
    const before = await readFile(reportPath, 'utf8');
    assert.equal(JSON.parse(before).reviews[0].report.findings[0].id, 'F1');
    plan = await planJobs(run, options);
    assert.equal(plan.items[0].reason, 'repair');
    assert.match(plan.items[0].feedback!, /F1/);
    await writeFile(join(dir, 'out/progress.md'), 'Current required views and unresolved F1.');
    const result = await writeHandoff(dir);
    const text = await readFile(result.path, 'utf8');
    const handoff = JSON.parse(text);
    assert.ok(handoff.files.some((f: { role: string; hash?: string }) => f.role === 'reference' && f.hash));
    assert.ok(handoff.files.some((f: { role: string; available: boolean }) => f.role === 'progress' && f.available));
    assert.doesNotMatch(text, /data:image|base64,|Current required views and unresolved/);
    assert.equal(await readFile(reportPath, 'utf8'), before);
    assert.equal((await planJobs(run, options)).items[0].reason, 'repair');
    await assert.rejects(exec(process.execPath, [cli, 'review', 'run', '--job', dir]), (error: { stderr?: string }) => /由 Agent 执行/.test(error.stderr ?? ''));
  } finally { await rm(run, { recursive: true, force: true }); }
});
