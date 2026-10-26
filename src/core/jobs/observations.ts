import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { bytesHash, svgHash } from '../facts/hash.ts';
import { writeAtomic } from '../facts/groups.ts';

export type Observation = {
  source: string;
  mode: string;
  savedPath: string;
  at: string;
  hash: string;
};

const fileOf = async (path: string) => {
  const bytes = await readFile(path);
  const hash = /\.svg$/i.test(path) ? svgHash(bytes) : bytesHash(bytes);
  return { bytes, hash };
};

export async function readObservations(jobDir: string): Promise<Observation[]> {
  const bytes = await readFile(join(jobDir, 'observations.json')).catch(() => undefined);
  if (!bytes) return [];
  const parsed = JSON.parse(bytes.toString('utf8')) as Observation[];
  return Array.isArray(parsed) ? parsed : [];
}

export async function appendObservation(jobDir: string, observation: {
  source: string; mode: string; savedPath: string; at: string;
}): Promise<void> {
  const list = await readObservations(jobDir);
  const { hash } = await fileOf(observation.source);
  list.push({ ...observation, source: await realpath(observation.source), hash });
  await writeAtomic(join(jobDir, 'observations.json'), JSON.stringify(list, null, 2) + '\n');
}

export async function clearObservations(jobDir: string): Promise<void> {
  await writeAtomic(join(jobDir, 'observations.json'), '[]\n');
}

// 执行者不能口头声明看过。观测必须对上当前文件内容；all 为真时每个 mode 都要有。
export async function assertObserved(jobDir: string, file: string, modes: string[], all = false): Promise<void> {
  const list = await readObservations(jobDir);
  const target = await realpath(resolve(file));
  const { hash } = await fileOf(target);
  const seen = (mode: string) => list.some(item => item.source === target && item.hash === hash && item.mode === mode);
  if (all) {
    const missing = modes.filter(mode => !seen(mode));
    if (missing.length) throw new Error(`提交前需要预览：${missing.join('、')}`);
    return;
  }
  if (!modes.some(seen)) throw new Error(`提交前需要预览（${modes.join(' 或 ')}）`);
}
