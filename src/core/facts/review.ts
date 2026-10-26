import { readFile } from 'node:fs/promises';
import { matchesHash, svgHash } from './hash.ts';
import { writeAtomic } from './groups.ts';

export type Verdict = 'pass' | 'revise' | 'blocked';
export type ReviewEntry = {
  verdict: Verdict; feedback: string; candidateHash: string; at: string;
};
export type ReviewReport = { groupId: string; reviews: ReviewEntry[]; repairs: number };

// 审查轮数由程序累积，重启不清零；agent 只能追加一条结论。
export async function readReviewReport(path: string, groupId: string): Promise<ReviewReport> {
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) return { groupId, reviews: [], repairs: 0 };
  const report = JSON.parse(bytes.toString('utf8')) as Partial<ReviewReport>;
  if (report.groupId !== groupId || !Array.isArray(report.reviews)) throw new Error(`审查报告不属于当前组：${path}`);
  return { groupId, reviews: report.reviews, repairs: typeof report.repairs === 'number' ? report.repairs : 0 };
}

export async function writeReviewReport(path: string, report: ReviewReport): Promise<void> {
  await writeAtomic(path, JSON.stringify(report, null, 2) + '\n');
}

export function assertCandidateUnchanged(candidate: Buffer, expected: string): void {
  if (!matchesHash(candidate, expected)) throw new Error('候选 SVG 已变化，不能按旧候选提交结论');
}

export { svgHash };
