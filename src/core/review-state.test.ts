import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPhase, qualityRounds, type ReviewReport, type ReviewEntry } from './facts/review.ts';

const entry = (verdict: ReviewEntry['verdict']): ReviewEntry => ({ verdict, candidateHash: 'a', referenceHash: 'b', feedback: 'test', at: new Date().toISOString() });
test('三审两修，最后 revise 进入 exhausted，不能派发第三次返修', () => {
  const report: ReviewReport = { groupId: 'face', reviews: [], repairs: 0 };
  assert.equal(reviewPhase(report, 3), 'review');
  for (let n = 1; n <= 3; n++) {
    report.reviews.push(entry('revise'));
    assert.equal(reviewPhase(report, 3), n < 3 ? 'repair' : 'exhausted');
    if (n < 3) { report.repairs++; assert.equal(reviewPhase(report, 3), 'review'); }
  }
  assert.equal(qualityRounds(report), 3);
  report.events = [{ action: 'retry', after: 3, repairs: 2, reason: 'human authorized', at: new Date().toISOString() }];
  assert.equal(reviewPhase(report, 3), 'review');
  assert.equal(qualityRounds(report), 0);
  report.reviews.push(entry('revise'));
  assert.equal(reviewPhase(report, 3), 'repair');
  report.repairs++;
  assert.equal(reviewPhase(report, 3), 'review');
});

test('blocked 不占质量预算，显式 reopen 后恢复；旧 pass 绑定失效', () => {
  const report: ReviewReport = { groupId: 'face', reviews: [entry('blocked')], repairs: 0 };
  assert.equal(reviewPhase(report, 3), 'blocked');
  assert.equal(qualityRounds(report), 0);
  report.events = [{ action: 'reopen', after: 1, reason: 'fixed network', at: new Date().toISOString() }];
  assert.equal(reviewPhase(report, 3), 'review');
  report.reviews.push(entry('pass'));
  assert.equal(reviewPhase(report, 3, { candidateHash: 'a', referenceHash: 'b' }), 'done');
  assert.equal(reviewPhase(report, 3, { candidateHash: 'new', referenceHash: 'b' }), 'review');
  assert.equal(reviewPhase(report, 1, { candidateHash: 'new', referenceHash: 'b' }), 'exhausted');
});
