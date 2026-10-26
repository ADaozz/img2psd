import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../cli/main.ts', import.meta.url));

test('matte：去掉连通的白背景，保留内部同色区域并生成软边', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'l2d-matte-'));
  try {
    // 白底 + 黑色圆环 + 环内白色孤岛（不该被去掉）
    const size = 60;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">`
      + `<rect width="${size}" height="${size}" fill="#ffffff"/>`
      + `<circle cx="30" cy="30" r="20" fill="#333333"/>`
      + `<circle cx="30" cy="30" r="8" fill="#ffffff"/>`
      + `</svg>`;
    const input = join(directory, 'in.png');
    const output = join(directory, 'out.png');
    await sharp(Buffer.from(svg)).png().toFile(input);

    await run(process.execPath, [cli, 'matte', '--in', input, '--out', output, '--feather', '1']);

    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    assert.equal(alphaAt(2, 2), 0, '四角背景应透明');
    assert.equal(alphaAt(30, 14), 255, '圆环应保持不透明');
    assert.equal(alphaAt(30, 30), 255, '环内白色孤岛不应被去掉');

    let semi = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && data[i] < 255) semi++;
    assert.ok(semi > 0, '软边应存在半透明像素');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
