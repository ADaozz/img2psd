import { readFile } from 'node:fs/promises';
import { writeAtomic } from '../facts/groups.ts';
import { outlinePath } from '../jobs/plan.ts';
import type { Canvas } from './validate.ts';

const palette = ['#ef476f', '#118ab2', '#ffd166', '#06d6a0', '#9b5de5', '#fb8500', '#4361ee', '#f15bb5'];

// 整层合成预览：每个组一种颜色，半透明叠加，供 agent 判断跨组重复。
export async function writeMergedPreview(run: string, groups: string[], canvas: Canvas, output: string): Promise<void> {
  const parts = await Promise.all(groups.map(async (id, index) => {
    const text = (await readFile(outlinePath(run, id))).toString();
    return text.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '')
      .replace(/\bfill=(['"])(?!none\1).*?\1/g, `fill="${palette[index % palette.length]}"`);
  }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">`
    + `${parts.map(part => `<g opacity="0.65">${part}</g>`).join('')}</svg>\n`;
  await writeAtomic(output, svg);
}
