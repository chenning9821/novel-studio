import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgenticReviewReport, LlmCallTelemetryEvent, ModelProfile, NovelProject } from "./types.js";
import { FileStore } from "./storage.js";
import { MemoryManager } from "./memory.js";
import { createId, nowIso, parseJsonObject } from "./utils.js";

const REVIEW_SKILLS = [
	"连续性审计：检查事件与动机是否前后一致。",
	"人物一致性审计：检查角色能力、关系、口吻是否漂移。",
	"时间线审计：检查时间顺序、间隔、同一事件的前后冲突。",
	"世界规则审计：检查设定硬规则是否被违反。",
	"伏笔兑现审计：检查伏笔是否遗忘或误兑现。",
	"文风与禁忌审计：检查是否偏离风格卡与禁忌约束。",
];

function toModel(profile: ModelProfile): Model<any> {
	return {
		id: profile.modelId,
		name: profile.modelId,
		api: profile.api,
		provider: profile.provider,
		baseUrl: profile.baseUrl,
		reasoning: profile.thinking !== "off",
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128_000,
		maxTokens: profile.maxTokens,
	};
}

function defaultReviewReport(errorMessage: string): AgenticReviewReport {
	return {
		passed: false,
		score: 0,
		summary: errorMessage,
		issues: [],
		suggestedActions: ["无法解析审查报告，请重试审查回合。"],
	};
}

function extractAssistantText(messages: Array<{ role: string; content: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") {
			continue;
		}
		if (!Array.isArray(msg.content)) {
			continue;
		}
		return (msg.content as Array<{ type: string; text?: string }>)
			.filter((block) => block.type === "text")
			.map((block) => block.text || "")
			.join("\n")
			.trim();
	}
	return "";
}

export class ReviewAgent {
	private readonly store: FileStore;
	private readonly memoryManager: MemoryManager;
	private readonly telemetrySink?: (event: LlmCallTelemetryEvent) => Promise<void> | void;

	constructor(
		store: FileStore,
		memoryManager: MemoryManager,
		telemetrySink?: (event: LlmCallTelemetryEvent) => Promise<void> | void,
	) {
		this.store = store;
		this.memoryManager = memoryManager;
		this.telemetrySink = telemetrySink;
	}

	private async emitTelemetry(event: LlmCallTelemetryEvent): Promise<void> {
		if (!this.telemetrySink) {
			return;
		}
		try {
			await this.telemetrySink(event);
		} catch {
			// Ignore telemetry sink errors.
		}
	}

	async runReview(
		project: NovelProject,
		profile: ModelProfile,
		chapterStart: number,
		chapterEnd: number,
		reviewRound: number,
	): Promise<AgenticReviewReport> {
		const projectRoot = this.store.projectDir(project.id);
		const tools = this.createReviewTools(project.id, projectRoot);
		const agent = new Agent({
			initialState: {
				systemPrompt: this.buildSystemPrompt(project),
				model: toModel(profile),
				thinkingLevel: profile.thinking,
				messages: [],
				tools,
			},
			getApiKey: async () => profile.apiKey,
			onPayload: async (payload) => {
				if (!payload || typeof payload !== "object") {
					return payload;
				}
				const next = { ...(payload as Record<string, unknown>) };
				next.top_p = profile.topP;
				if (profile.extraBody) {
					for (const [key, value] of Object.entries(profile.extraBody)) {
						next[key] = value;
					}
				}
				return next;
			},
			maxRetryDelayMs: profile.retry.maxDelayMs,
		});

		const prompt = [
			`审查范围：全局章节 ${chapterStart}-${chapterEnd}`,
			`审查轮次：${reviewRound}`,
			"你必须自主调用工具收集证据，至少覆盖：大纲、章节、记忆账本。",
			"最后必须输出 JSON 对象：",
			`{"passed":boolean,"score":0-100,"summary":string,"issues":[{"severity":"low|medium|high","title":string,"description":string,"evidence":string,"affectedChapters":string[],"suggestedFix":string}],"suggestedActions":string[]}`,
			"只输出 JSON，不要额外文本。",
		].join("\n");

		const callId = createId();
		const startedAt = Date.now();
		const maxAttempts = profile.retry.maxRetries + 1;
		await this.emitTelemetry({
			kind: "call_start",
			timestamp: nowIso(),
			callId,
			modelId: profile.modelId,
			provider: profile.provider,
			maxTokens: profile.maxTokens,
			workflowStage: "generating",
			operation: "agentic_review_round",
			projectId: project.id,
			maxAttempts,
		});
		await this.emitTelemetry({
			kind: "attempt_start",
			timestamp: nowIso(),
			callId,
			modelId: profile.modelId,
			provider: profile.provider,
			maxTokens: profile.maxTokens,
			workflowStage: "generating",
			operation: "agentic_review_round",
			projectId: project.id,
			attempt: 1,
			maxAttempts,
		});

		try {
			await agent.prompt(prompt);
			const text = extractAssistantText(agent.state.messages as Array<{ role: string; content: unknown }>);
			const report = parseJsonObject<AgenticReviewReport>(text);
			if (!report) {
				await this.emitTelemetry({
					kind: "call_failed",
					timestamp: nowIso(),
					callId,
					modelId: profile.modelId,
					provider: profile.provider,
					maxTokens: profile.maxTokens,
					workflowStage: "generating",
					operation: "agentic_review_round",
					projectId: project.id,
					attempt: 1,
					maxAttempts,
					elapsedMs: Date.now() - startedAt,
					error: `审查输出无法解析为 JSON: ${text.slice(0, 200)}`,
				});
				return defaultReviewReport(`审查输出无法解析为 JSON: ${text.slice(0, 200)}`);
			}
			await this.emitTelemetry({
				kind: "call_success",
				timestamp: nowIso(),
				callId,
				modelId: profile.modelId,
				provider: profile.provider,
				maxTokens: profile.maxTokens,
				workflowStage: "generating",
				operation: "agentic_review_round",
				projectId: project.id,
				attempt: 1,
				maxAttempts,
				elapsedMs: Date.now() - startedAt,
				responseChars: text.length,
			});
			return {
				passed: !!report.passed,
				score: Number.isFinite(report.score) ? report.score : 0,
				summary: report.summary || "",
				issues: Array.isArray(report.issues) ? report.issues : [],
				suggestedActions: Array.isArray(report.suggestedActions) ? report.suggestedActions : [],
			};
		} catch (error) {
			await this.emitTelemetry({
				kind: "call_failed",
				timestamp: nowIso(),
				callId,
				modelId: profile.modelId,
				provider: profile.provider,
				maxTokens: profile.maxTokens,
				workflowStage: "generating",
				operation: "agentic_review_round",
				projectId: project.id,
				attempt: 1,
				maxAttempts,
				elapsedMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			});
			return defaultReviewReport(error instanceof Error ? error.message : String(error));
		}
	}

	private buildSystemPrompt(project: NovelProject): string {
		return [
			"你是 agentic 小说审查代理。",
			"你的职责是查出连续性、人设、时间线、世界规则、伏笔、文风与禁忌问题。",
			"你不能写文件，只能读取和分析。",
			`项目标题：${project.title}`,
			`创作提示词：${project.preferences.prompt || "无"}`,
			`风格：${project.preferences.style}`,
			`禁忌：${project.preferences.taboos}`,
			"可用技能：",
			...REVIEW_SKILLS.map((skill) => `- ${skill}`),
		].join("\n");
	}

	private createReviewTools(projectId: string, projectRoot: string): AgentTool<any>[] {
		const guardPath = (inputPath: string): string => {
			const resolved = resolve(projectRoot, inputPath);
			if (!resolved.startsWith(projectRoot)) {
				throw new Error(`Path escapes project root: ${inputPath}`);
			}
			return resolved;
		};

		const listFilesSchema = Type.Object({
			path: Type.Optional(Type.String({ description: "项目内相对路径" })),
		});
		const readFileSchema = Type.Object({
			path: Type.String({ description: "项目内相对路径" }),
		});
		const grepSchema = Type.Object({
			query: Type.String({ description: "检索词" }),
		});
		const memoryQuerySchema = Type.Object({
			query: Type.String({ description: "查询目标" }),
		});
		const chapterStatsSchema = Type.Object({});

		const listFilesTool: AgentTool<typeof listFilesSchema, { count: number }> = {
			name: "list_files",
			label: "list_files",
			description: "列出项目内文件。",
			parameters: listFilesSchema,
			execute: async (_id, params) => {
				const base = params.path ? guardPath(params.path) : projectRoot;
				const output: string[] = [];
				const walk = async (dir: string) => {
					const entries = await readdir(dir, { withFileTypes: true });
					for (const entry of entries) {
						const absolute = join(dir, entry.name);
						const rel = relative(projectRoot, absolute).replaceAll("\\", "/");
						if (entry.isDirectory()) {
							await walk(absolute);
						} else {
							output.push(rel);
						}
					}
				};
				await walk(base);
				output.sort();
				return {
					content: [{ type: "text", text: output.join("\n") }],
					details: { count: output.length },
				};
			},
		};

		const readFileTool: AgentTool<typeof readFileSchema, { bytes: number }> = {
			name: "read_file",
			label: "read_file",
			description: "读取项目内文件。",
			parameters: readFileSchema,
			execute: async (_id, params) => {
				const absolute = guardPath(params.path);
				const text = await readFile(absolute, "utf8");
				return {
					content: [{ type: "text", text }],
					details: { bytes: Buffer.byteLength(text, "utf8") },
				};
			},
		};

		const grepTextTool: AgentTool<typeof grepSchema, { count: number }> = {
			name: "grep_text",
			label: "grep_text",
			description: "全文检索关键词。",
			parameters: grepSchema,
			execute: async (_id, params) => {
				const files = await this.store.readProjectFileTree(projectId);
				const matches: string[] = [];
				for (const relativePath of files) {
					if (!relativePath.endsWith(".md") && !relativePath.endsWith(".json")) {
						continue;
					}
					const normalized = relativePath.replace(/^\.\//, "");
					const absolute = guardPath(normalized);
					const content = await readFile(absolute, "utf8");
					const lines = content.split("\n");
					for (let i = 0; i < lines.length; i++) {
						if (lines[i].includes(params.query)) {
							matches.push(`${normalized}:${i + 1}: ${lines[i]}`);
						}
					}
				}
				return {
					content: [{ type: "text", text: matches.slice(0, 500).join("\n") || "NO_MATCH" }],
					details: { count: matches.length },
				};
			},
		};

		const loadMemoryTool: AgentTool<typeof memoryQuerySchema, { length: number }> = {
			name: "memory_query",
			label: "memory_query",
			description: "按查询读取记忆摘要。",
			parameters: memoryQuerySchema,
			execute: async (_id, params) => {
				const digest = await this.memoryManager.loadMemoryDigest(projectId, params.query);
				return {
					content: [{ type: "text", text: digest }],
					details: { length: digest.length },
				};
			},
		};

		const chapterStatsTool: AgentTool<typeof chapterStatsSchema, { count: number }> = {
			name: "chapter_stats",
			label: "chapter_stats",
			description: "统计章节文件规模。",
			parameters: chapterStatsSchema,
			execute: async () => {
				const chapters = await this.store.listChapterFiles(projectId);
				const rows: string[] = [];
				for (const chapter of chapters) {
					const text = await readFile(chapter, "utf8");
					rows.push(`${relative(projectRoot, chapter).replaceAll("\\", "/")}: ${text.length} chars`);
				}
				return {
					content: [{ type: "text", text: rows.join("\n") }],
					details: { count: rows.length },
				};
			},
		};

		return [listFilesTool, readFileTool, grepTextTool, loadMemoryTool, chapterStatsTool];
	}
}
