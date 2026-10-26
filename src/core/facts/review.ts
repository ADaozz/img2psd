import { readFile } from 'node:fs/promises';
import { matchesHash, svgHash } from './hash.ts';
import { writeAtomic } from './groups.ts';
import type { ReviewEvidence } from '../jobs/review-policy.ts';

export type Verdict = 'pass' | 'revise' | 'blocked';
export type ReviewEntry = {
  verdict: Verdict; feedback: string; candidateHash: string; at: string;
  referenceHash?: string; checks?: ReviewEvidence;
  attemptId?: string; reviewerModel?: string; snapshot?: string; deliverablesHash?: string;
};
export type ReviewEvent = { action: 'reopen' | 'retry'; after: number; reason: string; at: string; repairs?: number };
export type RepairRecord = { beforeHash: string; afterHash: string; note: string; at: string };
export type ReviewReport = { groupId: string; reviews: ReviewEntry[]; repairs: number; events?: ReviewEvent[]; repairHistory?: RepairRecord[] };
export type ReviewPhase = 'review' | 'repair' | 'done' | 'blocked' | 'exhausted';

export function activeReviews(report: ReviewReport): ReviewEntry[] {
  const start = report.events?.filter(event => event.action === 'retry').at(-1)?.after ?? 0;
  return report.reviews.slice(start);
}

export function qualityRounds(report: ReviewReport): number {
  return activeReviews(report).filter(entry => entry.verdict !== 'blocked').length;
}

// Only controller events reopen an interruption; neither interruption nor transport retries cost a quality round.
export function reviewPhase(report: ReviewReport, maxRounds: number, binding?: { candidateHash: string; referenceHash?: string; deliverablesHash?: string; requireChecks?: boolean }): ReviewPhase {
  const entries = activeReviews(report);
  const last = entries.at(-1);
  if (!last) return 'review';
  if (last.verdict === 'blocked') {
    const reopened = report.events?.some(event => event.after === report.reviews.length && event.action === 'reopen');
    return reopened ? (qualityRounds(report) >= maxRounds ? 'exhausted' : 'review') : 'blocked';
  }
  if (last.verdict === 'pass') {
    if (!binding || (last.candidateHash === binding.candidateHash && last.referenceHash === binding.referenceHash
      && (!binding.requireChecks || !!last.checks) && (!binding.deliverablesHash || last.deliverablesHash === binding.deliverablesHash))) return 'done';
    return qualityRounds(report) >= maxRounds ? 'exhausted' : 'review';
  }
  if (qualityRounds(report) >= maxRounds) return 'exhausted';
  const revises = entries.filter(entry => entry.verdict === 'revise').length;
  const baseline = report.events?.filter(event => event.action === 'retry').at(-1)?.repairs ?? 0;
  return report.repairs - baseline < revises ? 'repair' : 'review';
}


// 审查轮数由程序累积，重启不清零；agent 只能追加一条结论。
export async function readReviewReport(path: string, groupId: string): Promise<ReviewReport> {
  const bytes = await readFile(path).catch(() => undefined);
  if (!bytes) return { groupId, reviews: [], repairs: 0 };
  const report = JSON.parse(bytes.toString('utf8')) as Partial<ReviewReport>;
  if (report.groupId !== groupId || !Array.isArray(report.reviews)) throw new Error(`审查报告不属于当前组：${path}`);
  return { ...report, groupId, reviews: report.reviews, repairs: typeof report.repairs === 'number' ? report.repairs : 0 };
}

export async function writeReviewReport(path: string, report: ReviewReport): Promise<void> {
  await writeAtomic(path, JSON.stringify(report, null, 2) + '\n');
}

export function assertCandidateUnchanged(candidate: Buffer, expected: string): void {
  if (!matchesHash(candidate, expected)) throw new Error('候选 SVG 已变化，不能按旧候选提交结论');
}

export { svgHash };
