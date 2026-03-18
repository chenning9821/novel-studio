import type {
	PlanDecisionItem,
	PlanDecisionManifest,
	PlanManifest,
	PlanSection,
	RegeneratePlanInput,
} from "./types.js";
import { FileStore } from "./storage.js";
import { LlmGateway } from "./llm.js";
import { nowIso, slugify } from "./utils.js";

interface GeneratedDecisionPayload {
	decisions: Array<{
		id?: string;
		title?: string;
		description?: string;
		required?: boolean;
		multiple?: boolean;
		options?: Array<{ id?: string; label?: string; description?: string; isOther?: boolean; recommended?: boolean }>;
	}>;
}

const OTHER_OPTION_ID = "__other__";
const DECISION_MIN_COUNT = 8;
const DECISION_MAX_COUNT = 14;
const DECISION_ROUNDS = 4;

function withOtherOption(_decisionId: string, options: PlanDecisionItem["options"]): PlanDecisionItem["options"] {
	const normalized = options.map((option) => ({
		...option,
		isOther: option.id === OTHER_OPTION_ID || option.isOther === true,
		recommended: option.id === OTHER_OPTION_ID ? false : option.recommended === true,
	}));
	const hasOther = normalized.some((option) => option.id === OTHER_OPTION_ID);
	if (!hasOther) {
		normalized.push({
			id: OTHER_OPTION_ID,
			label: "其他（自定义）",
			description: "由用户填写该决策的自定义选择。",
			isOther: true,
			recommended: false,
		});
	}
	return normalized;
}

function fallbackDecisions(): PlanDecisionItem[] {
	return [
		{
			id: "main_conflict_axis",
			title: "主冲突轴心",
			description: "决定故事长期推进的核心矛盾。",
			required: true,
			multiple: false,
			selectedOptionIds: [],
			otherText: "",
			options: withOtherOption("main_conflict_axis", [
				{ id: "order_vs_chaos", label: "秩序对混乱", description: "主角维护秩序，对抗失控力量。", recommended: true },
				{ id: "fate_vs_freewill", label: "宿命对自由", description: "主角抗拒命定剧本，争取主动。" },
				{ id: "growth_vs_cost", label: "成长与代价", description: "每次提升都伴随代价选择。" },
			]),
		},
		{
			id: "hero_temperament",
			title: "主角气质底色",
			description: "影响主角处理冲突的常态手段。",
			required: true,
			multiple: false,
			selectedOptionIds: [],
			otherText: "",
			options: withOtherOption("hero_temperament", [
				{ id: "cold_rational", label: "冷静理性", description: "先算后动，重策略。", recommended: true },
				{ id: "hot_blooded", label: "热血直进", description: "高执行力，先打后想。" },
				{ id: "gentle_firm", label: "温和坚韧", description: "克制但底线明确。" },
			]),
		},
		{
			id: "romance_density",
			title: "情感线密度",
			description: "决定情感描写在主线中的占比。",
			required: true,
			multiple: false,
			selectedOptionIds: [],
			otherText: "",
			options: withOtherOption("romance_density", [
				{ id: "light", label: "轻量点缀", description: "情感作为推动剂，不喧宾夺主。", recommended: true },
				{ id: "balanced", label: "均衡并行", description: "主线与情感线同步推进。" },
				{ id: "intense", label: "高浓度", description: "关键转折主要由情感触发。" },
			]),
		},
		{
			id: "antagonist_design",
			title: "反派塑造方式",
			description: "决定反派层次与压迫感来源。",
			required: true,
			multiple: true,
			selectedOptionIds: [],
			otherText: "",
			options: withOtherOption("antagonist_design", [
				{ id: "smart_enemy", label: "高智对手", description: "反派智商在线，长期博弈。", recommended: true },
				{ id: "power_pressure", label: "实力压制", description: "压迫感来自硬实力差距。" },
				{ id: "moral_ambiguity", label: "价值观冲突", description: "反派有自洽逻辑，非脸谱化。" },
			]),
		},
		{
			id: "world_reveal_pacing",
			title: "世界观揭示节奏",
			description: "决定信息释放的快慢。",
			required: true,
			multiple: false,
			selectedOptionIds: [],
			otherText: "",
			options: withOtherOption("world_reveal_pacing", [
				{ id: "slow_burn", label: "慢揭示", description: "长期悬念，分层透出。", recommended: true },
				{ id: "balanced", label: "中速揭示", description: "每卷稳定揭示关键真相。" },
				{ id: "fast_reveal", label: "快揭示", description: "早期就拉高世界观尺度。" },
			]),
		},
		{
			id: "chapter_rhythm",
			title: "章节节奏模型",
			description: "控制单章推进速度。",
			required: true,
			multiple: false,
			selectedOptionIds: [],
			otherText: "",
			options: withOtherOption("chapter_rhythm", [
				{ id: "tight", label: "紧凑推进", description: "信息密度高，转折频繁。", recommended: true },
				{ id: "wave", label: "波浪节奏", description: "快慢交替，张弛明显。" },
				{ id: "atmospheric", label: "氛围优先", description: "允许留白，沉浸感优先。" },
			]),
		},
		{
			id: "combat_breakthrough",
			title: "战斗破局方式",
			description: "高潮场面主要爽点来源。",
			required: true,
			multiple: true,
			selectedOptionIds: [],
			otherText: "",
			options: withOtherOption("combat_breakthrough", [
				{ id: "strategy", label: "智谋翻盘", description: "布局反制，逆势破局。", recommended: true },
				{ id: "artifact", label: "法宝联动", description: "道具组合形成爆点。" },
				{ id: "realm", label: "境界突破", description: "关键时刻战力跃迁。" },
			]),
		},
		{
			id: "ending_tone",
			title: "结局情绪方向",
			description: "决定最终收束的读后情绪。",
			required: true,
			multiple: false,
			selectedOptionIds: [],
			otherText: "",
			options: withOtherOption("ending_tone", [
				{ id: "bright", label: "明亮收束", description: "主要矛盾解决，保留希望。", recommended: true },
				{ id: "bittersweet", label: "苦甜并存", description: "胜利伴随代价与遗憾。" },
				{ id: "open", label: "开放余波", description: "核心闭环完成，世界仍在变化。" },
			]),
		},
	];
}

function sanitizeDecisionPayload(payload: GeneratedDecisionPayload): PlanDecisionItem[] {
	const rawDecisions = Array.isArray(payload.decisions) ? payload.decisions : [];
	const output: PlanDecisionItem[] = [];

	for (let i = 0; i < rawDecisions.length; i++) {
		const item = rawDecisions[i];
		const id = slugify(item.id?.trim() || `decision-${i + 1}`);
		const title = item.title?.trim() || `决策 ${i + 1}`;
		const description = item.description?.trim() || "";
		const options = Array.isArray(item.options)
			? item.options
					.map((opt, idx) => ({
						id: opt.isOther ? OTHER_OPTION_ID : slugify(opt.id?.trim() || `${id}-option-${idx + 1}`),
						label: opt.label?.trim() || `选项 ${idx + 1}`,
						description: opt.description?.trim() || "",
						isOther: opt.isOther === true || opt.id === OTHER_OPTION_ID,
						recommended: opt.recommended === true && opt.id !== OTHER_OPTION_ID,
					}))
					.filter((opt) => opt.label.length > 0)
			: [];
		if (options.length < 2) {
			continue;
		}
		output.push({
			id,
			title,
			description,
			required: item.required !== false,
			multiple: item.multiple === true,
			options: withOtherOption(id, options),
			selectedOptionIds: [],
			otherText: "",
		});
	}
	return output;
}

function mergeDecisions(base: PlanDecisionItem[], incoming: PlanDecisionItem[]): PlanDecisionItem[] {
	const byId = new Map<string, PlanDecisionItem>();
	for (const item of base) {
		byId.set(item.id, item);
	}
	for (const item of incoming) {
		if (byId.has(item.id)) {
			continue;
		}
		byId.set(item.id, item);
	}
	return Array.from(byId.values());
}


function pickRecommendedOption(decision: PlanDecisionItem): string | null {
	const preferred = decision.options.find((option) => option.id !== OTHER_OPTION_ID && option.recommended === true);
	if (preferred) {
		return preferred.id;
	}
	const fallback = decision.options.find((option) => option.id !== OTHER_OPTION_ID);
	if (fallback) {
		return fallback.id;
	}
	const other = decision.options.find((option) => option.id === OTHER_OPTION_ID);
	return other ? other.id : null;
}

function applyDefaultRecommendedSelections(decisions: PlanDecisionItem[]): void {
	for (const decision of decisions) {
		const optionId = pickRecommendedOption(decision);
		decision.selectedOptionIds = optionId ? [optionId] : [];
		decision.otherText = "";
	}
}
function selectedDecisionSummary(manifest: PlanDecisionManifest): string {
	const lines: string[] = [];
	for (const decision of manifest.decisions) {
		if (decision.selectedOptionIds.length === 0) {
			continue;
		}
		const selectedLabels = decision.options
			.filter((opt) => decision.selectedOptionIds.includes(opt.id) && opt.id !== OTHER_OPTION_ID)
			.map((opt) => opt.label);
		const segments = [...selectedLabels];
		if (decision.selectedOptionIds.includes(OTHER_OPTION_ID)) {
			if (decision.otherText && decision.otherText.trim().length > 0) {
				segments.push(`其他（自定义）：${decision.otherText.trim()}`);
			} else {
				segments.push("其他（自定义）：未填写");
			}
		}
		if (segments.length > 0) {
			lines.push(`- ${decision.title}: ${segments.join("；")}`);
		}
	}
	return lines.join("\n");
}

function normalizePlanText(raw: unknown): string {
	if (typeof raw === "string") {
		return raw.trim();
	}
	if (raw === null || raw === undefined) {
		return "";
	}
	if (Array.isArray(raw)) {
		return raw.map((item) => normalizePlanText(item)).filter((item) => item.length > 0).join("\n\n").trim();
	}
	if (typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		if (typeof obj.content === "string") {
			return obj.content.trim();
		}
		if (typeof obj.plan === "string") {
			return obj.plan.trim();
		}
		try {
			return JSON.stringify(obj, null, 2).trim();
		} catch {
			return "";
		}
	}
	return String(raw).trim();
}

function getMasterSection(manifest: PlanManifest): PlanSection {
	const current = manifest.sections.find((section) => section.id === "master_plan") || manifest.sections[0];
	if (current) {
		return current;
	}
	const now = nowIso();
	return {
		id: "master_plan",
		title: "总策划 Plan（兼粗纲）",
		required: true,
		locked: false,
		content: "",
		updatedAt: now,
	};
}

function formatPlanManifest(manifest: PlanManifest): string {
	const section = getMasterSection(manifest);
	return section.content.trim();
}

export class PlanService {
	private readonly store: FileStore;
	private readonly llm: LlmGateway;

	constructor(store: FileStore, llm: LlmGateway) {
		this.store = store;
		this.llm = llm;
	}

	async generateDecisionManifest(projectId: string): Promise<PlanDecisionManifest> {
		const project = await this.store.loadProject(projectId);
		const current = await this.store.loadDecisionManifest(projectId);

		let decisions: PlanDecisionItem[] = [];
		for (let round = 1; round <= DECISION_ROUNDS && decisions.length < DECISION_MAX_COUNT; round++) {
			const existingTitles = decisions.map((item) => `- ${item.title} (${item.id})`).join("\n") || "（暂无）";
			const systemPrompt = [
				"你是小说创作决策设计器。",
				"请输出 JSON：{ decisions: [{ id,title,description,required,multiple,options:[{id,label,description,isOther,recommended}] }] }",
				"每轮至少输出 4 个高质量决策，每个决策至少 3 个选项。",
				"每个决策必须给出 1 个推荐选项（recommended=true）。",
				"选项应具体且可执行，禁止空泛措辞。",
				"你可以自行给出 isOther=true 的选项，但系统也会补充“其他（自定义）”。",
			].join("\n");

			const userPrompt = [
				`项目标题：${project.title}`,
				`创作总提示词：${project.preferences.prompt || "无"}`,
				`题材：${project.preferences.genre}`,
				`主题：${project.preferences.theme}`,
				`文风：${project.preferences.style}`,
				`禁忌：${project.preferences.taboos}`,
				`当前轮次：${round}/${DECISION_ROUNDS}`,
				"已生成候选（避免重复）：",
				existingTitles,
				"请补充新的决策候选。",
			].join("\n\n");

			try {
				const payload = await this.llm.completeJson<GeneratedDecisionPayload>(systemPrompt, userPrompt, undefined, {
					workflowStage: "decisions",
					operation: `generate_decisions_round_${round}`,
					projectId,
				});
				decisions = mergeDecisions(decisions, sanitizeDecisionPayload(payload));
			} catch {
				// Ignore one-round failure and continue collecting from subsequent rounds.
			}
		}

		if (decisions.length < DECISION_MIN_COUNT) {
			decisions = mergeDecisions(decisions, fallbackDecisions());
		}

		decisions = decisions.slice(0, DECISION_MAX_COUNT);
		applyDefaultRecommendedSelections(decisions);

		const manifest: PlanDecisionManifest = {
			version: current.version + 1,
			generatedAt: nowIso(),
			completed: false,
			decisions,
		};

		await this.store.saveDecisionManifest(projectId, manifest);
		return manifest;
	}

	async applyDecisionSelections(
		projectId: string,
		selections: Record<string, string[]>,
		otherTextByDecision: Record<string, string> = {},
	): Promise<PlanDecisionManifest> {
		const manifest = await this.store.loadDecisionManifest(projectId);

		for (const decision of manifest.decisions) {
			const incoming = Array.isArray(selections[decision.id]) ? selections[decision.id] : [];
			const validSet = new Set(decision.options.map((opt) => opt.id));
			const deduped = Array.from(new Set(incoming.filter((id) => validSet.has(id))));
			decision.selectedOptionIds = decision.multiple ? deduped : deduped.slice(0, 1);
			const otherSelected = decision.selectedOptionIds.includes(OTHER_OPTION_ID);
			decision.otherText = otherSelected ? String(otherTextByDecision[decision.id] || "").trim() : "";
		}

		manifest.completed = manifest.decisions
			.filter((decision) => decision.required)
			.every((decision) => {
				if (decision.selectedOptionIds.length === 0) {
					return false;
				}
				if (!decision.selectedOptionIds.includes(OTHER_OPTION_ID)) {
					return true;
				}
				return Boolean(decision.otherText && decision.otherText.trim().length > 0);
			});
		manifest.appliedAt = nowIso();
		await this.store.saveDecisionManifest(projectId, manifest);
		return manifest;
	}

	private async decisionContext(projectId: string): Promise<string> {
		const manifest = await this.store.loadDecisionManifest(projectId);
		return selectedDecisionSummary(manifest);
	}

	async generateFullPlan(projectId: string): Promise<PlanManifest> {
		const project = await this.store.loadProject(projectId);
		const current = await this.store.loadPlanManifest(projectId);
		const decisionManifest = await this.store.loadDecisionManifest(projectId);
		if (!decisionManifest.completed) {
			throw new Error("请先完成创作决策选择，再生成 Plan。");
		}

		const decisionContext = await this.decisionContext(projectId);
		const systemPrompt = [
			"你是长篇小说总策划。",
			"请输出完整 Markdown 计划书（单一整包），可直接作为后续粗纲使用。",
			"不要输出 JSON，不要解释。",
		].join("\n");
		const userPrompt = [
			`项目标题：${project.title}`,
			`创作总提示词：${project.preferences.prompt || "无"}`,
			`题材：${project.preferences.genre}`,
			`主题：${project.preferences.theme}`,
			`文风：${project.preferences.style}`,
			`禁忌：${project.preferences.taboos}`,
			`语言：${project.preferences.language}`,
			`卷数：${project.preferences.volumeCount}`,
			`每卷章节：${project.preferences.chaptersPerVolume}`,
			`目标全文字数：${project.wordBudget.targetTotalWords}`,
			"用户决策：",
			decisionContext || "（无）",
			"必须至少覆盖：主题命题、世界规则、角色圣经、卷级目标、章节预算、一致性风险。",
			"请直接输出 Plan 正文。",
		].join("\n\n");

		const generated = await this.llm.completeText(systemPrompt, userPrompt, undefined, {
			workflowStage: "plan_review",
			operation: "generate_plan_initial",
			projectId,
		});
		const planContent = normalizePlanText(generated);
		if (!planContent) {
			throw new Error("Plan 生成结果为空");
		}

		const master = getMasterSection(current);
		const next: PlanManifest = {
			version: current.version + 1,
			confirmed: false,
			sections: [
				{
					...master,
					id: "master_plan",
					title: "总策划 Plan（兼粗纲）",
					required: true,
					locked: false,
					content: planContent,
					updatedAt: nowIso(),
				},
			],
		};
		await this.store.setPlanManifest(projectId, next);
		return next;
	}

	async regenerateFullPlan(projectId: string, input: RegeneratePlanInput = {}): Promise<PlanManifest> {
		const project = await this.store.loadProject(projectId);
		const current = await this.store.loadPlanManifest(projectId);
		const decisionManifest = await this.store.loadDecisionManifest(projectId);
		if (!decisionManifest.completed) {
			throw new Error("请先完成创作决策选择，再生成 Plan。");
		}
		const decisionContext = await this.decisionContext(projectId);
		const currentPlan = formatPlanManifest(current);
		const systemPrompt = [
			"你是长篇小说总策划。",
			"请根据补充信息，重写并升级整个 Plan。",
			"输出 Markdown 正文，不要输出 JSON。",
		].join("\n");
		const userPrompt = [
			`项目标题：${project.title}`,
			`创作总提示词：${project.preferences.prompt || "无"}`,
			`补充修订信息：${input.guidance || "无"}`,
			"用户决策：",
			decisionContext || "（无）",
			"当前 Plan（请继承有效内容并整体升级）：",
			currentPlan || "（空）",
		].join("\n\n");

		const regenerated = await this.llm.completeText(systemPrompt, userPrompt, undefined, {
			workflowStage: "plan_review",
			operation: "regenerate_plan_full",
			projectId,
		});
		const planContent = normalizePlanText(regenerated);
		if (!planContent) {
			throw new Error("Plan 重生结果为空");
		}

		const master = getMasterSection(current);
		const next: PlanManifest = {
			version: current.version + 1,
			confirmed: false,
			sections: [
				{
					...master,
					id: "master_plan",
					title: "总策划 Plan（兼粗纲）",
					required: true,
					locked: false,
					content: planContent,
					updatedAt: nowIso(),
				},
			],
		};
		await this.store.setPlanManifest(projectId, next);
		return next;
	}

	async regenerateSection(projectId: string, sectionId: string, guidance: string): Promise<PlanManifest> {
		if (sectionId !== "master_plan") {
			throw new Error("当前版本仅支持整包 Plan 重生，请使用补充信息重新生成。");
		}
		return this.regenerateFullPlan(projectId, { guidance });
	}
}



