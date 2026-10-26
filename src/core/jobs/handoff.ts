import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { bytesHash, svgHash } from '../facts/hash.ts';
import { writeAtomic } from '../facts/groups.ts';
import { readJob } from './materialize.ts';

// Only export file locations and persisted facts. No model calls, image analysis,
// Base64, session history, or implicit approval/repair-state changes.
export async function writeHandoff(jobDir: string) {
  const job = await readJob(jobDir);
  const paths: Record<string, string | undefined> = {
    instructions: join(jobDir, 'INSTRUCTIONS.md'), job: join(jobDir, 'job.json'),
    ...job.inputs, draft: job.output.draft, published: job.output.published,
    progress: join(jobDir, 'out/progress.md'), observations: join(jobDir, 'observations.json'),
    checks: join(jobDir, 'out/review-checks.json'), agentReport: join(jobDir, 'out/agent-review.json'),
    groups: join(job.run, 'groups.json'),
  };
  if (job.kind === 'review' || job.kind === 'outline') paths.reviewHistory = join(job.run, 'stages/review', `${job.groupId}.review.json`);
  if (job.kind === 'completion-review' || job.kind === 'completion') paths.reviewHistory = join(job.run, 'stages/completion-review', `${job.groupId}.review.json`);
  if (job.kind === 'raster-review' || job.kind === 'raster') paths.reviewHistory = join(job.run, job.groupId, 'review.json');
  const files = [];
  for (const [role, path] of Object.entries(paths)) {
    if (!path) continue;
    const meta = await stat(path).catch(() => undefined);
    if (!meta?.isFile()) { files.push({ role, path, available: false }); continue; }
    const bytes = await readFile(path);
    files.push({ role, path, available: true, bytes: bytes.length, hash: /\.svg$/i.test(path) ? svgHash(bytes) : bytesHash(bytes) });
  }
  const handoff = {
    version: 1, at: new Date().toISOString(), jobId: job.id, kind: job.kind, reason: job.reason,
    run: job.run, groupId: job.groupId, canvas: job.canvas, reviewRounds: job.reviewRounds, files,
    resume: [
      '在新 Agent 会话读取 instructions、job、progress 和 reviewHistory；按实际存在的文件续跑。',
      '核对候选与参考当前哈希；交接清单只说明文件版本，不是视觉检查记录或通过结论。',
      '由 Agent 使用宿主原生图片工具打开本轮必查视图；旧图文字摘要不能替代对新候选的看图。',
      '按任务包 submit；完成后按 INSTRUCTIONS.md 末尾 next 命令继续，保留原 --expand 与审核预算。',
    ],
  };
  const path = join(jobDir, 'out/handoff.json');
  await writeAtomic(path, JSON.stringify(handoff, null, 2) + '\n');
  return { path, jobId: job.id, files: files.length };
}
