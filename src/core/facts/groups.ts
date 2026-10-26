import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type GroupNode = {
  id: string;
  kind?: 'group' | 'part';
  name?: string;
  note?: string;
  metadata?: Record<string, unknown>;
  childrenAnalysis?: { sourceHash: string; note?: string };
  groups: GroupNode[];
  steps?: { children?: { status?: string } };
};

// 先写临时文件再改名：中断不会留下半个正式产物。
export async function writeAtomic(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function walkGroups(groups: GroupNode[], depth = 0, parent?: GroupNode): {
  group: GroupNode; depth: number; parent?: GroupNode;
}[] {
  return groups.flatMap(group => [
    { group, depth, parent }, ...walkGroups(group.groups, depth + 1, group),
  ]);
}

// 树只表示包含关系；终止节点可以是显式 part，也可以是已分析过子节点且为空。
export function nodeKind(group: GroupNode): 'group' | 'part' {
  return group.kind === 'part' || (group.steps?.children?.status === 'completed' && !group.groups.length)
    ? 'part' : 'group';
}

export function normalizeTree(value: unknown): GroupNode[] {
  if (!Array.isArray(value)) throw new Error('groups 必须是数组');
  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('节点必须是对象');
    const node = raw as Record<string, unknown>;
    if (typeof node.id !== 'string' || !node.id.trim()) throw new Error('节点缺少 id');
    const kind = node.kind === 'part' || node.kind === 'group' ? node.kind : undefined;
    return {
      id: node.id,
      ...(kind ? { kind } : {}),
      ...(typeof node.name === 'string' ? { name: node.name } : {}),
      ...(typeof node.note === 'string' ? { note: node.note } : {}),
      ...(node.metadata && typeof node.metadata === 'object' ? { metadata: node.metadata as Record<string, unknown> } : {}),
      ...(node.childrenAnalysis && typeof node.childrenAnalysis === 'object'
        ? { childrenAnalysis: node.childrenAnalysis as { sourceHash: string; note?: string } } : {}),
      groups: normalizeTree(node.groups ?? []),
    };
  });
}
