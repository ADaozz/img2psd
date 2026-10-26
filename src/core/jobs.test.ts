import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import sharp from 'sharp';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const runsRoot = fileURLToPath(new URL('../../.run/', import.meta.url));
const l2d = (...args: string[]) => run(process.execPath, [cli, ...args]);

const square = (left: number, group = 'face') => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">`
  + `<g id="${group}" data-group-path="${group}"><path d="M ${left} 16 H 48 V 48 H ${left} Z" fill="#e89b7d" stroke="none"/></g></svg>\n`;

// Synthetic rectangle fixtures have known geometry. Exercise the complete review
// contract; these notes assert fixture properties, not real-world visual quality.
async function passReview(jobDir: string, feedback = '固定矩形样本范围符合测试设定') {
  const job = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8'));
  const plan = job.review;
  for (const mode of ['svg', 'blend', 'edge']) await l2d('preview', '--job', jobDir, '--mode', mode);
  for (const crop of plan.regions) for (const mode of ['blend', 'edge']) {
    await l2d('preview', '--job', jobDir, '--mode', mode, '--crop', crop.join(','), '--scale', '2');
  }
  const checks = { candidateHash: plan.candidateHash, referenceHash: plan.referenceHash,
    items: Object.fromEntries(['silhouette', 'ownership', 'coverage', 'holes', 'connections', 'accessories']
      .map(key => [key, { verdict: 'pass', detail: '测试矩形的边界、填充、归属由固定输入确定' }])),
    regions: plan.regions.map((crop: number[]) => ({ crop, detail: '固定矩形无孔洞、无孤立附件' })) };
  const path = join(jobDir, 'out/test-checks.json');
  await writeFile(path, JSON.stringify(checks));
  await l2d('submit', '--job', jobDir, '--verdict', 'pass', '--checks', `@${path}`, '--feedback', feedback);
}

async function reviewCompletions(runDir: string) {
  const plan = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
  assert.ok(plan.jobs.length > 0);
  for (const job of plan.jobs) {
    assert.equal(job.kind, 'completion-review');
    await passReview(job.dir, '固定矩形补全保留了原形并符合测试设定');
  }
  return JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
}

// 驱动一层：所有绘制 job 提交后再跑 review。
async function driveOutlines(runDir: string, svgs: Record<string, string>) {
  const draw = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
  for (const job of draw.jobs.filter((item: { kind: string }) => item.kind === 'outline')) {
    await writeFile(job.draft, svgs[job.groupId]);
    await l2d('preview', '--job', job.dir, '--svg', job.draft, '--mode', 'blend');
    await l2d('submit', '--job', job.dir);
  }
  const review = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
  for (const job of review.jobs.filter((item: { kind: string }) => item.kind === 'review')) {
    await l2d('preview', '--job', job.dir, '--mode', 'blend');
    await passReview(job.dir, '可以');
  }
  return JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
}

async function makeRun(prefix: string, groups: unknown) {
  const taskRoot = join(runsRoot, `${prefix}-${process.pid}-${Date.now()}`);
  const runDir = join(taskRoot, 'part-layering');
  await mkdir(join(runDir, 'references'), { recursive: true });
  await writeFile(join(runDir, 'groups.json'), JSON.stringify({ version: 1, groups }, null, 2) + '\n');
  await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 230, g: 200, b: 190, alpha: 1 } } })
    .png().toFile(join(runDir, 'references/base-subject.png'));
  return { taskRoot, runDir };
}

test('next → 绘制 → review → 返修 → review 通过 的完整闭环', async () => {
  const taskRoot = join(runsRoot, `test-jobs-${process.pid}-${Date.now()}`);
  const run_ = join(taskRoot, 'part-layering');
  try {
    await mkdir(join(run_, 'references'), { recursive: true });
    await writeFile(join(run_, 'groups.json'), JSON.stringify({
      version: 1, subject: 'character', groups: [{ id: 'face', kind: 'group', name: 'face', groups: [] }],
    }, null, 2) + '\n');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 230, g: 200, b: 190, alpha: 1 } } })
      .png().toFile(join(run_, 'references/base-subject.png'));

    // 1. 首次派发绘制
    const first = JSON.parse((await l2d('next', '--run', run_, '--json')).stdout);
    assert.equal(first.jobs.length, 1);
    assert.equal(first.jobs[0].kind, 'outline');
    assert.equal(first.jobs[0].reason, 'draw');
    const jobDir = first.jobs[0].dir;
    const draft = first.jobs[0].draft;

    // 2. 未自检直接提交必须被拒绝
    await writeFile(draft, square(16));
    await assert.rejects(l2d('submit', '--job', jobDir), (error: { code?: number }) => error.code === 1);
    assert.equal(await readFile(join(run_, 'stages/outline/face.svg')).catch(() => null), null);

    // 3. 预览自检后提交
    await l2d('preview', '--job', jobDir, '--svg', draft, '--mode', 'blend');
    await l2d('submit', '--job', jobDir);
    assert.match((await readFile(join(run_, 'stages/outline/face.svg'))).toString(), /data-group-path="face"/);

    // 4. 派发 review，提交 revise
    const review = JSON.parse((await l2d('next', '--run', run_, '--json')).stdout);
    assert.equal(review.jobs.length, 1);
    assert.equal(review.jobs[0].kind, 'review');
    const reviewDir = review.jobs[0].dir;
    await l2d('preview', '--job', reviewDir, '--mode', 'blend');
    await l2d('submit', '--job', reviewDir, '--verdict', 'revise', '--feedback', '左缘偏移 2px');

    // 5. 派发返修，草稿预填候选
    const repair = JSON.parse((await l2d('next', '--run', run_, '--json')).stdout);
    assert.equal(repair.jobs.length, 1);
    assert.equal(repair.jobs[0].reason, 'repair');
    assert.match((await readFile(draft)).toString(), /M 16 16/);
    const instructions = await readFile(join(jobDir, 'INSTRUCTIONS.md'), 'utf8');
    assert.match(instructions, /左缘偏移 2px/);
    assert.match(instructions, /返修要求/);
    assert.match(instructions, /--job/);

    // 6. 返修后再次 review，这次通过
    await writeFile(draft, square(18));
    await l2d('preview', '--job', jobDir, '--svg', draft, '--mode', 'blend');
    await l2d('submit', '--job', jobDir);
    const secondReview = JSON.parse((await l2d('next', '--run', run_, '--json')).stdout);
    assert.equal(secondReview.jobs[0].kind, 'review');
    await l2d('preview', '--job', secondReview.jobs[0].dir, '--mode', 'edge');
    await passReview(secondReview.jobs[0].dir, '与参考一致');

    // 7. 轮廓定稿后终止节点进入补全；审查轮数与返修次数可追溯
    const done = JSON.parse((await l2d('next', '--run', run_, '--json')).stdout);
    assert.equal(done.jobs.length, 1);
    assert.equal(done.jobs[0].kind, 'completion');
    const report = JSON.parse(await readFile(join(run_, 'stages/review/face.review.json'), 'utf8'));
    assert.equal(report.reviews.length, 2);
    assert.equal(report.repairs, 1);
    assert.equal(report.reviews.at(-1).verdict, 'pass');
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('遮挡补全：只收新增闭合路径，程序合成并保留原形', async () => {
  const { taskRoot, runDir } = await makeRun('test-completion', [{ id: 'face', kind: 'group', groups: [] }]);
  try {
    // 准备：轮廓 + review pass
    const first = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    await writeFile(first.jobs[0].draft, square(16));
    await l2d('preview', '--job', first.jobs[0].dir, '--svg', first.jobs[0].draft, '--mode', 'blend');
    await l2d('submit', '--job', first.jobs[0].dir);
    const review = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    await l2d('preview', '--job', review.jobs[0].dir, '--mode', 'blend');
    await passReview(review.jobs[0].dir, '可以');

    // 补全 job
    const completion = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(completion.jobs[0].kind, 'completion');
    const jobDir = completion.jobs[0].dir;
    const draft = completion.jobs[0].draft;
    const source = await readFile(join(runDir, 'stages/outline/face.svg'));
    assert.equal((await readFile(draft)).toString(), source.toString());

    // 未设置路径就提交依据 → 拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--note', '补下缘'), (error: { code?: number }) => error.code === 1);

    // 设置新增路径：程序从只读底稿合成草稿，原形保留
    const paths = JSON.stringify([{ d: 'M 16 48 L 48 48 L 48 56 L 16 56 Z' }]);
    await l2d('submit', '--job', jobDir, '--paths', paths);
    const composed = (await readFile(draft)).toString();
    assert.match(composed, /data-completion-additions="v1"/);
    assert.ok(composed.includes(source.toString().match(/<g id="face"[\s\S]*<\/g>/)![0]));

    // 未预览 → 拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--note', '补下缘'), (error: { code?: number }) => error.code === 1);

    // 只预览独显 → 仍拒绝；独显 + blend 后通过
    await l2d('preview', '--job', jobDir, '--mode', 'svg');
    await assert.rejects(l2d('submit', '--job', jobDir, '--note', '补下缘'), (error: { code?: number }) => error.code === 1);
    await l2d('preview', '--job', jobDir, '--mode', 'blend');
    await l2d('submit', '--job', jobDir, '--note', '补下缘被遮部分');

    const published = (await readFile(join(runDir, 'parts/face.svg'))).toString();
    assert.match(published, /data-completion-additions="v1"/);
    const check = JSON.parse(await readFile(join(runDir, 'stages/completion-check/face.json'), 'utf8'));
    assert.equal(check.passed, true);
    assert.equal(check.additions, 1);
    assert.equal(check.note, '补下缘被遮部分');

    const pendingReview = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(pendingReview.jobs[0].kind, 'completion-review');
    assert.deepEqual(pendingReview.completed, []);
    await l2d('preview', '--job', pendingReview.jobs[0].dir, '--mode', 'blend');
    await l2d('submit', '--job', pendingReview.jobs[0].dir, '--verdict', 'revise', '--feedback', '测试新增下缘过长，缩至 y54');
    const repair = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(repair.jobs[0].kind, 'completion');
    assert.equal(repair.jobs[0].reason, 'repair');
    assert.match(await readFile(join(repair.jobs[0].dir, 'INSTRUCTIONS.md'), 'utf8'), /缩至 y54/);
    await l2d('submit', '--job', repair.jobs[0].dir, '--paths', JSON.stringify([{ d: 'M 16 48 H 48 V 54 H 16 Z' }]));
    await l2d('preview', '--job', repair.jobs[0].dir, '--mode', 'svg');
    await l2d('preview', '--job', repair.jobs[0].dir, '--mode', 'blend');
    await l2d('submit', '--job', repair.jobs[0].dir, '--note', '按反馈只调整了新增下缘');
    const completionReport = JSON.parse(await readFile(join(runDir, 'stages/completion-review/face.review.json'), 'utf8'));
    assert.equal(completionReport.repairs, 1);
    const done = await reviewCompletions(runDir);
    assert.deepEqual(done.completed, ['face']);
    assert.equal(done.jobs.length, 1);
    assert.equal(done.jobs[0].kind, 'occlusion');
    assert.match(await readFile(join(runDir, 'preview.svg'), 'utf8'), /data-part-preview="1"/);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('补全草稿在设置路径后被改动时拒绝提交', async () => {
  const { taskRoot, runDir } = await makeRun('test-completion-tamper', [{ id: 'face', kind: 'group', groups: [] }]);
  try {
    const first = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    await writeFile(first.jobs[0].draft, square(16));
    await l2d('preview', '--job', first.jobs[0].dir, '--svg', first.jobs[0].draft, '--mode', 'blend');
    await l2d('submit', '--job', first.jobs[0].dir);
    const review = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    await l2d('preview', '--job', review.jobs[0].dir, '--mode', 'blend');
    await passReview(review.jobs[0].dir, '可以');
    const completion = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    const jobDir = completion.jobs[0].dir;
    await l2d('submit', '--job', jobDir, '--paths', JSON.stringify([{ d: 'M 16 48 L 48 48 L 48 56 L 16 56 Z' }]));
    await writeFile(completion.jobs[0].draft, square(20));
    await l2d('preview', '--job', jobDir, '--mode', 'svg');
    await l2d('preview', '--job', jobDir, '--mode', 'blend');
    await assert.rejects(l2d('submit', '--job', jobDir, '--note', '补下缘'),
      (error: { code?: number; stderr?: string }) => error.code === 1 && /草稿在提交路径后被改动/.test(error.stderr ?? ''));
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('父组轮廓未完成时子组被阻塞', async () => {
  const taskRoot = join(runsRoot, `test-blocked-${process.pid}-${Date.now()}`);
  const run_ = join(taskRoot, 'part-layering');
  try {
    await mkdir(join(run_, 'references'), { recursive: true });
    await writeFile(join(run_, 'groups.json'), JSON.stringify({
      version: 1, groups: [{ id: 'face', kind: 'group', groups: [{ id: 'face/eye', kind: 'group', groups: [] }] }],
    }) + '\n');
    await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 1 } } })
      .png().toFile(join(run_, 'references/base-subject.png'));
    const plan = JSON.parse((await l2d('next', '--run', run_, '--json')).stdout);
    assert.deepEqual(plan.jobs.map((job: { groupId: string }) => job.groupId), ['face']);
    assert.equal(plan.blocked.length, 1);
    assert.match(plan.blocked[0].message, /深度 0 层的轮廓或 review 尚未全部完成/);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('整层去重：未提交的组按原轮廓复制，批次记录与变更组可追溯', async () => {
  const { taskRoot, runDir } = await makeRun('test-reduction', [
    { id: 'face', kind: 'group', groups: [] },
    { id: 'hair', kind: 'group', groups: [] },
  ]);
  try {
    const plan = await driveOutlines(runDir, { face: square(16), hair: square(20, 'hair') });
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0].kind, 'reduction');
    const jobDir = plan.jobs[0].dir;
    const merged = join(jobDir, 'inputs/merged.svg');
    assert.match(await readFile(merged, 'utf8'), /opacity="0.65"/);

    // 未看合成图就提交 → 拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--note', '无重复'),
      (error: { code?: number }) => error.code === 1);

    // 提交单组：文件必须在 job 目录内
    await assert.rejects(l2d('submit', '--job', jobDir, '--group', 'face', '--svg', join(runDir, 'stages/outline/face.svg')),
      (error: { code?: number }) => error.code === 1);
    await writeFile(join(jobDir, 'out/face.svg'), square(22));
    await l2d('submit', '--job', jobDir, '--group', 'face', '--svg', join(jobDir, 'out/face.svg'));

    await l2d('preview', '--job', jobDir, '--svg', merged, '--mode', 'blend');
    await l2d('submit', '--job', jobDir, '--note', 'face 与 hair 各保留自身，无跨组重复');

    const faceReduced = await readFile(join(runDir, 'stages/outline-reduce/face.svg'));
    const hairReduced = await readFile(join(runDir, 'stages/outline-reduce/hair.svg'));
    const faceOutline = await readFile(join(runDir, 'stages/outline/face.svg'));
    const hairOutline = await readFile(join(runDir, 'stages/outline/hair.svg'));
    assert.notEqual(faceReduced.toString(), faceOutline.toString());
    assert.equal(hairReduced.toString(), hairOutline.toString());

    const record = JSON.parse(await readFile(join(runDir, 'stages/outline-reduce/layers/0.json'), 'utf8'));
    assert.equal(record.depth, 0);
    assert.equal(record.groups.length, 2);
    assert.equal(record.groups.find((item: { id: string }) => item.id === 'face').changed, true);
    assert.equal(record.groups.find((item: { id: string }) => item.id === 'hair').changed, false);

    // 去重完成后才派发补全
    const after = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.deepEqual(after.jobs.map((job: { kind: string }) => job.kind), ['completion', 'completion']);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('直属拆分：程序生成 ID 并写入组树，子组随后可绘制', async () => {
  const { taskRoot, runDir } = await makeRun('test-children', [{ id: 'face', kind: 'group', groups: [] }]);
  try {
    // 完成本层：轮廓 → review → 自动去重 → 补全
    await driveOutlines(runDir, { face: square(16) });
    let plan = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(plan.jobs[0].kind, 'completion');
    const completionDir = plan.jobs[0].dir;
    await l2d('submit', '--job', completionDir, '--paths', '[]');
    await l2d('preview', '--job', completionDir, '--mode', 'svg');
    await l2d('preview', '--job', completionDir, '--mode', 'blend');
    await l2d('submit', '--job', completionDir, '--note', '无需补全');

    // 补全独立审查通过后，非 expand 模式直接进入遮挡层级规划
    plan = await reviewCompletions(runDir);
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0].kind, 'occlusion');
    assert.deepEqual(plan.completed, ['face']);

    // expand 模式派发拆分
    plan = JSON.parse((await l2d('next', '--run', runDir, '--expand', '--json')).stdout);
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0].kind, 'children');
    const jobDir = plan.jobs[0].dir;

    await assert.rejects(l2d('submit', '--job', jobDir, '--children', '[]', '--note', '终止'),
      (error: { code?: number }) => error.code === 1); // 未看图

    await l2d('preview', '--job', jobDir, '--mode', 'blend');

    // 单 part 包装与重复名称被拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--children', '[{"name":"eye","kind":"part","note":"整体"}]', '--note', '包装'),
      (error: { code?: number }) => error.code === 1);
    await assert.rejects(l2d('submit', '--job', jobDir, '--children', '[{"name":"eye","kind":"part","note":"a"},{"name":"eye","kind":"part","note":"b"}]', '--note', '重复'),
      (error: { code?: number }) => error.code === 1);

    await l2d('submit', '--job', jobDir, '--children',
      '[{"name":"eye_left","kind":"group","note":"左右眼独立控制"},{"name":"eye_right","kind":"group","note":"左右眼独立控制"}]',
      '--note', '按左右眼拆开');

    const document = JSON.parse(await readFile(join(runDir, 'groups.json'), 'utf8'));
    assert.deepEqual(document.groups[0].groups.map((node: { id: string }) => node.id), ['face/eye_left', 'face/eye_right']);
    assert.ok(document.groups[0].childrenAnalysis.sourceHash);

    // 下一层开始绘制
    plan = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.deepEqual(plan.jobs.map((job: { groupId: string }) => job.groupId), ['face/eye_left', 'face/eye_right']);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('遮挡层级规划：覆盖全部终止 part，候选叠放后逐件检查才发布', async () => {
  const { taskRoot, runDir } = await makeRun('test-occlusion', [
    { id: 'face', kind: 'group', groups: [] },
    { id: 'hair', kind: 'group', groups: [] },
  ]);
  try {
    await driveOutlines(runDir, { face: square(16), hair: square(20, 'hair') });

    // 整层去重
    let plan = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(plan.jobs[0].kind, 'reduction');
    const reductionDir = plan.jobs[0].dir;
    await l2d('preview', '--job', reductionDir, '--svg', join(reductionDir, 'inputs/merged.svg'), '--mode', 'blend');
    await l2d('submit', '--job', reductionDir, '--note', '无跨组重复');

    // 两个补全
    plan = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(plan.jobs.filter((job: { kind: string }) => job.kind === 'completion').length, 2);
    for (const job of plan.jobs) {
      await l2d('submit', '--job', job.dir, '--paths', '[]');
      await l2d('preview', '--job', job.dir, '--mode', 'svg');
      await l2d('preview', '--job', job.dir, '--mode', 'blend');
      await l2d('submit', '--job', job.dir, '--note', '无需补全');
    }

    // 补全审查通过后才自动合并 + 层级规划
    plan = await reviewCompletions(runDir);
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0].kind, 'occlusion');
    assert.ok(await readFile(join(runDir, 'preview.svg'), 'utf8'));
    const jobDir = plan.jobs[0].dir;

    // 覆盖不全被拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--levels', '[{"id":"face","level":1,"note":"最前"}]'),
      (error: { code?: number }) => error.code === 1);
    // level 重复被拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--levels',
      '[{"id":"face","level":1,"note":"a"},{"id":"hair","level":1,"note":"b"}]'),
      (error: { code?: number }) => error.code === 1);

    await l2d('submit', '--job', jobDir, '--levels',
      '[{"id":"hair","level":1,"note":"后发最靠后"},{"id":"face","level":2,"note":"脸在最前"}]');
    const candidate = join(runDir, 'stages/occlusion/candidate.svg');
    assert.match(await readFile(candidate, 'utf8'), /data-occlusion-candidate="1"/);

    // 未看候选 → 拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--checks', '{"face":"贴边正确","hair":"贴边正确"}', '--note', '逐件核对'),
      (error: { code?: number }) => error.code === 1);

    await l2d('preview', '--job', jobDir, '--svg', candidate, '--mode', 'blend');

    // 漏检一件 → 拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--checks', '{"face":"贴边正确"}', '--note', '逐件核对'),
      (error: { code?: number }) => error.code === 1);

    await l2d('submit', '--job', jobDir, '--checks', '{"face":"贴边正确","hair":"贴边正确"}', '--note', '按原图前后关系逐件核对');

    const document = JSON.parse(await readFile(join(runDir, 'occlusion.json'), 'utf8'));
    assert.equal(document.version, 3);
    assert.equal(document.direction, 'back-to-front');
    assert.equal(document.layers.length, 2);
    assert.equal(document.layers.find((item: { id: string }) => item.id === 'face').level, 2);
    assert.ok(document.sourceHash);

    const done = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(done.jobs.length, 0);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('review blocked 或返修耗尽轮数均阻塞下游，不能当作通过', async () => {
  for (const verdict of ['blocked', 'revise']) {
    const { taskRoot, runDir } = await makeRun(`test-review-gate-${verdict}`, [{ id: 'face', kind: 'group', groups: [] }]);
    try {
      let plan = JSON.parse((await l2d('next', '--run', runDir, '--review-rounds', '1', '--json')).stdout);
      await writeFile(plan.jobs[0].draft, square(16));
      await l2d('preview', '--job', plan.jobs[0].dir, '--mode', 'blend');
      await l2d('submit', '--job', plan.jobs[0].dir);
      plan = JSON.parse((await l2d('next', '--run', runDir, '--review-rounds', '1', '--json')).stdout);
      await l2d('preview', '--job', plan.jobs[0].dir, '--mode', 'blend');
      await l2d('submit', '--job', plan.jobs[0].dir, '--verdict', verdict, '--feedback', '测试明确拒绝本次候选');
      if (verdict === 'revise') {
        plan = JSON.parse((await l2d('next', '--run', runDir, '--review-rounds', '1', '--json')).stdout);
        assert.equal(plan.jobs[0].reason, 'repair');
        await writeFile(plan.jobs[0].draft, square(18));
        await l2d('preview', '--job', plan.jobs[0].dir, '--mode', 'blend');
        await l2d('submit', '--job', plan.jobs[0].dir);
      }
      plan = JSON.parse((await l2d('next', '--run', runDir, '--review-rounds', '1', '--json')).stdout);
      assert.equal(plan.jobs.length, 0);
      assert.match(plan.blocked[0].message, /review.*未.*通过|review.*无通过/);
      assert.equal(await readFile(join(runDir, 'parts/face.svg')).catch(() => null), null);
    } finally { await rm(taskRoot, { recursive: true, force: true }); }
  }
});

test('通过之后候选变化，旧 review 不能继续放行', async () => {
  const { taskRoot, runDir } = await makeRun('test-stale-review', [{ id: 'face', kind: 'group', groups: [] }]);
  try {
    await driveOutlines(runDir, { face: square(16) });
    await writeFile(join(runDir, 'stages/outline/face.svg'), square(20));
    const plan = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(plan.jobs[0].kind, 'review');
  } finally { await rm(taskRoot, { recursive: true, force: true }); }
});
