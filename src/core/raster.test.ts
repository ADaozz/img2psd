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

const kra = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(64, 7)]);
const config = {
  pipeline: 'raster-layering',
  upstream: '../part-layering',
  steps: [
    { id: 'step01', title: '分层与补全', prompt: '01-分层与补全.md', required: ['character-depth.kra', 'report.md'] },
    { id: 'step02', title: '边缘柔化', prompt: '02-边缘柔化与去锯齿.md',
      inputs: ['step01/character-depth.kra', 'step01/report.md'],
      required: ['character-soft-edges.kra', 'character-soft-edges.png', 'report.md'] },
  ],
};

async function makeTask(prefix: string) {
  const taskRoot = join(runsRoot, `${prefix}-${process.pid}-${Date.now()}`);
  const part = join(taskRoot, 'part-layering');
  const raster = join(taskRoot, 'raster-layering');
  await mkdir(join(part, 'parts'), { recursive: true });
  await mkdir(join(part, 'references'), { recursive: true });
  await mkdir(raster, { recursive: true });
  await writeFile(join(part, 'groups.json'), JSON.stringify({ version: 1, groups: [{ id: 'face', kind: 'part', groups: [] }] }) + '\n');
  await writeFile(join(part, 'occlusion.json'), JSON.stringify({ version: 3, direction: 'back-to-front', layers: [] }) + '\n');
  await writeFile(join(part, 'parts/face.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  await sharp({ create: { width: 32, height: 40, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
    .png().toFile(join(part, 'references/base-subject.png'));
  await writeFile(join(raster, 'raster.json'), JSON.stringify(config, null, 2) + '\n');
  return { taskRoot, raster, part };
}

test('栅格管线：按步骤推进，交付校验后写完成标记', async () => {
  const { taskRoot, raster } = await makeTask('test-raster');
  try {
    let plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0].kind, 'raster');
    assert.equal(plan.jobs[0].groupId, 'step01');
    const step01 = plan.jobs[0].dir;
    assert.match(await readFile(join(step01, 'INSTRUCTIONS.md'), 'utf8'), /产出到 .*step01/);

    // 未产出文件 → 拒绝
    await assert.rejects(l2d('submit', '--job', step01, '--note', '完成'), (error: { code?: number }) => error.code === 1);
    await mkdir(join(raster, 'step01'), { recursive: true });
    await writeFile(join(raster, 'step01/character-depth.kra'), kra);
    await assert.rejects(l2d('submit', '--job', step01, '--note', '完成'), (error: { code?: number }) => error.code === 1);
    await writeFile(join(raster, 'step01/report.md'), '# 报告\n\n分层完成\n');
    await l2d('submit', '--job', step01, '--note', '分层与补全完成');

    const marker = JSON.parse(await readFile(join(raster, 'step01/.completed'), 'utf8'));
    assert.equal(marker.step, 'step01');
    assert.equal(marker.files.length, 2);

    // 下一步：step02
    plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    assert.deepEqual(plan.completed, ['step01']);
    assert.equal(plan.jobs[0].groupId, 'step02');
    const step02 = plan.jobs[0].dir;

    // KRA 魔数错误 → 拒绝
    await mkdir(join(raster, 'step02'), { recursive: true });
    await writeFile(join(raster, 'step02/character-soft-edges.kra'), Buffer.from('not a zip'));
    await writeFile(join(raster, 'step02/report.md'), '# 报告\n');
    await writeFile(join(raster, 'step02/character-soft-edges.png'),
      await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer());
    await assert.rejects(l2d('submit', '--job', step02, '--note', '完成'),
      (error: { code?: number; stderr?: string }) => error.code === 1 && /KRA/.test(error.stderr ?? ''));

    await writeFile(join(raster, 'step02/character-soft-edges.kra'), kra);
    await l2d('submit', '--job', step02, '--note', '柔化完成');

    plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    assert.deepEqual(plan.completed, ['step01', 'step02']);
    assert.equal(plan.jobs.length, 0);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('栅格管线：上游缺 occlusion.json 时阻塞', async () => {
  const { taskRoot, raster, part } = await makeTask('test-raster-blocked');
  try {
    await rm(join(part, 'occlusion.json'));
    const plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    assert.equal(plan.jobs.length, 0);
    assert.match(plan.blocked[0].message, /occlusion\.json/);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('栅格 review：绘制 → review(revise) → 返修 → review(pass) 后写完成标记', async () => {
  const taskRoot = join(runsRoot, `test-raster-review-${process.pid}-${Date.now()}`);
  const raster = join(taskRoot, 'raster-layering');
  const part = join(taskRoot, 'part-layering');
  try {
    await mkdir(join(part, 'parts'), { recursive: true });
    await mkdir(join(part, 'references'), { recursive: true });
    await mkdir(raster, { recursive: true });
    await writeFile(join(part, 'groups.json'), JSON.stringify({ version: 1, groups: [] }) + '\n');
    await writeFile(join(part, 'occlusion.json'), '{"version":3,"direction":"back-to-front","layers":[]}\n');
    await writeFile(join(part, 'parts/face.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 5, g: 6, b: 7, alpha: 1 } } })
      .png().toFile(join(part, 'references/base-subject.png'));
    await writeFile(join(raster, 'raster.json'), JSON.stringify({
      pipeline: 'raster-layering', upstream: '../part-layering',
      steps: [
        { id: 'step01', title: '分层', prompt: '01-分层与补全.md', required: ['character-depth.kra', 'report.md'] },
        { id: 'step02', title: '柔化', prompt: '02-边缘柔化与去锯齿.md',
          inputs: ['step01/character-depth.kra'], required: ['character-soft-edges.kra', 'character-soft-edges.png', 'report.md'],
          review: { prompt: '02-review.md', repairPrompt: '02-repair.md', maxRounds: 2 } },
      ],
    }, null, 2) + '\n');

    // step01 完成
    let plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    const step01 = plan.jobs[0].dir;
    await mkdir(join(raster, 'step01'), { recursive: true });
    await writeFile(join(raster, 'step01/character-depth.kra'), kra);
    await writeFile(join(raster, 'step01/report.md'), '# 报告\n');
    await l2d('submit', '--job', step01, '--note', '分层完成');

    // step02 绘制 → .drawn，不直接完成
    plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    assert.equal(plan.jobs[0].groupId, 'step02');
    const draw = plan.jobs[0].dir;
    await mkdir(join(raster, 'step02'), { recursive: true });
    await writeFile(join(raster, 'step02/character-soft-edges.kra'), kra);
    await writeFile(join(raster, 'step02/report.md'), '# 报告\n');
    await writeFile(join(raster, 'step02/character-soft-edges.png'),
      await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } }).png().toBuffer());
    await l2d('submit', '--job', draw, '--note', '柔化完成');
    assert.ok(await readFile(join(raster, 'step02/.drawn'), 'utf8'));

    // review 1：revise
    plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    assert.equal(plan.jobs[0].kind, 'raster-review');
    const review1 = plan.jobs[0].dir;
    assert.match(await readFile(join(review1, 'INSTRUCTIONS.md'), 'utf8'), /独立视觉 review/);
    await assert.rejects(l2d('submit', '--job', review1, '--verdict', 'revise', '--feedback', '边缘有白边'),
      (error: { code?: number }) => error.code === 1);
    await l2d('preview', '--job', review1, '--mode', 'blend');
    await l2d('submit', '--job', review1, '--verdict', 'revise', '--feedback', '边缘有白边');

    // 返修
    plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    assert.equal(plan.jobs[0].kind, 'raster');
    assert.equal(plan.jobs[0].reason, 'raster');
    assert.match(await readFile(join(plan.jobs[0].dir, 'INSTRUCTIONS.md'), 'utf8'), /边缘有白边/);
    assert.match(await readFile(join(plan.jobs[0].dir, 'INSTRUCTIONS.md'), 'utf8'), /请继续修复第二步工程/);
    await l2d('submit', '--job', plan.jobs[0].dir, '--note', '已重画边缘');
    const report = JSON.parse(await readFile(join(raster, 'step02/review.json'), 'utf8'));
    assert.equal(report.repairs, 1);

    // review 2：pass → .completed
    plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    assert.equal(plan.jobs[0].kind, 'raster-review');
    await l2d('preview', '--job', plan.jobs[0].dir, '--mode', 'blend');
    await l2d('submit', '--job', plan.jobs[0].dir, '--verdict', 'pass', '--feedback', '边缘干净');
    const marker = JSON.parse(await readFile(join(raster, 'step02/.completed'), 'utf8'));
    assert.equal(marker.outcome, 'pass');
    assert.equal(marker.rounds, 2);

    plan = JSON.parse((await l2d('next', '--run', raster, '--json')).stdout);
    assert.equal(plan.jobs.length, 0);
    assert.deepEqual(plan.completed, ['step01', 'step02']);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});
