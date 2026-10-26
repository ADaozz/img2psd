import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJob, type JobRecord } from './materialize.ts';
import { readReviewReport, writeReviewReport, reviewPhase, qualityRounds } from '../facts/review.ts';

export function reviewFile(job: JobRecord): string {
  if (job.kind === 'review') return join(job.run, 'stages/review', `${job.groupId}.review.json`);
  if (job.kind === 'completion-review') return join(job.run, 'stages/completion-review', `${job.groupId}.review.json`);
  if (job.kind === 'raster-review') return join(job.run, job.groupId, 'review.json');
  throw new Error('review 命令需要 review/completion-review/raster-review job');
}

export async function reviewControl(jobDir: string, action: 'history' | 'reopen' | 'retry', reason?: string) {
  const job = await readJob(jobDir);
  const path = reviewFile(job);
  const report = await readReviewReport(path, job.groupId);
  if (action !== 'history') {
    if (!reason?.trim()) throw new Error('恢复或开启人工授权新周期需要 --reason');
    if (action === 'reopen' && reviewPhase(report, job.reviewRounds ?? 3) !== 'blocked') throw new Error('reopen 仅用于 blocked；exhausted 需要人工 review retry');
    if (action === 'retry' && reviewPhase(report, job.reviewRounds ?? 3) !== 'exhausted') throw new Error('retry 仅用于 exhausted；须由人工明确授权新周期，不能自动调用');
    report.events ??= [];
    report.events.push({ action, after: report.reviews.length, repairs: report.repairs, reason: reason.trim(), at: new Date().toISOString() });
    await writeReviewReport(path, report);
    if (job.kind === 'raster-review') await rm(join(job.run, job.groupId, '.completed'), { force: true });
  }
  return { path, phase: reviewPhase(report, job.reviewRounds ?? 3), qualityRounds: qualityRounds(report), report };
}
