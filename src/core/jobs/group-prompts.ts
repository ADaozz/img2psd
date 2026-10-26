import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { reductionPath } from './plan.ts';

const root = fileURLToPath(new URL('../../../prompts', import.meta.url));
export type GroupStage = 'outline' | 'review' | 'completion' | 'children';
export type GroupReference = { path: string; description: string; sourceSvg?: string };

// Exact ID and exact stage only. A parent's anatomical rules never leak to its
// descendants. The fallback keeps arbitrary/nonhuman group names supported.
export async function groupPrompt(id: string, stage: GroupStage, fallback: string) {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(id)) throw new Error('无效的组提示词 ID');
  const specialized = join(root, 'groups', id, `${stage}.md`);
  try { return { path: specialized, text: await readFile(specialized, 'utf8') }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const path = join(root, fallback);
    return { path, text: await readFile(path, 'utf8') };
  }
}

export async function groupReferences(id: string, stage: GroupStage, run: string, jobDir: string): Promise<GroupReference[]> {
  const configPath = join(root, 'groups', id, `${stage}.references.json`);
  let raw: unknown;
  try { raw = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(raw)) throw new Error(`参考清单须为数组：${configPath}`);
  const references: GroupReference[] = [];
  for (const item of raw) {
    if (!item || typeof item.description !== 'string' || !item.description.trim()) throw new Error(`参考缺少用途：${configPath}`);
    if (typeof item.path === 'string') {
      const path = await realpath(resolve(dirname(configPath), item.path));
      await sharp(path).metadata();
      references.push({ path, description: item.description });
    } else if (stage === 'completion' && typeof item.sibling === 'string' && /^[a-z][a-z0-9_]*$/.test(item.sibling)) {
      const sibling = `${id.slice(0, id.lastIndexOf('/'))}/${item.sibling}`;
      const sourceSvg = await realpath(reductionPath(run, sibling));
      const path = join(jobDir, 'inputs', `${item.sibling}-reference.png`);
      await sharp(sourceSvg).png().toFile(path);
      references.push({ path, description: item.description, sourceSvg });
    } else throw new Error(`无效参考项：${configPath}`);
  }
  return references;
}
