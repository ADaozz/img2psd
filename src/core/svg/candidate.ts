import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { writeAtomic } from '../facts/groups.ts';
import { namespaceSvg } from './merge.ts';
import type { Canvas } from './validate.ts';

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export type DepthEntry = { id: string; level: number; path: string };

// 候选叠放预览：按深度从后到前，每个 part 只叠一次，供 agent 逐件核对。
export async function writeCandidatePreview(
  entries: DepthEntry[], canvas: Canvas, output: string,
): Promise<{ parts: number; levels: number[] }> {
  const sorted = [...entries].sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  const content: string[] = [];
  for (const [index, entry] of sorted.entries()) {
    const source = (await readFile(entry.path)).toString().replace(/^\s*<\?xml[^>]*>\s*/, '');
    content.push(`<g data-group-path="${xml(entry.id)}" data-occlusion-level="${entry.level}">`
      + `${namespaceSvg(source, `occlusion-part-${index}`)}</g>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" `
    + `width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" data-occlusion-candidate="1">\n`
    + `${content.join('\n')}\n</svg>\n`;
  await sharp(Buffer.from(svg), { limitInputPixels: 100_000_000 }).metadata();
  await writeAtomic(output, svg);
  return { parts: sorted.length, levels: sorted.map(entry => entry.level) };
}
