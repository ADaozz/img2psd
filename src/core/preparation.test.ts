import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import sharp from 'sharp';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
const runsRoot = fileURLToPath(new URL('../../.run/', import.meta.url));
const l2d = (...args: string[]) => run(process.execPath, [cli, ...args]);

const size = { width: 48, height: 64 };
const original = () => sharp({ create: { ...size, channels: 4, background: { r: 230, g: 200, b: 190, alpha: 1 } } })
  .png().toBuffer();

// 生成一张中间透明、四周不透明的图，模拟“透明背景的角色”。
async function transparentSubject(width = size.width, height = size.height) {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inside = x > width * 0.25 && x < width * 0.75 && y > height * 0.1 && y < height * 0.9;
      raw[i] = 120; raw[i + 1] = 160; raw[i + 2] = 220; raw[i + 3] = inside ? 255 : 0;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function makeTask(prefix: string) {
  const taskRoot = join(runsRoot, `${prefix}-${process.pid}-${Date.now()}`);
  const runDir = join(taskRoot, 'part-layering');
  await mkdir(join(runDir, 'input'), { recursive: true });
  await mkdir(join(runDir, 'references'), { recursive: true });
  await writeFile(join(runDir, 'groups.json'), JSON.stringify({
    version: 1, groups: [{ id: 'face', kind: 'group', groups: [] }],
  }) + '\n');
  await writeFile(join(runDir, 'input/original.png'), await original());
  return { taskRoot, runDir };
}

test('参考准备：缺素体参考时先派发 preparation，提交后进入轮廓绘制', async () => {
  const { taskRoot, runDir } = await makeTask('test-preparation');
  try {
    const first = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(first.jobs.length, 1);
    assert.equal(first.jobs[0].kind, 'preparation');
    assert.deepEqual(first.canvas, size);
    const jobDir = first.jobs[0].dir;
    const instructions = await readFile(join(jobDir, 'INSTRUCTIONS.md'), 'utf8');
    assert.match(instructions, /是否需要简化/);
    assert.match(instructions, /素体换装/);
    assert.match(instructions, /--background transparent/);
    assert.match(instructions, /Alpha 透明通道/);
    assert.doesNotMatch(instructions, /--matte|qwen/);

    // 模拟执行者：不需要简化 → 直接复制；换装产物用透明背景图代替
    await writeFile(join(runDir, 'references/simplified-subject.png'), await readFile(join(runDir, 'input/original.png')));
    await assert.rejects(l2d('submit', '--job', jobDir), (error: { code?: number }) => error.code === 1);

    // 尺寸不符 → 拒绝
    await writeFile(join(runDir, 'references/base-subject.png'), await transparentSubject(32, 32));
    await assert.rejects(l2d('submit', '--job', jobDir, '--note', '换装完成'), (error: { code?: number }) => error.code === 1);

    // 不透明 → 拒绝
    await writeFile(join(runDir, 'references/base-subject.png'), await original());
    await assert.rejects(l2d('submit', '--job', jobDir, '--note', '换装完成'),
      (error: { code?: number; stderr?: string }) => error.code === 1 && /透明面积/.test(error.stderr ?? ''));

    await writeFile(join(runDir, 'references/base-subject.png'), await transparentSubject());
    await l2d('submit', '--job', jobDir, '--note', '画风已足够简洁，未简化；白色连体服换装完成');

    const preparation = JSON.parse(await readFile(join(runDir, 'references/preparation.json'), 'utf8'));
    assert.equal(preparation.version, 1);
    assert.equal(preparation.simplifiedKept, true);
    assert.equal(preparation.canvas.width, size.width);
    assert.ok(preparation.hashes.baseSubject);

    const after = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.deepEqual(after.jobs.map((job: { kind: string }) => job.kind), ['outline']);
    assert.equal(after.jobs[0].groupId, 'face');
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('参考准备：缺原图时报阻塞，不派发其他步骤', async () => {
  const taskRoot = join(runsRoot, `test-preparation-blocked-${process.pid}-${Date.now()}`);
  const runDir = join(taskRoot, 'part-layering');
  try {
    await mkdir(join(runDir, 'references'), { recursive: true });
    await writeFile(join(runDir, 'groups.json'), JSON.stringify({ version: 1, groups: [] }) + '\n');
    await assert.rejects(l2d('next', '--run', runDir, '--json'), (error: { code?: number }) => error.code === 1);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});

test('初始分组：组树为空时派发，提交后写 groups.json 并进入绘制', async () => {
  const taskRoot = join(runsRoot, `test-grouping-${process.pid}-${Date.now()}`);
  const runDir = join(taskRoot, 'part-layering');
  try {
    await mkdir(join(runDir, 'references'), { recursive: true });
    await writeFile(join(runDir, 'groups.json'), JSON.stringify({ version: 1, groups: [] }) + '\n');
    await sharp({ create: { ...size, channels: 4, background: { r: 200, g: 180, b: 170, alpha: 1 } } })
      .png().toFile(join(runDir, 'references/base-subject.png'));

    const first = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.equal(first.jobs.length, 1);
    assert.equal(first.jobs[0].kind, 'grouping');
    const jobDir = first.jobs[0].dir;

    // 未看图 → 拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--groups', '[{"name":"face","note":"脸部"}]'),
      (error: { code?: number }) => error.code === 1);

    await l2d('preview', '--job', jobDir, '--mode', 'blend');

    // 非法 name / 重复 → 拒绝
    await assert.rejects(l2d('submit', '--job', jobDir, '--groups', '[{"name":"Face","note":"x"}]'),
      (error: { code?: number }) => error.code === 1);
    await assert.rejects(l2d('submit', '--job', jobDir, '--groups',
      '[{"name":"face","note":"a"},{"name":"face","note":"b"}]'), (error: { code?: number }) => error.code === 1);

    await l2d('submit', '--job', jobDir, '--groups',
      '[{"name":"face","note":"脸型与五官"},{"name":"hair","note":"全部头发"}]', '--subject', 'character');

    const document = JSON.parse(await readFile(join(runDir, 'groups.json'), 'utf8'));
    assert.deepEqual(document.groups.map((group: { id: string }) => group.id), ['face', 'hair']);
    assert.equal(document.subject, 'character');

    const after = JSON.parse((await l2d('next', '--run', runDir, '--json')).stdout);
    assert.deepEqual(after.jobs.map((job: { kind: string }) => job.kind), ['outline', 'outline']);
  } finally {
    await rm(taskRoot, { recursive: true, force: true });
  }
});


test('任务包：带空格和单引号的真实命令可从其他目录执行，保持续跑参数', async () => {
  const { taskRoot, runDir } = await makeTask("test-instructions space'quote");
  const generated = await transparentSubject();
  const requests: { url?: string; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, body });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.includes(':generateContent')
        ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: generated.toString('base64') } }] } }] }
        : { data: [{ b64_json: generated.toString('base64') }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env = { ...process.env, L2D_NO_DOTENV: '1', APIYI_API_KEY: 'test-instruction-key',
    APIYI_BASE_URL: `http://127.0.0.1:${address.port}` };
  const execute = (command: string) => run('/bin/sh', ['-c', command], { cwd: tmpdir(), env });
  try {
    const first = JSON.parse((await l2d('next', '--run', runDir, '--review-rounds', '3', '--expand', '--json')).stdout);
    const text = await readFile(first.jobs[0].instructions, 'utf8');
    const commandLines = text.split('\n').filter(line => line.startsWith('node '));
    const dryRuns = commandLines.filter(line => line.includes(' imagegen ') && line.includes('--dry-run'));
    const generations = commandLines.filter(line => line.includes(' imagegen ') && !line.includes('--dry-run'));
    assert.equal(dryRuns.length, 2);
    assert.equal(generations.length, 2);
    const simplifyPreview = JSON.parse((await execute(dryRuns[0])).stdout);
    assert.equal(simplifyPreview.model, 'gemini-nano-banana-2.1');
    assert.equal(requests.length, 0);
    await execute(generations[0]);
    const bodyPreview = JSON.parse((await execute(dryRuns[1])).stdout);
    assert.equal(bodyPreview.model, 'gpt-image-2.5-sunburst');
    assert.equal(requests.length, 1);
    await execute(generations[1]);
    assert.equal(requests.length, 2);
    assert.match(requests[1].body, /name="background"\r\n\r\ntransparent/);
    await execute(commandLines.find(line => line.includes(' submit '))!);
    const continuation = commandLines.find(line => line.includes(' next '))!;
    assert.match(continuation, /--review-rounds 3 --expand --json$/);
    const next = JSON.parse((await execute(continuation)).stdout);
    assert.equal(next.jobs[0].kind, 'outline');
    const outline = await readFile(next.jobs[0].instructions, 'utf8');
    assert.match(outline, /--mode svg/);
    assert.match(outline, /--mode blend/);
    assert.match(outline, /--mode edge/);
    assert.match(outline, /当前节点：face/);
    assert.doesNotMatch(outline, /update_group_note|image_generation/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(taskRoot, { recursive: true, force: true });
  }
});
