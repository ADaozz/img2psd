import { reviewItems } from '../../core/jobs/review-policy.ts';
import type { ReviewEvidence } from '../../core/jobs/review-policy.ts';
import type { Canvas } from '../../core/svg/validate.ts';

export type ReviewFinding = {
  id: string; rule: typeof reviewItems[number]; severity: 'critical' | 'major' | 'minor';
  region: [number, number, number, number]; description: string; evidence: string; repairInstruction: string;
  targetStage: 'outline' | 'completion' | 'upstream' | 'raster'; status: 'open' | 'resolved' | 'accepted';
};
export type VisionReport = {
  jobId: string; attemptId: string; candidateHash: string; referenceHash: string; reviewerModel: string;
  verdict: 'pass' | 'revise' | 'blocked'; findings: ReviewFinding[]; verifiedRegions: string[];
  feedback: string; checks: ReviewEvidence;
};
const nonempty = (x: unknown): x is string => typeof x === 'string' && !!x.trim();

// Accepted exceptions require a separate human record. Models cannot grant themselves an exception.
export function validateVisionReport(value: unknown, expected: {
  jobId: string; candidateHash: string; referenceHash: string; canvas: Canvas; attemptId?: string; model?: string;
}): VisionReport {
  if (!value || typeof value !== 'object') throw new Error('审核报告必须是 JSON 对象');
  const report = value as VisionReport;
  for (const field of ['jobId', 'attemptId', 'candidateHash', 'referenceHash', 'reviewerModel', 'feedback'] as const) {
    if (!nonempty(report[field])) throw new Error(`审核报告缺少 ${field}`);
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(report.attemptId)) throw new Error('无效 attemptId');
  if (report.jobId !== expected.jobId || report.candidateHash !== expected.candidateHash || report.referenceHash !== expected.referenceHash
    || (expected.attemptId && report.attemptId !== expected.attemptId) || (expected.model && report.reviewerModel !== expected.model)) throw new Error('审核报告版本或身份不匹配');
  if (!['pass', 'revise', 'blocked'].includes(report.verdict)) throw new Error('审核 verdict 无效');
  if (!Array.isArray(report.findings) || !Array.isArray(report.verifiedRegions) || report.verifiedRegions.some(x => !nonempty(x))) throw new Error('审核缺陷或选框列表无效');
  const ids = new Set<string>();
  for (const f of report.findings) {
    if (!f || !nonempty(f.id) || ids.has(f.id) || !reviewItems.includes(f.rule)
      || !['critical', 'major', 'minor'].includes(f.severity) || !['outline', 'completion', 'upstream', 'raster'].includes(f.targetStage)
      || !['open', 'resolved'].includes(f.status) || ![f.description, f.evidence, f.repairInstruction].every(nonempty)) throw new Error('缺陷字段无效或模型试图自行接受差异');
    ids.add(f.id);
    const r = f.region;
    if (!Array.isArray(r) || r.length !== 4 || r.some(x => !Number.isSafeInteger(x) || x < 0)
      || !r[2] || !r[3] || r[0] + r[2] > expected.canvas.width || r[1] + r[3] > expected.canvas.height) throw new Error('缺陷坐标超出原图画布');
  }
  const open = report.findings.filter(f => f.status === 'open');
  if (report.verdict !== 'blocked' && open.some(f => f.targetStage === 'upstream')) throw new Error('上游结构错误必须 blocked 并请求回退');
  if (report.verdict === 'pass' && open.some(f => f.severity === 'critical' || f.severity === 'major')) throw new Error('未解决的严重缺陷不能 pass');
  if (report.verdict === 'revise' && !open.length) throw new Error('revise 必须提供具体缺陷');
  if (report.verdict !== 'blocked') {
    const checks = report.checks;
    if (!checks || checks.candidateHash !== report.candidateHash || checks.referenceHash !== report.referenceHash
      || !Array.isArray(checks.regions)) throw new Error('缺少当前版本逐项证据');
    for (const key of reviewItems) {
      const item = checks.items?.[key];
      if (!item || !['pass', 'revise'].includes(item.verdict) || !nonempty(item.detail)) throw new Error(`缺少 ${key} 审核依据`);
      if (report.verdict === 'pass' && item.verdict !== 'pass') throw new Error('逐项结论与 pass 不一致');
    }
    for (const r of checks.regions) if (!r || !nonempty(r.detail) || !Array.isArray(r.crop) || r.crop.length !== 4) throw new Error('局部证据无效');
  }
  return report;
}
