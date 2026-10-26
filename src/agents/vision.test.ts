import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { requestVision, visionConfig, VisionError } from './vision/client.ts';
import { validateVisionReport, type VisionReport } from './vision/report.ts';
import { bytesHash } from '../core/facts/hash.ts';
import { reviewItems } from '../core/jobs/review-policy.ts';

const expected = { jobId: 'review:face', attemptId: 'attempt-1', candidateHash: 'candidate', referenceHash: 'reference', canvas: { width: 32, height: 32 } };
const report = (): VisionReport => ({ ...expected, reviewerModel: 'vision-test', verdict: 'pass', findings: [], verifiedRegions: ['0,0,32,32'], feedback: 'Fixed synthetic red square',
  checks: { candidateHash: 'candidate', referenceHash: 'reference', items: Object.fromEntries(reviewItems.map(k => [k, { verdict: 'pass', detail: 'Synthetic fixture, not a quality benchmark' }])) as VisionReport['checks']['items'], regions: [{ crop: [0, 0, 32, 32], detail: 'Fixed fixture region' }] } });

test('视觉接口发送真实 PNG、多图标签与 JSON 文本请求；503 有界重试', async () => {
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'red' } }).png().toBuffer();
  const image = { id: 'candidate', bytes: png, hash: bytesHash(png) };
  let calls = 0;
  const result = await requestVision({ prompt: 'review', images: [image, { ...image, id: 'reference' }], expected }, {
    apiKey: 'secret', model: 'vision-test', baseUrl: 'https://test.invalid/v1', sleep: async () => {},
    fetch: async (url, init) => {
      assert.equal(url, 'https://test.invalid/v1/chat/completions');
      assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer secret');
      const body = JSON.parse(init!.body as string);
      assert.equal(body.response_format.type, 'json_object');
      const images = body.messages[1].content.filter((x: { type: string }) => x.type === 'image_url');
      assert.equal(images.length, 2);
      assert.equal(images[0].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
      calls++;
      return calls < 3 ? new Response('{}', { status: 503 })
        : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(report()) } }], usage: { total_tokens: 42 } });
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.report.verdict, 'pass');
  assert.equal(result.requests.length, 3);
  assert.deepEqual(result.requests[2].usage, { total_tokens: 42 });
});

test('无效 JSON、401、篡改图片和模型配置不能伪造成功', async () => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  const request = { prompt: 'review', images: [{ id: 'x', bytes: png, hash: bytesHash(png) }], expected };
  for (const status of [200, 401]) {
    let calls = 0;
    await assert.rejects(requestVision(request, { apiKey: 'secret', model: 'vision-test', sleep: async () => {}, fetch: async () => {
      calls++; return status === 200 ? Response.json({ choices: [{ message: { content: 'not JSON secret' } }] }) : new Response('secret', { status });
    } }), (e: unknown) => e instanceof VisionError && !e.message.includes('secret'));
    assert.equal(calls, status === 401 ? 1 : 3);
  }
  await assert.rejects(requestVision({ ...request, images: [{ ...request.images[0], hash: 'wrong' }] }, { apiKey: 'secret', model: 'vision-test' }), /已变化/);
  assert.throws(() => visionConfig({ APIYI_API_KEY: 'secret', L2D_REVIEW_MODEL: 'gpt-image-2.5-sunburst' }), /图片理解/);
});

test('严重缺陷、旧候选、自行接受差异及缺少证据均拒绝', () => {
  const finding = { id: 'F1', rule: 'holes', severity: 'major', region: [0, 0, 5, 5], description: 'hole', evidence: 'image', repairInstruction: 'fill', targetStage: 'outline', status: 'open' };
  for (const update of [{ findings: [finding] }, { candidateHash: 'old' }, { findings: [{ ...finding, status: 'accepted' }] }, { checks: {} }, { verdict: 'revise' }]) {
    assert.throws(() => validateVisionReport({ ...report(), ...update }, expected));
  }
  assert.equal(validateVisionReport({ ...report(), verdict: 'revise', findings: [finding] }, expected).verdict, 'revise');
});
