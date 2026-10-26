import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkParentBounds, validateGroupSvg } from './svg/validate.ts';
import { assertCompletionPreserves, composeCompletion } from './svg/completion.ts';

const run = promisify(execFile);
const canvas = { width: 10, height: 10 };
const svg = (inner: string, viewBox = '0 0 10 10') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="${viewBox}">${inner}</svg>`;
const square = (x: number, y: number, size = 6) =>
  `<g id="g" data-group-path="face"><path d="M ${x} ${y} h ${size} v ${size} h -${size} Z" fill="#111" stroke="none"/></g>`;

async function stage(name: string, content: string) {
  const directory = await mkdtemp(join(tmpdir(), 'l2d-'));
  const path = join(directory, `${name}.svg`);
  await writeFile(path, content);
  return path;
}

test('合法组 SVG 通过，绑定与画布错误被拒绝', async () => {
  const ok = await stage('ok', svg(square(1, 1)));
  await validateGroupSvg(ok, 'face', canvas);

  const wrongGroup = await stage('wrong-group', svg(square(1, 1).replace('data-group-path="face"', 'data-group-path="hair"')));
  await assert.rejects(validateGroupSvg(wrongGroup, 'face', canvas), /data-group-path/);

  const wrongViewBox = await stage('wrong-viewbox', svg(square(1, 1), '0 0 20 20'));
  await assert.rejects(validateGroupSvg(wrongViewBox, 'face', canvas), /viewBox/);

  const raster = await stage('raster', svg(`${square(1, 1)}<image href="x.png" width="10" height="10"/>`));
  await assert.rejects(validateGroupSvg(raster, 'face', canvas), /可编辑矢量/);

  const empty = await stage('empty', svg('<g id="g" data-group-path="face"></g>'));
  await assert.rejects(validateGroupSvg(empty, 'face', canvas), /可见填色/);
  await validateGroupSvg(empty, 'face', canvas, undefined, true);
});

test('子组超出父范围会被判失败，贴合共边通过', async () => {
  const parent = await stage('parent', svg(square(1, 1, 8)));
  const inside = await stage('inside', svg(square(1, 1, 8)));
  const outside = await stage('outside', svg(square(6, 6, 4)));
  assert.equal((await checkParentBounds(inside, parent, canvas)).status, 'pass');
  const failed = await checkParentBounds(outside, parent, canvas);
  assert.equal(failed.status, 'fail');
  assert.ok(failed.outsideSamples > 0);
  await assert.rejects(validateGroupSvg(outside, 'face', canvas, parent), /超出父轮廓/);
});

test('补全只增加路径并保留原正文', async () => {
  const source = svg(square(1, 1));
  const composed = composeCompletion(source, [{ d: 'M 0 0 L 5 0 L 5 5 Z' }]);
  assert.equal(assertCompletionPreserves(source, composed), 1);
  assert.ok(composed.includes(source.match(/<g id="g"[\s\S]*<\/g>/)![0]));

  assert.throws(() => composeCompletion(source, [{ d: 'M 0 0 L 5 0' }]), /封闭路径/);
  assert.throws(() => composeCompletion(source, [{ d: 'M 0 0 Z', fill: 'red' }]), /封闭路径/);
  const tampered = composed.replace('fill="#111"', 'fill="#222"');
  assert.throws(() => assertCompletionPreserves(source, tampered), /改变了已有 SVG/);
});

test('CLI 帮助与未知命令的退出码', async () => {
  const cli = new URL('../cli/main.ts', import.meta.url).pathname;
  const help = await run(process.execPath, [cli, 'help']);
  assert.match(help.stdout, /live2d-portable/);
  await assert.rejects(run(process.execPath, [cli, 'nope']), (error: { code?: number }) => error.code === 2);
});
