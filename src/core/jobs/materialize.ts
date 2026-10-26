import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { bytesHash, svgHash } from '../facts/hash.ts';
import { writeAtomic } from '../facts/groups.ts';
import { writeMergedPreview } from '../svg/merged-preview.ts';
import { mergePartSvgs } from '../svg/merge.ts';
import { walkGroups, type GroupNode } from '../facts/groups.ts';
import {
  jobDirectory, outlinePath, type Plan, type PlanItem,
} from './plan.ts';
import type { Canvas } from '../svg/validate.ts';
import { rasterDeliverablesHash } from '../raster/hash.ts';
import { loadRasterConfig, upstreamDirectory } from '../raster/config.ts';
import { reviewPlan, evidenceTemplate } from './review-policy.ts';
import { groupPrompt, groupReferences, type GroupStage } from './group-prompts.ts';

// job 目录是给执行者的完整任务包。这里不画 SVG，也不调用生图或放大。

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const promptsRoot = join(repoRoot, 'prompts');
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const cli = `node ${quote(join(repoRoot, 'src/cli/main.ts'))}`;
const commands = (lines: string[]) => ['```bash', ...lines, '```'].join('\n');

const imageTools = [
  '图片生成与局部放大由执行者通过本仓库 CLI 主动调用；next/submit 不会替你生图或绘制。',
  `命令前缀：${cli}（无需安装全局 l2d，也无需启动嵌套 Codex）。`,
  '生图须带 --prompt 或 --prompt-file，并指定 --ref、--out；API易至少一张参考图，第一张是编辑对象，其余是风格/控制参考。',
  '简化用 --task standardize，素体用 --task body_reference；两者均加 --background transparent。',
  'GPT 校验原生 Alpha；Nano 优先保留原生 Alpha，否则自动双背景恢复，最多两次生图（网络重试另计）。不要手动拆成两次请求。',
  '禁止单背景色键去背或 rematte。生图先 --dry-run 核对参数，成功后去掉该参数执行并查看实际 PNG。',
  '失败先读 stderr 指向的诊断目录/error.json，检查原图、counterpart.png、alpha.png 和 report.json（按执行阶段生成）。不得把诊断原图当最终交付，不能靠补透明边框通过校验。',
  '不因一次失败反复调用付费生图。修正有依据的参数或提示词后再重试；缺密钥、尺寸不支持、主体漂移或恢复失败且无明确修正办法时，停止并报告路径与原因。',
  '局部等比放大可用 upscale --backend local --in <局部PNG> --out <辅助PNG> --scale 2；如需生成式辅助图，用 imagegen --task fast_comparison 并补齐 prompt/ref/out。',
].join('\n');

export type JobRecord = {
  id: string;
  kind: string;
  reason: string;
  groupId: string;
  run: string;
  canvas: Canvas;
  inputs: {
    candidate?: string;
    reference?: string;
    parentSvg?: string;
    source?: string;
    merged?: string;
    deliverable?: string;
    beforeCompletion?: string;
  };
  output: { draft: string; published?: string };
  draftHash?: string;
  reductions?: Record<string, string>;
  layerIds?: string[];
  depth?: number;
  candidateHash?: string;
  referenceHash?: string;
  deliverablesHash?: string;
  review?: Awaited<ReturnType<typeof reviewPlan>>;
  required?: string[];
  outputDir?: string;
  expectsReview?: boolean;
  reviewRounds?: number;
  proposal?: { id?: string; level?: number; note?: string }[];
};

async function promptText(names: string[]): Promise<string> {
  const parts = [];
  for (const name of names) parts.push(`### ${join(promptsRoot, name)}\n\n${(await readFile(join(promptsRoot, name), 'utf8')).trim()}`);
  return parts.join('\n\n');
}

async function groupText(id: string, stage: GroupStage, fallback: string, run: string, dir: string): Promise<string> {
  const selected = await groupPrompt(id, stage, fallback);
  const references = await groupReferences(id, stage, run, dir);
  return [`### ${selected.path}`, selected.text.trim(), ...references.map(reference =>
    `附加参考：${reference.path}；用途：${reference.description}${reference.sourceSvg ? `；只读源 SVG：${reference.sourceSvg}` : ''}`)].join('\n\n');
}

export async function readJob(jobDir: string): Promise<JobRecord> {
  const raw = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8')) as JobRecord;
  if (!raw || raw.run === undefined || !raw.kind) throw new Error(`无效 job：${jobDir}`);
  return raw;
}

async function previous(jobDir: string): Promise<Partial<JobRecord>> {
  return readJob(jobDir).catch(() => ({}));
}

export async function materialize(plan: Plan, item: PlanItem, maxRounds: number, expand = false): Promise<JobRecord> {
  const dir = jobDirectory(plan.run, item.kind, item.groupId);
  await mkdir(join(dir, 'out'), { recursive: true });
  await mkdir(join(dir, 'inputs'), { recursive: true });
  const prior = await previous(dir);
  const reference = join(plan.run, 'references/base-subject.png');
  const draft = join(dir, 'out/draft.svg');
  const record: JobRecord = {
    id: `${item.kind}:${item.groupId}`,
    kind: item.kind, reason: item.reason, groupId: item.groupId, run: plan.run, canvas: plan.canvas,
    inputs: { ...(item.parentSvg ? { parentSvg: item.parentSvg } : {}) },
    output: { draft },
    ...(prior.draftHash ? { draftHash: prior.draftHash } : {}),
    ...(prior.reductions ? { reductions: prior.reductions } : {}),
    ...(item.layerIds ? { layerIds: item.layerIds } : {}),
    ...(item.depth !== undefined ? { depth: item.depth } : {}),
    ...(item.required ? { required: item.required } : {}),
    ...(item.outputDir ? { outputDir: item.outputDir } : {}),
    ...(item.expectsReview ? { expectsReview: true } : {}),
    reviewRounds: item.reviewRounds ?? maxRounds,
    ...(prior.proposal ? { proposal: prior.proposal } : {}),
  };

  if (item.kind === 'preparation') {
    const original = join(plan.run, 'input/original.png');
    record.inputs.reference = original;
    record.inputs.candidate = original;
    record.output.published = join(plan.run, 'references/preparation.json');
  } else if (item.kind === 'grouping') {
    record.inputs.reference = reference;
    record.inputs.candidate = reference;
    record.output.published = join(plan.run, 'groups.json');
  } else if (item.kind === 'outline') {
    record.inputs.reference = reference;
    record.inputs.candidate = draft;
    if (item.source) record.inputs.parentSvg = item.source;
    record.output.published = outlinePath(plan.run, item.groupId);
    if (item.reason === 'repair' && item.prefill) await copyFile(item.prefill, draft);
  } else if (item.kind === 'review' || item.kind === 'completion-review') {
    record.inputs.reference = reference;
    record.inputs.candidate = item.prefill;
    record.inputs.source = item.prefill;
    record.output.draft = item.prefill ?? draft;
    record.output.published = join(plan.run, item.kind === 'completion-review' ? 'stages/completion-review' : 'stages/review', `${item.groupId}.review.json`);
    if (item.kind === 'completion-review' && item.source) record.inputs.beforeCompletion = item.source;
    if (item.kind === 'review' && item.source) record.inputs.parentSvg = item.source;
    if (item.prefill) record.candidateHash = svgHash(await readFile(item.prefill));
    record.review = await reviewPlan(record.inputs.candidate!, reference, plan.canvas);
    await writeAtomic(join(dir, 'inputs/review-plan.json'), JSON.stringify(record.review, null, 2) + '\n');
    await writeAtomic(join(dir, 'inputs/review-checks.template.json'), JSON.stringify(evidenceTemplate(record.review), null, 2) + '\n');
    await writeAtomic(join(dir, 'inputs/agent-review.template.json'), JSON.stringify({
      jobId: record.id, attemptId: randomUUID(), candidateHash: record.review.candidateHash, referenceHash: record.review.referenceHash,
      reviewerModel: '', verdict: 'pending', findings: [], verifiedRegions: record.review.regions.map(crop => crop.join(',')),
      feedback: '', checks: evidenceTemplate(record.review),
    }, null, 2) + '\n');
  } else if (item.kind === 'reduction') {
    const merged = join(dir, 'inputs/merged.svg');
    await writeMergedPreview(plan.run, item.layerIds ?? [], plan.canvas, merged);
    record.inputs.reference = reference;
    record.inputs.merged = merged;
    record.inputs.candidate = merged;
    record.output.published = join(plan.run, 'stages/outline-reduce/layers', `${item.depth}.json`);
  } else if (item.kind === 'completion') {
    record.inputs.reference = reference;
    record.inputs.source = item.source;
    record.inputs.candidate = draft;
    record.output.published = join(plan.run, 'parts', `${item.groupId}.svg`);
    if (item.source && !await readFile(draft).then(() => true, () => false)) await copyFile(item.source, draft);
  } else if (item.kind === 'children') {
    record.inputs.reference = reference;
    record.inputs.candidate = item.source;
    record.inputs.source = item.source;
    record.output.published = join(plan.run, 'groups.json');
  } else if (item.kind === 'occlusion') {
    record.inputs.reference = reference;
    record.inputs.candidate = join(plan.run, 'stages/occlusion/candidate.svg');
    record.inputs.source = join(plan.run, 'preview.svg');
    record.output.published = join(plan.run, 'occlusion.json');
    if (item.mergePreview) {
      const raw = JSON.parse(await readFile(join(plan.run, 'groups.json'), 'utf8')) as { groups: GroupNode[] };
      const leaves = walkGroups(raw.groups).filter(entry => !entry.group.groups.length);
      await mergePartSvgs({
        directory: plan.run, outputPath: join(plan.run, 'preview.svg'), groups: raw.groups,
        parts: leaves.map(entry => ({ groupId: entry.group.id, path: join(plan.run, 'parts', `${entry.group.id}.svg`) })),
      });
    }
  } else if (item.kind === 'raster' || item.kind === 'raster-review') {
    record.inputs.reference = item.reference ?? reference;
    record.inputs.candidate = item.kind === 'raster-review' ? (item.deliverable ?? record.inputs.reference) : (item.outputDir ?? draft);
    record.inputs.deliverable = item.deliverable;
    record.output.published = item.outputDir;
    if (item.kind === 'raster-review' && item.deliverable) {
      record.candidateHash = bytesHash(await readFile(item.deliverable));
      record.deliverablesHash = await rasterDeliverablesHash(item.outputDir!, item.required ?? []);
    }
  }

  if (record.inputs.reference) record.referenceHash = bytesHash(await readFile(record.inputs.reference));
  await writeAtomic(join(dir, 'job.json'), JSON.stringify(record, null, 2) + '\n');
  await writeAtomic(join(dir, 'INSTRUCTIONS.md'), await instructions(plan, item, dir, record, maxRounds, expand));
  return record;
}

async function instructions(plan: Plan, item: PlanItem, dir: string, record: JobRecord, maxRounds: number, expand: boolean): Promise<string> {
  const jobArg = `--job ${quote(dir)}`;
  const preview = (mode: string, source?: string) => `${cli} preview ${jobArg}${source ? ` --svg ${quote(source)}` : ''} --mode ${mode}`;
  const submit = `${cli} submit ${jobArg}`;
  const lines: string[] = [
    `# ${item.kind} · ${item.groupId}`, '',
    '## 本次操作约定',
    `项目目录：${repoRoot}；运行目录：${plan.run}；画布：${plan.canvas.width}x${plan.canvas.height}。`,
    `执行入口：${cli}。下方命令使用实际绝对路径，可从任意目录执行。`,
    '程序只派发和校验；读图、判断、绘制、生图、Krita 操作、提交与继续领取均由执行者完成。',
    '制作归属：人物素体不包含任何穿戴配饰，全部配饰统一归衣物绘制管线；素体分组、轮廓、拆分、审查和栅格均不得重新补回。后文提及饰件的规则仅在衣物/配饰任务中适用。角色自身的天然耳朵、角、尾巴和翅膀仍是本体结构。',
    '先读本次操作步骤，再读后面的绘制正文。正文中的“结束/只回复”仅结束当前判断或绘制环节，不替代 CLI 提交，也不结束整个任务循环。',
    '只写本 job 的 out 草稿和本步明确指定的参考/栅格交付目录；正式 SVG、groups.json、job.json、观测与完成标记由程序维护。',
    '预览命令只生成并登记图片；必须使用宿主 Agent 的原生图片工具打开 PNG 实际看图。图片必须作为多模态输入，禁止将图片 Base64/工具图片 JSON 当文本读入上下文，禁止输出 Base64 到 shell/聊天。改稿后重新预览，不能编辑 observations.json 代替看图。',
    '同一候选版本中，每批只读当前检查需要的视图，及时把具体发现及已核对区域写入 out/progress.md；不要反复重读未变化的图。上下文不足时使用 handoff --job 保存路径与哈希，在新会话中读取交接文件与本任务包，重新打开本轮必须核对的图片；不得降低必查区域、复用旧哈希结论或自动 pass。',
    '', '## 执行步骤',
  ];
  if (item.kind !== 'preparation' && item.kind !== 'raster' && item.kind !== 'raster-review') {
    const groupsPath = join(plan.run, 'groups.json');
    const document = JSON.parse(await readFile(groupsPath, 'utf8')) as { groups: GroupNode[] };
    const entries = walkGroups(document.groups);
    const scope = entries.filter(({ group }) => group.id === item.groupId || item.layerIds?.includes(group.id));
    lines.push(`分组树（只读）：${groupsPath}`);
    for (const { group, parent } of scope) {
      lines.push(`当前节点：${group.id}；类型：${group.kind ?? 'group'}；职责：${group.note ?? '按参考辨认'}${parent ? `；父节点：${parent.id}` : ''}`);
      if (parent) lines.push(`父完整 SVG（只读）：${join(plan.run, 'parts', `${parent.id}.svg`)}`);
    }
  }
  if (item.kind === 'preparation') {
    const original = join(plan.run, 'input/original.png');
    const simplified = join(plan.run, 'references/simplified-subject.png');
    const base = join(plan.run, 'references/base-subject.png');
    const generate = (task: string, prompt: string, refs: string[], output: string) =>
      `${cli} imagegen --task ${task} --background transparent --prompt-file ${quote(join(promptsRoot, prompt))} ${refs.map(path => `--ref ${quote(path)}`).join(' ')} --out ${quote(output)} --size ${plan.canvas.width}x${plan.canvas.height} --json`;
    const simplify = generate('standardize', '2-简化图片.md', [original, join(repoRoot, 'resources/简化参考图片.png')], simplified);
    const body = generate('body_reference', '3-素体参考.md', [simplified, join(repoRoot, 'resources/连体服参考.jpg')], base);
    lines.push(
      `1. 查看原图 ${original} 和画风参考 ${join(repoRoot, 'resources/简化参考图片.png')}，判断是否需要简化。`,
      '参考判断提示词的 JSON 只用于本步判断，把判断与理由写入最终 --note；不要只返回 JSON 就结束。',
      '2. 需要简化：先执行 dry-run，确认后执行生图；不需要简化：仅执行下方 cp 分支。两个分支只选一个。',
      commands([`${simplify} --dry-run`, simplify]),
      '不需要简化时只执行这一分支：', commands([`cp ${quote(original)} ${quote(simplified)}`]),
      '3. 查看 simplified-subject.png，确认完整角色、姿态和尺寸；未简化的复制图保留原样，不强制改透明。然后做素体换装：',
      commands([`${body} --dry-run`, body]),
      '4. 打开 base-subject.png 和原图对照，检查脸、头发、表情、手势、身形与连体服是否正确，并逐项确认全部配饰已移除、遮挡处皮肤和头发补全、没有配饰残影。查看 --json 返回的 transparency.artifactsDirectory；必要时查看 Alpha 蒙版与恢复报告。',
      '两张 PNG 画布必须与原图一致；素体透明面积须 ≥5%。不要自行拉伸、补边或改尺寸来掩盖失败；不擅自加 --loose。',
      '5. 确认两张图均合格后提交：',
      commands([`${submit} --note '填写是否需要简化、判断依据、生图检查结果与遗留问题'`]),
      '', imageTools, '', '## 分阶段提示词（用于判断/模型请求，不是整个 job 的最终回复）',
      await promptText(['1-参考判断.md', '2-简化图片.md', '3-素体参考.md']),
    );
  } else if (item.kind === 'grouping') {
    lines.push('只提交一层 name/note。程序生成 id 并写入 groups.json。', '', imageTools, '', await promptText(['4-初始分组.md']));
  } else if (item.kind === 'outline' && item.reason === 'repair') {
    lines.push('返修要求', item.feedback ?? '', '', `草稿：${record.output.draft}`, `参考：${record.inputs.reference ?? ''}`, '', imageTools, '', await groupText(item.groupId, 'outline', '5-组轮廓.md', plan.run, dir), await promptText(['7-轮廓返修.md']));
  } else if (item.kind === 'outline') {
    lines.push(`组：${item.groupId}`, `草稿：${record.output.draft}`, `参考：${record.inputs.reference ?? ''}`);
    if (record.inputs.parentSvg) lines.push(`父轮廓：${record.inputs.parentSvg}`);
    lines.push('', imageTools, '', await groupText(item.groupId, 'outline', '5-组轮廓.md', plan.run, dir));
  } else if (item.kind === 'review' || item.kind === 'completion-review') {
    lines.push('本步只给结论，不改 SVG。', `候选：${record.inputs.candidate ?? ''}`);
    if (item.kind === 'completion-review') lines.push(`本轮审查补全后的完整 SVG。隐藏部分不能与遮挡物像素硬匹配，要对照本组补全职责核对完整形体、头盖、脸型、指根等连接及真实空隙；源稿可见部分须保留。`,
      `补全前只读底稿：${item.source}`, await groupText(item.groupId, 'completion', '9-正面遮挡补全.md', plan.run, dir), await promptText(['9-补全操作约定.md']));
    lines.push('', await groupText(item.groupId, 'review', item.kind === 'completion-review' ? '9-补全review.md' : '6-轮廓review.md', plan.run, dir));
  } else if (item.kind === 'reduction') {
    lines.push('先查看整层合成预览，再只提交真正改动的组。未提交的组由程序原样复制。', `合成图：${record.inputs.merged ?? ''}`, '', await promptText(['8-同层轮廓去重.md']));
  } else if (item.kind === 'completion') {
    if (item.feedback) lines.push('补全返修意见', item.feedback, '只重做新增路径，不修改原形；重新提交完整新增路径数组，不在旧补全层上叠加第二层。');
    lines.push('只提交新增闭合路径。程序从只读底稿合成草稿，并保留原形。', `底稿：${record.inputs.source ?? ''}`, `草稿：${record.output.draft}`, '', await groupText(item.groupId, 'completion', '9-正面遮挡补全.md', plan.run, dir), await promptText(['9-补全操作约定.md']), imageTools);
  } else if (item.kind === 'children') {
    lines.push('只提交直属 name/kind/note。程序生成完整 ID。空列表表示当前节点终止。不要用单个 part 包装。', '', await groupText(item.groupId, 'children', '10-直属结构拆分.md', plan.run, dir), await promptText(['10-拆分操作约定.md']));
  } else if (item.kind === 'occlusion') {
    lines.push('先看 preview.svg，再提交覆盖全部终止 part 的 level。看过候选叠放后，逐件给出检查依据。', `预览：${join(plan.run, 'preview.svg')}`, `候选：${record.inputs.candidate ?? ''}`, '', await promptText(['11-遮挡层级规划.md']));
  } else if (item.kind === 'raster' || item.kind === 'raster-review') {
    lines.push(item.stepTitle ?? item.groupId);
    if (item.feedback) lines.push('', '返修要求', item.feedback);
    lines.push('', `产出到 ${item.outputDir}`, `交付：${(item.required ?? []).join('、')}`);
    if (item.kind === 'raster-review') lines.push('本步只给结论，不改文件。');
    const config = await loadRasterConfig(plan.run);
    const upstream = upstreamDirectory(plan.run, config);
    const step = config.steps.find(step => step.id === item.groupId);
    lines.push('', `上游目录（只读）：${upstream}`, `上游分组：${join(upstream, 'groups.json')}`, `上游部件：${join(upstream, 'parts')}`, `上游遮挡：${join(upstream, 'occlusion.json')}`,
      '正文中的相对路径按用途映射到以上上游目录；步骤输入相对于运行目录，不相对于 shell 当前目录。');
    for (const input of step?.inputs ?? []) lines.push(`步骤输入：${join(plan.run, input)}`);
    for (const name of item.required ?? []) lines.push(`完整交付路径：${join(item.outputDir!, name)}`);
    lines.push(`绘画参考：${join(upstream, 'references', config.pipeline === 'clothing-raster-layering' ? 'clothing.png' : 'simplified-subject.png')}（按实际任务与正文用途查看）`,
      'Krita 的实际分层绘制与 KRA 打开检查由执行者完成，CLI 只校验文件格式与是否存在。没有 Krita 能力则停止并报告，不能用空文件或伪造 zip 交付。',
      '逐部件生图时把提示词、已清理的参考图、控制图和结果写在本 job/out 下，传入顺序为 --ref 编辑对象 --ref RGB控制图。透明部件结果加 --background transparent；RGB控制图保持不透明。程序不会自动生成控制图或拼装 KRA。',
      '本仓库没有上游深度修改工具。上游 occlusion.json 保持只读；实际 KRA 多层对应关系与新增穿插需求写入本步 report.md，不能声称已回写到上游。');
    if (item.kind === 'raster') lines.push(commands([`${submit} --note '填写完成情况、偏差与遗留问题'`]));
    else lines.push('审查时须在 Krita 打开全部 KRA 核对层结构；CLI 预览可能仅为 PNG 或参考图，不能替代 KRA 检查。');
    lines.push('', imageTools);
    if (item.prompt) lines.push('', await promptText([join('raster', item.prompt)]));
  }
  const jsonFile = (name: string) => quote(`@${join(dir, 'out', name)}`);
  if (item.kind === 'grouping') {
    lines.push('', '## 预览与提交',
      `在 ${join(dir, 'out/groups.json')} 写本轮分组 JSON 数组，每项 {"name":"face","note":"具体职责"}；按实际对象填写，不直接照抄示例。`,
      commands([preview('view'), `${submit} --groups ${jsonFile('groups.json')} --subject character`]),
      '非角色主体将 --subject 改为 other。');
  } else if (item.kind === 'outline') {
    lines.push('', '## 自检与提交', `将 SVG 写到 ${record.output.draft}。正文所称 .draft.svg 指本 job 的 out/draft.svg。`,
      commands([preview('svg'), preview('blend'), preview('edge'), submit]));
  } else if (item.kind === 'review' || item.kind === 'completion-review') {
    lines.push('', '## 必做审查与通过证据',
      '默认由现有具备识图能力的 Agent 执行审核。用户当前使用的 DeepSeek Flash Agent 可承担此角色；GPT Image 2.5 Sunburst/Flare 用于生图或改图。不配置独立审核模型，也无需用户手工填写审核 JSON；由审核 Agent 看图后写证据并 submit。',
      '绘制与审核职责隔离：宿主执行者将本任务包交给独立审核会话，允许继续使用同一种 Agent 模型。审核者只读参考与候选，只写当前 job/out 下的证据和报告；不能直接改候选 SVG。当前会话若刚负责绘制，应交接任务包，不能把绘制者的自检当作独立审核。',
      '先确认具备实际看图能力。无视觉通道或环境禁止图片进入上下文时报告 blocked，禁止用颜色统计、掩膜、IoU、覆盖率代替视觉审查并提交 pass。',
      `先看 ${record.inputs.reference} 的原图，再运行并实际打开整图独显、叠加和红色边缘图：`,
      commands([preview('svg'), preview('blend'), preview('edge')]),
      `系统选框清单：${join(dir, 'inputs/review-plan.json')}。下面以原图坐标覆盖本候选的完整范围（含外围留边），必须逐块检查，不能只看整图缩略图：`);
    for (const crop of record.review!.regions) lines.push(commands([
      `${preview('blend')} --crop ${crop.join(',')} --scale 2`,
      `${preview('edge')} --crop ${crop.join(',')} --scale 2`,
    ]));
    lines.push('形状先查多画/漏画：孤立长条、异常尖角、误领的衣物与配饰、脸部被头发当成孔洞、颈肩/腰胯/手腕/脚踝接缝都须对照实际原图与职责逐项确认。跨组重叠本身不构成错误，不凭截图配色判断归属。',
      `通过证据模板：${join(dir, 'inputs/review-checks.template.json')}。在 ${join(dir, 'out/review-checks.json')} 填写当前 candidateHash/referenceHash、六项检查的 verdict/detail 和全部选框的实际核对依据；pending/空白不能通过。`,
      '六项分别为 silhouette（外形/异常延伸）、ownership（职责归属）、coverage（应有部件完整性）、holes（真实孔洞与误挖空）、connections（接缝与搭接）、accessories（配饰归属）。detail 必须写图像位置、参考依据与判断，不填“可以/整体一致”。',
      '有明确问题应给 revise，在 feedback 中一次列出问题编号、原图坐标/区域、当前形状、参考依据和应改方式；不能为了凑通过证据把疑点写成 pass。无法核对给 blocked 并报告。',
      `结构化报告模板：${join(dir, 'inputs/agent-review.template.json')}；Agent 可在 out/agent-review.json 填实际模型名、结论、缺陷和已核对区域，提交时加 --report ${jsonFile('agent-review.json')}。findings 每项须有 id/rule/severity/region/description/evidence/repairInstruction/targetStage/status；原图 region 为 [x,y,width,height]。严重未解决缺陷不能 pass，上游缺陷应 blocked，Agent 不得自行 accepted。pass 的 --checks 仍必需。`,
      commands([`${submit} --verdict revise --feedback '填写具体问题与坐标、图像依据和修改要求'`]),
      '只有整图、局部和六项检查全部通过时才执行：',
      commands([`${submit} --verdict pass --checks ${jsonFile('review-checks.json')} --feedback '填写逐项检查结论与证据摘要'`]),
      '候选或参考变化后，旧证据失效，必须重新领取、预览和填写；轮数耗尽但未通过时系统阻塞，不会自动定稿。');
  } else if (item.kind === 'raster-review') {
    lines.push('', '## 看图与提交结论', '默认交给现有具备识图能力且能实际操作 Krita 的 Agent 独立审核会话；不要求另配审核模型 API，绘制者的自检不能替代此审核。', commands([preview('blend'), `${submit} --verdict pass --feedback '填写逐项核对依据'`]),
      '按实际检查将 pass 改为 revise 或 blocked，必须填写具体 feedback。revise 后由 next 派发返修。',
      '只有 pass 可以写完成标记；blocked 不消耗质量轮次，exhausted 停止下游。故障排除后使用 review reopen；人工开启新周期使用 review retry 并记录原因。');
  } else if (item.kind === 'completion') {
    lines.push('', '## 新增路径与提交',
      `在 ${join(dir, 'out/paths.json')} 写新增路径数组，每项 {"d":"闭合路径","fillRule":"nonzero"}，无需新增则写 []。不要直接修改合成草稿或只读底稿。`,
      commands([preview('blend', record.inputs.source), `${submit} --paths ${jsonFile('paths.json')}`, preview('svg'), preview('blend'), `${submit} --note '填写正面遮挡补全与连接余量依据'`]),
      '每次 --paths 都重建草稿并清空旧观测；独显和 blend 必须在最后一次路径修改之后重看。');
  } else if (item.kind === 'reduction') {
    lines.push('', '## 整层去重提交', commands([preview('blend', record.inputs.merged)]),
      '当前实现以本层 stages/outline/<完整ID>.svg 为底稿；未提交组从该底稿复制。');
    for (const id of item.layerIds ?? []) {
      const draft = join(dir, 'out', `${id.replaceAll('/', '--')}.svg`);
      lines.push(`仅需改动 ${id} 时：从 ${outlinePath(plan.run, id)} 制作草稿 ${draft}，保持完整 ID 绑定。`,
        commands([preview('blend', draft), preview('edge', draft), `${submit} --group ${quote(id)} --svg ${quote(draft)}`]));
    }
    lines.push('所有实际改动登记完后结束本层（没有改动也要提交说明）：', commands([`${submit} --note '填写去重依据、保留项与疑点'`]));
  } else if (item.kind === 'children') {
    lines.push('', '## 直属拆分提交',
      `在 ${join(dir, 'out/children.json')} 写 JSON 数组，示例项 {"name":"upper_arm_left","kind":"group","note":"填写具体职责"}，name 须小写 snake_case，kind 只能为 group 或 part。示例按实际对象修改，终止节点写 []，不提交单个 part 包装。`,
      commands([preview('svg'), preview('blend'), `${submit} --children ${jsonFile('children.json')} --note '填写本轮拆分依据'`]));
  } else if (item.kind === 'occlusion') {
    lines.push('', '## 当前实现边界与提交',
      '当前 CLI 每个终止 part 只接受一个 level；不接受正文中的多深度 levels/region。真实多深度需求记入对应 note 并报告限制，不能伪称已表达或自行扩展 schema。',
      `在 ${join(dir, 'out/levels.json')} 写完整提案数组，每项 {"id":"完整part ID","level":0,"note":"前后关系依据"}，覆盖全部终止 part，level 非负且唯一，越大越靠前。`,
      `在 ${join(dir, 'out/checks.json')} 写逐件检查对象 {"完整part ID":"该件核对依据"}。`,
      commands([preview('blend', record.inputs.source), `${submit} --levels ${jsonFile('levels.json')}`, preview('blend'), `${submit} --checks ${jsonFile('checks.json')} --note '填写逐件核对结论与限制'`]),
      '每次 --levels 后须重新查看候选，再填写 checks。');
  }
  lines.push('', '## 继续或停止',
    '本 job 最终 submit 成功后，由执行者运行下面的 next；不要在 --paths、--levels、单组 --group 等中间登记之后提前领取。',
    commands([`${cli} next --run ${quote(plan.run)} --review-rounds ${maxRounds}${expand ? ' --expand' : ''} --json`]),
    '继续读取返回的每个 job 的 INSTRUCTIONS.md。保留本次 --expand 与 --review-rounds 设置；只有用户仅要求当前 job 时才在本步结束。',
    'next 没有 job 时检查 blocked 和 status：存在阻塞或曾提交 blocked 就停止并报告；没有待办且无阻塞时再汇报本阶段完成，不把 part 阶段完成说成 Krita/最终交付已完成。',
    commands([`${cli} status --run ${quote(plan.run)} --json`]),
    `job 目录：${dir}`);
  return lines.join('\n') + '\n';
}
