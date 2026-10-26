import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { nodeKind, walkGroups, writeAtomic, type GroupNode } from '../facts/groups.ts';
import { validateGroupSvg, type Canvas } from './validate.ts';

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 每个 part 保留自己的 SVG 根、表现属性与坐标系；本地资源 ID 加前缀，避免跨部件互相绑定。
export function namespaceSvg(source: string, prefix: string): string {
  const ids = new Map([...source.matchAll(/\sid\s*=\s*(['"])(.*?)\1/g)].map(([, , id]) => [id, `${prefix}-${id}`]));
  let result = source.replace(/(\s)id\s*=\s*(['"])(.*?)\2/g, (text, space, quote, id) => `${space}id=${quote}${ids.get(id)}${quote}`)
    .replace(/url\(\s*(['"]?)#([^\s)'";]+)\1\s*\)/g, (text, quote, id) => ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : text)
    .replace(/(\s(?:xlink:)?href\s*=\s*['"])#([^'"]+)(['"])/g, (text, start, id, end) => ids.has(id) ? `${start}#${ids.get(id)}${end}` : text);
  result = result.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/g, (_text, attrs, css: string) => {
    for (const [id, replacement] of ids) css = css.replace(new RegExp(`#${escapeRegex(id)}(?=[\\s.#:\\[>+~,({])`, 'g'), `#${replacement}`);
    css = css.replace(/([^{}]+)\{([^{}]*)\}/g, (rule, selectors: string, body: string) => {
      if (selectors.trim().startsWith('@') || /^\s*(?:from|to|[\d.,%\s]+)\s*$/.test(selectors)) return rule;
      return `${selectors.split(',').map(selector => `#${prefix} ${selector.trim()}`).join(', ')}{${body}}`;
    });
    return `<style${attrs}>${css}</style>`;
  });
  result = result.replace(/<svg\b[^>]*>/, root => root.replace(/\s(?:x|y)\s*=\s*(['"]).*?\1/g, '')
    .replace(/>$/, ' x="0" y="0">'));
  return `<g id="${prefix}">${result}</g>`;
}

export type MergeContext = {
  directory: string;
  outputPath: string;
  groups: GroupNode[];
  parts: { groupId: string; path: string }[];
};
export type MergeResult = { path: string; note: string };

// 只绘制终止叶节点，按树顺序嵌套，后项在前；父组保留为逻辑容器，不重复绘制底稿。
export const mergePartSvgs = async (context: MergeContext): Promise<MergeResult> => {
  if (!context.parts.length) throw new Error('没有可合并的终止 part');
  const first = await sharp(await readFile(context.parts[0].path)).metadata();
  const canvas: Canvas = { width: first.width!, height: first.height! };
  const leaves = new Map(context.parts.map(part => [part.groupId, part]));
  const nodes = walkGroups(context.groups).map(({ group, parent }) => ({
    id: group.id, parent: parent?.id ?? null, kind: nodeKind(group),
  }));
  const nodeIds = new Map(nodes.map((node, index) => [node.id, `node-${index}`]));
  let index = 0;
  async function branch(group: GroupNode): Promise<string> {
    let content: string;
    if (group.groups.length) content = (await Promise.all(group.groups.map(branch))).join('\n');
    else {
      const part = leaves.get(group.id);
      if (!part) throw new Error(`缺少终止 part：${group.id}`);
      const prefix = `part-source-${index++}`;
      const bytes = await validateGroupSvg(part.path, group.id, canvas, undefined, true);
      const source = bytes.toString().replace(/^\s*<\?xml[^>]*>\s*/, '');
      content = namespaceSvg(source, prefix);
    }
    return `<g id="${nodeIds.get(group.id)}" data-group-path="${xml(group.id)}" data-node-kind="${nodeKind(group)}" data-name="${xml(group.name ?? group.id.split('/').at(-1)!)}">\n${content}\n</g>`;
  }
  const content = (await Promise.all(context.groups.map(branch))).join('\n');
  const metadata = xml(JSON.stringify({ version: 1, nodes }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}" data-part-preview="1">\n<metadata id="part-preview-groups">${metadata}</metadata>\n${content}\n</svg>\n`;
  await sharp(Buffer.from(svg), { limitInputPixels: 100_000_000 }).metadata();
  await writeAtomic(context.outputPath, svg);
  return { path: context.outputPath, note: `${context.parts.length} 个终止 part 按树顺序合并` };
};
