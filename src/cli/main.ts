#!/usr/bin/env node
// 唯一 agent 接口：任何能跑 shell 的执行者都通过这里读 job、渲染预览、提交产物。
// 本文件及其依赖不引用 Codex；只有 src/agents/codex.ts 才允许，且仅作可选的生图/放大后端。
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../config/env.ts';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { checkParentBounds, validateGroupSvg, type Canvas } from '../core/svg/validate.ts';
import { renderPreview, type PreviewMode } from '../core/svg/render.ts';
import { assertCompletionPreserves } from '../core/svg/completion.ts';
import { mergePartSvgs } from '../core/svg/merge.ts';
import { nodeKind, normalizeTree, walkGroups, type GroupNode } from '../core/facts/groups.ts';
import { jobDirectory, planJobs } from '../core/jobs/plan.ts';
import { materialize, readJob } from '../core/jobs/materialize.ts';
import { appendObservation } from '../core/jobs/observations.ts';
import { submit as submitJob } from '../core/jobs/submit.ts';
import { imageGenerate, upscale as upscaleImage, canonicalModel, previewApiyi, providerForModel, resolveBackendName, taskModel } from '../agents/image.ts';
import { loadRasterConfig, upstreamDirectory } from '../core/raster/config.ts';

const stages = ['outline', 'review', 'reduction', 'completion', 'completionCheck'] as const;
type Stage = typeof stages[number];

function canvasOf(value: string | undefined): Canvas | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d+)x(\d+)$/i);
  if (!match) throw new Error('--canvas 须为 <宽>x<高>，例如 1024x1536');
  return { width: Number(match[1]), height: Number(match[2]) };
}

async function canvasFromReference(reference: string): Promise<Canvas> {
  const metadata = await sharp(reference).metadata();
  return { width: metadata.autoOrient.width, height: metadata.autoOrient.height };
}

async function loadGroups(run: string): Promise<GroupNode[]> {
  const document = JSON.parse(await readFile(join(run, 'groups.json'), 'utf8')) as { groups?: unknown };
  return normalizeTree(document.groups ?? []);
}

const exists = async (path: string) => readFile(path).then(() => true, () => false);
const artifact = (run: string, stage: string, id: string) => {
  if (stage === 'outline') return join(run, 'stages/outline', `${id}.svg`);
  if (stage === 'reduction') return join(run, 'stages/outline-reduce', `${id}.svg`);
  if (stage === 'completion') return join(run, 'parts', `${id}.svg`);
  if (stage === 'review') return join(run, 'stages/review', `${id}.review.json`);
  if (stage === 'completionCheck') return join(run, 'stages/completion-check', `${id}.json`);
  throw new Error(`未知阶段：${stage}`);
};

async function status(args: string[]) {
  const { values } = parseArgs({ args, options: { run: { type: 'string' }, json: { type: 'boolean' } } });
  if (!values.run) throw new Error('status 需要 --run <part-layering 目录>');
  const run = resolve(values.run);
  // 栅格目录：按步骤标记汇总，不读 groups.json。
  if (await readFile(join(run, 'raster.json')).then(() => true, () => false)) {
    const config = await loadRasterConfig(run);
    const upstream = upstreamDirectory(run, config);
    const steps = [];
    for (const step of config.steps) {
      const done = await readFile(join(run, step.id, '.completed')).then(() => true, () => false);
      steps.push({ step: step.id, title: step.title, completed: done, required: step.required });
    }
    const summary = { pipeline: config.pipeline, upstream, steps,
      completed: steps.filter(step => step.completed).length, total: steps.length };
    if (values.json) { console.log(JSON.stringify(summary, null, 2)); return 0; }
    console.log(`栅格管线：${config.pipeline}`);
    console.log(`上游：${upstream}`);
    console.log(`进度：${summary.completed}/${summary.total}`);
    for (const step of steps) console.log(`  ${step.completed ? '✓' : '·'} ${step.step} ${step.title}（${step.required.join('、')}）`);
    return 0;
  }
  const groups = await loadGroups(run);
  const entries = walkGroups(groups);
  const byDepth: Record<number, number> = {};
  const counts: Record<Stage, number> = { outline: 0, review: 0, reduction: 0, completion: 0, completionCheck: 0 };
  const missingCompletion: string[] = [];
  const verdicts: Record<string, number> = {};
  for (const { group, depth } of entries) {
    byDepth[depth] = (byDepth[depth] ?? 0) + 1;
    for (const stage of stages) {
      if (await exists(artifact(run, stage, group.id))) {
        counts[stage]++;
        if (stage === 'review') {
          const report = JSON.parse(await readFile(artifact(run, stage, group.id), 'utf8')) as { reviews?: { verdict?: string }[] };
          for (const review of report.reviews ?? []) verdicts[review.verdict ?? '?'] = (verdicts[review.verdict ?? '?'] ?? 0) + 1;
        }
      } else if (stage === 'completion') missingCompletion.push(group.id);
    }
  }
  const leaves = entries.filter(entry => entry.group.groups.length === 0);
  const mergeDone = await exists(join(run, 'preview.svg'));
  const occlusionDone = await exists(join(run, 'occlusion.json'));
  const summary = {
    run, groups: groups.length, nodes: entries.length,
    group: entries.filter(entry => nodeKind(entry.group) === 'group').length,
    part: entries.filter(entry => nodeKind(entry.group) === 'part').length,
    byDepth, counts, verdicts,
    leaves: leaves.length, completedLeaves: leaves.length - missingCompletion.length,
    missingCompletion, merge: mergeDone, occlusion: occlusionDone,
  };
  if (values.json) { console.log(JSON.stringify(summary, null, 2)); return 0; }
  console.log(`运行目录：${run}`);
  console.log(`节点：${summary.nodes}（group ${summary.group} / part ${summary.part}），深度分布 ${JSON.stringify(byDepth)}`);
  console.log(`阶段完成：轮廓 ${counts.outline} / review ${counts.review} / 去重 ${counts.reduction} / 补全 ${counts.completion} / 补全自检 ${counts.completionCheck}`);
  console.log(`审查结论：${JSON.stringify(verdicts)}`);
  console.log(`终止叶子：${leaves.length}，已补全 ${leaves.length - missingCompletion.length}`);
  console.log(`合并预览：${mergeDone ? '有' : '无'}；遮挡层级表：${occlusionDone ? '有' : '无'}`);
  if (missingCompletion.length) console.log(`待补全：${missingCompletion.join(', ')}`);
  return 0;
}

async function validateRun(args: string[]) {
  const { values } = parseArgs({ args, options: {
    run: { type: 'string' }, stage: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (!values.run) throw new Error('validate 需要 --run <part-layering 目录>');
  const run = resolve(values.run);
  const only = values.stage && values.stage !== 'all' ? values.stage : undefined;
  if (only && !['outline', 'reduction', 'completion'].includes(only)) throw new Error('--stage 只能是 outline / reduction / completion / all');
  const canvas = await canvasFromReference(join(run, 'references/base-subject.png'));
  const entries = walkGroups(await loadGroups(run));
  const failures: { id: string; stage: string; error: string }[] = [];
  let checked = 0;
  for (const { group, parent } of entries) {
    const parentPart = parent ? join(run, 'parts', `${parent.id}.svg`) : undefined;
    const haveParent = parentPart && await exists(parentPart) ? parentPart : undefined;
    if (!only || only === 'outline') {
      const path = artifact(run, 'outline', group.id);
      if (await exists(path)) {
        checked++;
        try { await validateGroupSvg(path, group.id, canvas, haveParent); }
        catch (error) { failures.push({ id: group.id, stage: 'outline', error: (error as Error).message }); }
      }
    }
    if (!only || only === 'reduction') {
      const path = artifact(run, 'reduction', group.id);
      if (await exists(path)) {
        checked++;
        try { await validateGroupSvg(path, group.id, canvas, haveParent, true); }
        catch (error) { failures.push({ id: group.id, stage: 'reduction', error: (error as Error).message }); }
      }
    }
    if (!only || only === 'completion') {
      const path = artifact(run, 'completion', group.id);
      if (await exists(path)) {
        checked++;
        try {
          await validateGroupSvg(path, group.id, canvas, haveParent, true);
          const source = artifact(run, 'reduction', group.id);
          if (await exists(source)) assertCompletionPreserves((await readFile(source)).toString(), (await readFile(path)).toString());
        } catch (error) { failures.push({ id: group.id, stage: 'completion', error: (error as Error).message }); }
      }
    }
  }
  if (values.json) console.log(JSON.stringify({ run, canvas, checked, failures }, null, 2));
  else {
    console.log(`画布 ${canvas.width}x${canvas.height}；校验 ${checked} 个文件`);
    if (!failures.length) console.log('全部通过');
    for (const failure of failures) console.log(`✗ ${failure.id} [${failure.stage}] ${failure.error}`);
  }
  return failures.length ? 1 : 0;
}

async function check(args: string[]) {
  const { values } = parseArgs({ args, options: {
    svg: { type: 'string' }, group: { type: 'string' }, canvas: { type: 'string' },
    parent: { type: 'string' }, 'allow-empty': { type: 'boolean' }, json: { type: 'boolean' },
  } });
  if (!values.svg || !values.group) throw new Error('check 需要 --svg <文件> 与 --group <组 ID>');
  const canvas = canvasOf(values.canvas) ?? await canvasFromReference(join(dirname(resolve(values.svg)), '..', 'references/base-subject.png'));
  const bytes = await validateGroupSvg(resolve(values.svg), values.group, canvas, values.parent && resolve(values.parent), values['allow-empty']);
  const result = { svg: resolve(values.svg), group: values.group, canvas, bytes: bytes.length,
    ...(values.parent ? { bounds: await checkParentBounds(resolve(values.svg), resolve(values.parent), canvas) } : {}) };
  console.log(values.json ? JSON.stringify(result, null, 2) : `通过：${result.svg}（${result.bytes} 字节）`);
  return 0;
}

async function preview(args: string[]) {
  const { values } = parseArgs({ args, options: {
    svg: { type: 'string' }, reference: { type: 'string' }, canvas: { type: 'string' },
    mode: { type: 'string' }, crop: { type: 'string' }, scale: { type: 'string' },
    parent: { type: 'string' }, root: { type: 'string' }, out: { type: 'string' },
    job: { type: 'string' }, json: { type: 'boolean' },
  } });
  // --job：按 job 绑定的参考、画布与父图渲染，并把观测登记到该 job。
  const job = values.job ? await readJob(resolve(values.job)) : undefined;
  if (!values.svg && !job) throw new Error('preview 需要 --svg <文件> 或 --job <job 目录>');
  const svg = resolve(values.svg ?? job!.inputs.candidate ?? job!.output.draft);
  const root = resolve(values.root ?? job?.run ?? dirname(svg));
  const reference = resolve(values.reference ?? job?.inputs.reference ?? join(root, 'references/base-subject.png'));
  const canvas = canvasOf(values.canvas) ?? job?.canvas ?? await canvasFromReference(reference);
  const parent = values.parent ? resolve(values.parent) : job?.inputs.parentSvg ?? undefined;
  const rasterInput = /\.(png|jpe?g|webp)$/i.test(svg);
  const crop = values.crop ? values.crop.split(',').map(Number) as [number, number, number, number] : undefined;
  if (crop && (crop.length !== 4 || crop.some(n => !Number.isSafeInteger(n)))) throw new Error('--crop 须为 x,y,width,height 四个整数');
  const result = await renderPreview({
    directory: root, reference, canvas,
    ...(parent ? { parent } : {}),
    observationDirectory: resolve(values.out ?? (job ? join(resolve(values.job!), 'out') : join(root, '.preview'))),
  }, {
    path: svg, mode: (values.mode as PreviewMode | undefined) ?? (rasterInput ? 'view' : 'svg'),
    ...(crop ? { crop } : {}), ...(values.scale ? { scale: Number(values.scale) } : {}),
  });
  if (job) {
    await appendObservation(resolve(values.job!), {
      source: result.source, mode: result.mode, savedPath: result.savedPath,
      reference, crop: result.crop, scale: result.scale, at: new Date().toISOString(),
    });
  }
  console.log(values.json ? JSON.stringify(result, null, 2) : `预览：${result.savedPath}${result.bounds ? `；父范围 ${result.bounds.status}` : ''}`);
  return 0;
}

async function merge(args: string[]) {
  const { values } = parseArgs({ args, options: {
    run: { type: 'string' }, out: { type: 'string' }, depth: { type: 'string' }, partial: { type: 'boolean' },
  } });
  if (!values.run || !values.out) throw new Error('merge 需要 --run <part-layering 目录> 与 --out <输出文件>');
  const run = resolve(values.run);
  const groups = await loadGroups(run);
  if (values.depth) {
    const limit = Number(values.depth);
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('--depth 须为非负整数');
    (function prune(nodes: GroupNode[], depth: number) {
      for (const node of nodes) { if (depth >= limit) node.groups = []; else prune(node.groups, depth + 1); }
    })(groups, 0);
  }
  const leaves = walkGroups(groups).filter(entry => entry.group.groups.length === 0);
  const parts: { groupId: string; path: string }[] = [];
  const missing: string[] = [];
  for (const { group } of leaves) {
    const path = join(run, 'parts', `${group.id}.svg`);
    if (await exists(path)) parts.push({ groupId: group.id, path }); else missing.push(group.id);
  }
  if (missing.length && !values.partial) throw new Error(`缺少终止 part：${missing[0]}（共 ${missing.length} 个；如需部分预览加 --partial）`);
  if (!parts.length) throw new Error('没有任何可合并的 part');
  const result = await mergePartSvgs({ directory: run, outputPath: resolve(values.out), groups, parts });
  console.log(`${result.note}${missing.length ? `（跳过 ${missing.length} 个未完成 part）` : ''} → ${result.path}`);
  return 0;
}

async function next(args: string[]) {
  const { values } = parseArgs({ args, options: {
    run: { type: 'string' }, 'review-rounds': { type: 'string' }, expand: { type: 'boolean' }, json: { type: 'boolean' },
  } });
  if (!values.run) throw new Error('next 需要 --run <part-layering 目录>');
  const run = resolve(values.run);
  const maxRounds = values['review-rounds'] === undefined ? 2 : Number(values['review-rounds']);
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 4) throw new Error('--review-rounds 须为 1..4');
  const plan = await planJobs(run, { maxRounds, expand: values.expand === true });
  const jobs = [];
  for (const item of plan.items) {
    const job = await materialize(plan, item, maxRounds, values.expand === true);
    const dir = jobDirectory(run, job.kind, job.groupId);
    jobs.push({ id: job.id, kind: job.kind, reason: job.reason, groupId: job.groupId,
      dir, instructions: join(dir, 'INSTRUCTIONS.md'), draft: job.output.draft, published: job.output.published });
  }
  if (values.json) {
    console.log(JSON.stringify({ run, canvas: plan.canvas, jobs, blocked: plan.blocked, completed: plan.completed }, null, 2));
    return 0;
  }
  console.log(`运行目录：${run}`);
  console.log(`可执行 job：${jobs.length}；已完成：${plan.completed.length}；阻塞：${plan.blocked.length}`);
  for (const job of jobs) console.log(`  [${job.kind}${job.reason === 'repair' ? '/返修' : ''}] ${job.groupId} → ${job.dir}`);
  for (const item of plan.blocked) console.log(`  [阻塞] ${item.id}：${item.message}`);
  return 0;
}

async function submitCmd(args: string[]) {
  const { values } = parseArgs({ args, options: {
    job: { type: 'string' }, svg: { type: 'string' }, verdict: { type: 'string' },
    feedback: { type: 'string' }, paths: { type: 'string' }, note: { type: 'string' },
    group: { type: 'string' }, children: { type: 'string' }, levels: { type: 'string' },
    checks: { type: 'string' }, groups: { type: 'string' }, subject: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (!values.job) throw new Error('submit 需要 --job <job 目录>');
  const result = await submitJob(resolve(values.job), {
    ...(values.svg ? { svg: values.svg } : {}),
    ...(values.verdict ? { verdict: values.verdict as 'pass' | 'revise' | 'blocked' } : {}),
    ...(values.feedback ? { feedback: values.feedback } : {}),
    ...(values.paths !== undefined ? { paths: values.paths } : {}),
    ...(values.note ? { note: values.note } : {}),
    ...(values.group ? { group: values.group } : {}),
    ...(values.children !== undefined ? { children: values.children } : {}),
    ...(values.levels !== undefined ? { levels: values.levels } : {}),
    ...(values.checks !== undefined ? { checks: values.checks } : {}),
    ...(values.groups !== undefined ? { groups: values.groups } : {}),
    ...(values.subject ? { subject: values.subject } : {}),
  });
  if (values.json) { console.log(JSON.stringify(result, null, 2)); return 0; }
  if (result.paths !== undefined) console.log(`已重建草稿：${result.draft}（新增路径 ${result.paths} 条；旧观测已清空）`);
  else if (result.levels !== undefined) console.log(`已生成候选叠放预览：${result.job}（${result.levels} 个 part；旧观测已清空）`);
  else if (result.occlusion) console.log(`已发布遮挡层级表：${result.occlusion}`);
  else if (result.changed !== undefined) console.log(`已处理：${result.job}（累计变更组 ${result.changed}）`);
  else if (result.added) console.log(`已登记子节点：${result.added.join(', ')}`);
  else console.log(`已提交：${result.job}${result.published ? ` → ${result.published}` : ''}${result.verdict ? `（${result.verdict}）` : ''}`);
  return 0;
}

async function imagegen(args: string[]) {
  const { values } = parseArgs({ args, options: {
    prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, out: { type: 'string' },
    ref: { type: 'string', multiple: true }, size: { type: 'string' }, model: { type: 'string' },
    task: { type: 'string' }, backend: { type: 'string' }, 'dry-run': { type: 'boolean' },
    loose: { type: 'boolean' }, 'image-size': { type: 'string' }, quality: { type: 'string' },
    background: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (!values.out) throw new Error('imagegen 需要 --out <输出 PNG>');
  const prompt = values['prompt-file'] ? await readFile(resolve(values['prompt-file']), 'utf8') : values.prompt;
  if (!prompt?.trim()) throw new Error('imagegen 需要 --prompt 或 --prompt-file');
  const fromTask = values.task ? taskModel(values.task) : undefined;
  const requested = canonicalModel(values.model);
  if (fromTask && requested && requested !== fromTask) {
    throw new Error(`--model ${requested} 与 --task ${values.task}（${fromTask}）不一致`);
  }
  const model = requested ?? fromTask;
  const provider = providerForModel(model);
  if (values.backend && provider && values.backend !== provider) {
    throw new Error(`--model ${model} 属于 ${provider} 后端，与 --backend ${values.backend} 不一致`);
  }
  const env = values.backend ? { ...process.env, L2D_IMAGE_BACKEND: values.backend } : process.env;
  const imageSize = values['image-size'];
  if (imageSize && imageSize !== '1K' && imageSize !== '2K' && imageSize !== '4K') {
    throw new Error('--image-size 须为 1K、2K 或 4K');
  }
  const job = {
    prompt: prompt.trim(), output: resolve(values.out),
    ...(values.size ? { size: values.size } : {}),
    ...(model ? { model } : {}),
    ...(values.loose ? { strict: false as const } : {}),
    ...(imageSize ? { imageSize: imageSize as '1K' | '2K' | '4K' } : {}),
    ...(values.quality ? { quality: values.quality as 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
    ...(values.background ? { background: values.background as 'auto' | 'opaque' | 'transparent' } : {}),
    ...(values.ref?.length ? { references: values.ref.map(path => ({ path: resolve(path) })) } : {}),
  };
  // 预检：只打印请求摘要（图片以长度替代 base64），不联网，也不打印密钥。
  if (values['dry-run']) {
    const name = resolveBackendName('imagegen', env, model);
    if (name === 'apiyi') {
      const configured = canonicalModel(env.L2D_IMAGE_MODEL);
      const apiyiModel = model && provider === 'apiyi' ? model
        : configured && providerForModel(configured) === 'apiyi' ? configured : undefined;
      console.log(JSON.stringify(await previewApiyi(job, {
        baseUrl: env.APIYI_BASE_URL?.trim() || 'https://api.apiyi.com',
        ...(apiyiModel ? { model: apiyiModel } : {}),
      }), null, 2));
      return 0;
    }
    throw new Error('--dry-run 目前只支持 apiyi 后端');
  }
  const result = await imageGenerate(job, env);
  console.log(values.json ? JSON.stringify(result, null, 2)
    : `已生成：${result.savedPath}（后端 ${result.backend}${result.model ? `，模型 ${result.model}` : ''}，${result.bytes} 字节）`
      + (result.aligned ? '；已等比例对齐到目标画布' : ''));
  return 0;
}

async function upscaleCmd(args: string[]) {
  const { values } = parseArgs({ args, options: {
    in: { type: 'string' }, out: { type: 'string' }, scale: { type: 'string' },
    backend: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (!values.in || !values.out) throw new Error('upscale 需要 --in <PNG> 与 --out <PNG>');
  const env = values.backend ? { ...process.env, L2D_UPSCALE_BACKEND: values.backend } : process.env;
  const result = await upscaleImage({
    input: resolve(values.in), output: resolve(values.out),
    ...(values.scale ? { scale: Number(values.scale) } : {}),
  }, env);
  console.log(values.json ? JSON.stringify(result, null, 2)
    : `已放大：${result.savedPath}（后端 ${result.backend}，${result.bytes} 字节）`);
  return 0;
}

const usage = `l2d — live2d-portable 唯一 agent 接口（核心命令不依赖 Codex）

  l2d next     --run <part-layering> [--review-rounds 1..4] [--expand] [--json]
  l2d submit   --job <job 目录> [--svg <草稿>] [--verdict pass|revise|blocked --feedback ...]
               [--paths '<JSON 数组>' | --paths @paths.json --note "补全依据"]
               [--group <组ID> --svg <文件> | --note "去重依据"]
               [--children '<JSON 数组>' --note "拆分依据"]
               [--levels '<JSON 数组>' | --checks '<JSON>' --note "检查依据"]
               [--groups '<JSON 数组>' [--subject character|other]] [--json]
  l2d preview  --svg <file> | --job <job 目录>
               [--reference <png>] [--mode svg|blend|edge] [--crop x,y,w,h] [--scale 1..8]
               [--parent <svg>] [--root <dir>] [--out <dir>] [--canvas WxH] [--json]
  l2d status   --run <part-layering> [--json]
  l2d validate --run <part-layering> [--stage outline|reduction|completion|all] [--json]
  l2d check    --svg <file> --group <id> [--canvas 1024x1536] [--parent <svg>] [--allow-empty] [--json]
  l2d merge    --run <part-layering> --out <preview.svg> [--depth N] [--partial]
  l2d imagegen --prompt <文本> | --prompt-file <f> --out <png> [--ref <png> ...] [--size WxH]
               [--model gemini-nano-banana-2.1|gpt-image-2.5-sunburst|gpt-image-2.5-flare]
               [--task standardize|body_reference|fast_comparison]
               [--backend apiyi|api|codex] [--loose] [--image-size 1K|2K|4K]
               [--quality high] [--background auto|opaque|transparent] [--dry-run]
  l2d upscale  --in <png> --out <png> [--scale 2..8] [--backend local|codex]

执行者约定：l2d next 拿到 job → 读 INSTRUCTIONS.md → 写草稿 → l2d preview 自检 → l2d submit。
程序负责校验与发布事实；只有 imagegen / upscale 涉及图片生成，且后端可选：
  L2D_IMAGE_BACKEND=apiyi|api|codex（生图）、L2D_UPSCALE_BACKEND=local|codex（放大）。
  API易图片编辑按 --model / --task 选择模型。`;

// 启动时加载项目 .env；已有环境变量优先，L2D_NO_DOTENV=1 可跳过。
if (!process.env.L2D_NO_DOTENV) loadDotEnv(fileURLToPath(new URL('../../.env', import.meta.url)));

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'status': return status(rest);
    case 'next': return next(rest);
    case 'submit': return submitCmd(rest);
    case 'validate': return validateRun(rest);
    case 'check': return check(rest);
    case 'preview': return preview(rest);
    case 'merge': return merge(rest);
    case 'imagegen': return imagegen(rest);
    case 'upscale': return upscaleCmd(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(usage);
      return 0;
    default:
      console.error(`未知命令：${command}\n`);
      console.log(usage);
      return 2;
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
