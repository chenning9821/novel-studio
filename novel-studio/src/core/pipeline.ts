import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
	AgenticReviewIssue,
	ChapterPayloadV1,
	ContextPackStats,
	FineOutlineIndex,
	NovelProject,
	PipelineState,
	VolumePlan,
} from "./types.js";
import { FileStore } from "./storage.js";
import { LlmGateway } from "./llm.js";
import { MemoryManager } from "./memory.js";
import { ReviewAgent } from "./review-agent.js";
import { countWords, nowIso, pad, slugify } from "./utils.js";
import { buildSerialRange } from "./sequence.js";
import { sanitizeGeneratedChapter } from "./chapter-cleanup.js";
import {
	buildChapterContextPackV1,
	buildFineOutlineContextPackV1,
	CHAPTER_PROTOCOL,
	decisionManifestToContextText,
	FINE_OUTLINE_PROTOCOL,
	parseChapterPayloadV1Lenient,
	parseChapterPayloadV1Strict,
	validateChapterPayloadV1,
	validateFineOutlinePayloadV1Schema,
} from "./generation-protocol.js";
import {
	compileStructuredFineVolume,
	createInitialFineControlState,
	parseStructuredFineVolume,
	parseStructuredFineVolumeLenient,
	repairStructuredFineVolumeDeterministic,
} from "./fine-outline-control.js";

export type RunnerEventEmitter = (
	projectId: string,
	type:
		| "info"
		| "warning"
		| "error"
		| "stage_change"
		| "progress"
		| "fine_control"
		| "json_parse"
		| "context_pack"
		| "review_report"
		| "chapter_generated"
		| "chapter_stream",
	message: string,
	data?: Record<string, unknown>,
) => Promise<void>;

interface VolumeGenerationResult {
	volumeTitle: string;
	volumeSlug: string;
	outlineMarkdown: string;
	chapterGoals: string[];
	segmentCount: number;
	coverage: number;
	trimCount: number;
	warnings: string[];
	failedAttempts: number;
}

interface GeneratedChapterResult {
	chapterRef: string;
	chapterSlug: string;
	path: string;
	content: string;
}

function extractVolumeAndChapter(ref: string): { volume: number; chapter: number } | null {
	const match = ref.match(/v\s*(\d+)\s*[-_ ]\s*c\s*(\d+)/i) || ref.match(/(\d+)[^0-9]+(\d+)/);
	if (!match || !match[1] || !match[2]) {
		return null;
	}
	const volume = Number.parseInt(match[1], 10);
	const chapter = Number.parseInt(match[2], 10);
	if (!Number.isFinite(volume) || !Number.isFinite(chapter)) {
		return null;
	}
	return { volume, chapter };
}

export class PipelineRunner {
	private readonly projectId: string;
	private readonly store: FileStore;
	private readonly llm: LlmGateway;
	private readonly memoryManager: MemoryManager;
	private readonly reviewAgent: ReviewAgent;
	private readonly emitEvent: RunnerEventEmitter;
	private isRunning = false;

	constructor(
		projectId: string,
		store: FileStore,
		llm: LlmGateway,
		memoryManager: MemoryManager,
		reviewAgent: ReviewAgent,
		emitEvent: RunnerEventEmitter,
	) {
		this.projectId = projectId;
		this.store = store;
		this.llm = llm;
		this.memoryManager = memoryManager;
		this.reviewAgent = reviewAgent;
		this.emitEvent = emitEvent;
	}

	async run(): Promise<void> {
		if (this.isRunning) {
			return;
		}
		this.isRunning = true;
		try {
			await this.markRunning();
			await this.loop();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.failWithError(message);
		} finally {
			this.isRunning = false;
		}
	}

	async requestStop(): Promise<void> {
		const state = await this.store.loadPipelineState(this.projectId);
		state.stopRequested = true;
		await this.store.savePipelineState(state);
	}

	async requestTerminate(): Promise<void> {
		const state = await this.store.loadPipelineState(this.projectId);
		state.stopRequested = true;
		state.terminated = true;
		state.isRunning = false;
		state.status = "terminated";
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "stage_change", "Task terminated", { status: state.status });
	}

	private async loop(): Promise<void> {
		while (true) {
			const project = await this.store.loadProject(this.projectId);
			const state = await this.store.loadPipelineState(this.projectId);

			if (state.terminated) {
				await this.finish(state);
				return;
			}
			if (state.stopRequested) {
				state.isRunning = false;
				if (state.status !== "terminated") {
					state.status = "paused_stopped";
				}
				await this.store.savePipelineState(state);
				await this.emitEvent(this.projectId, "stage_change", "Task paused", { status: state.status });
				return;
			}

			if (!project.planManifest.confirmed) {
				throw new Error("Plan is not confirmed; pipeline cannot start");
			}

			if (state.status === "idle" || state.status === "plan_ready" || state.status === "coarse_generating") {
				const coarseDone = await this.generateCoarse(project, state);
				if (!coarseDone) {
					return;
				}
				continue;
			}

			if (state.status === "coarse_ready" || state.status === "fine_generating") {
				const fineDone = await this.generateFine(project, state);
				if (!fineDone) {
					return;
				}
				continue;
			}

			if (state.status === "fine_ready" || state.status === "chapters_generating" || state.status === "reviewing") {
				const chaptersDone = await this.generateChapters(project, state);
				if (!chaptersDone) {
					return;
				}
				continue;
			}

			if (state.status === "completed") {
				await this.finish(state);
				return;
			}

			if (state.status === "paused_ratio_failed" || state.status === "paused_review_failed" || state.status === "error") {
				state.isRunning = false;
				await this.store.savePipelineState(state);
				return;
			}
		}
	}

	private async markRunning(): Promise<void> {
		const state = await this.store.loadPipelineState(this.projectId);
		state.isRunning = true;
		state.stopRequested = false;
		if (state.status === "idle") {
			state.status = "plan_ready";
		}
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "stage_change", "Task started", { status: state.status });
	}

	private async finish(state: PipelineState): Promise<void> {
		state.isRunning = false;
		await this.store.savePipelineState(state);
	}

	private async failWithError(message: string): Promise<void> {
		const state = await this.store.loadPipelineState(this.projectId);
		state.status = "error";
		state.isRunning = false;
		state.lastError = message;
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "error", `Pipeline failed: ${message}`);
	}

	private planText(project: NovelProject): string {
		const lines: string[] = [];
		for (const section of project.planManifest.sections) {
			lines.push(`## ${section.title}`);
			lines.push(section.content);
			lines.push("");
		}
		return lines.join("\n");
	}

	private async generateCoarse(project: NovelProject, state: PipelineState): Promise<boolean> {
		state.status = "coarse_generating";
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "stage_change", "Sync Plan as coarse outline", { stage: state.status });

		const coarse = this.planText(project).trim();
		if (!coarse) {
			throw new Error("Plan content is empty, cannot be used as coarse outline");
		}
		await this.store.writeCoarseOutline(project.id, coarse);

		state.status = "coarse_ready";
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "progress", "Plan synced as coarse outline", {
			actualWords: countWords(coarse),
		});
		return true;
	}

	private async generateFine(project: NovelProject, state: PipelineState): Promise<boolean> {
		state.status = "fine_generating";
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "stage_change", "Start serial fine outline generation", { stage: state.status });

		const coarse = await this.store.readCoarseOutline(project.id);
		const totalVolumes = project.preferences.volumeCount;
		const policy = project.fineOutlineControl;
		let resumeFrom = Math.max(1, state.fineVolumeCursor || 1);
		const existingMeta = await this.store.readFineMeta(project.id);
		let volumePlans: VolumePlan[] = [];

		if (resumeFrom > 1 && existingMeta?.volumePlans?.length) {
			volumePlans = existingMeta.volumePlans.filter((volume) => volume.volumeNo < resumeFrom);
			if (volumePlans.length !== resumeFrom - 1) {
				resumeFrom = 1;
				volumePlans = [];
				state.fineVolumeCursor = 1;
				state.fineControlState = createInitialFineControlState();
				await this.emitEvent(this.projectId, "warning", "Fine outline checkpoint missing; restart from volume 1");
			}
		}

		if (resumeFrom === 1) {
			await rm(this.store.projectFineDir(project.id), { recursive: true, force: true });
			await mkdir(this.store.projectFineDir(project.id), { recursive: true });
			state.fineControlState = createInitialFineControlState();
			await this.store.savePipelineState(state);
		}

		for (const volumeNo of buildSerialRange(resumeFrom, totalVolumes)) {
			if (await this.shouldStop()) {
				return false;
			}

			state.fineVolumeCursor = volumeNo;
			state.fineControlState.currentVolume = volumeNo;
			await this.store.savePipelineState(state);
			await this.emitEvent(this.projectId, "fine_control", `Fine volume ${volumeNo} started`, {
				kind: "volume_started",
				volumeNo,
				segmentSize: policy.segmentSize,
				maxPointsPerSegment: policy.maxPointsPerSegment,
				maxCharsPerPoint: policy.maxCharsPerPoint,
			});

			const generated = await this.generateSingleVolumeFine(project, coarse, volumeNo);
			const outlinePath = `${pad(volumeNo)}-${generated.volumeSlug}.md`;
			await this.store.writeFineOutline(project.id, volumeNo, generated.volumeSlug, generated.outlineMarkdown);

			const existingIndex = volumePlans.findIndex((item) => item.volumeNo === volumeNo);
			const volumePlan: VolumePlan = {
				volumeNo,
				title: generated.volumeTitle,
				slug: generated.volumeSlug,
				chapterGoals: generated.chapterGoals,
				outlinePath,
			};
			if (existingIndex >= 0) {
				volumePlans[existingIndex] = volumePlan;
			} else {
				volumePlans.push(volumePlan);
			}
			volumePlans.sort((a, b) => a.volumeNo - b.volumeNo);

			state.fineControlState.volumeCoverage[String(volumeNo)] = generated.coverage;
			state.fineControlState.totalSegments += generated.segmentCount;
			state.fineControlState.trimCount += generated.trimCount;
			state.fineControlState.failedAttempts += generated.failedAttempts;
			if (generated.warnings.length > 0) {
				const mergedWarnings = new Set([...state.fineControlState.warnings, ...generated.warnings]);
				state.fineControlState.warnings = Array.from(mergedWarnings).slice(-100);
			}

			state.fineVolumeCursor = volumeNo + 1;
			await this.store.savePipelineState(state);

			await this.emitEvent(this.projectId, "progress", `Volume ${volumeNo} fine outline saved`, {
				volumeNo,
				outlinePath,
			});
			await this.emitEvent(this.projectId, "fine_control", `Fine volume ${volumeNo} coverage passed`, {
				kind: "coverage_passed",
				volumeNo,
				coverage: generated.coverage,
				segmentCount: generated.segmentCount,
				trimCount: generated.trimCount,
				warnings: generated.warnings,
			});
		}

		const fineIndex: FineOutlineIndex = {
			generatedAt: nowIso(),
			volumePlans,
		};
		await this.store.writeFineMeta(project.id, fineIndex);
		await this.store.writeFineIndex(project.id, this.buildFineIndexMarkdown(fineIndex));

		state.status = "fine_ready";
		state.fineVolumeCursor = 1;
		state.fineControlState.currentVolume = 1;
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "fine_control", "Fine outline generation completed", {
			kind: "completed",
			totalVolumes: volumePlans.length,
			totalSegments: state.fineControlState.totalSegments,
			trimCount: state.fineControlState.trimCount,
			failedAttempts: state.fineControlState.failedAttempts,
		});
		return true;
	}
	private async generateSingleVolumeFine(project: NovelProject, coarse: string, volumeNo: number): Promise<VolumeGenerationResult> {
		const policy = project.fineOutlineControl;
		const maxAttempts = Math.max(1, policy.maxRetriesPerVolume);
		const chaptersPerVolume = project.preferences.chaptersPerVolume;
		let failedAttempts = 0;
		let lastFailureReason = "unknown";
		let lastParseStage = "strict_json_parse";
		let lastPreview = "";

		const decisionManifest = await this.store.loadDecisionManifest(project.id);
		const memoryLedgerText = await this.loadFineMemoryLedgers(project.id);
		const volumeConfigText = [
			`volumeNo=${volumeNo}`,
			`chaptersPerVolume=${chaptersPerVolume}`,
			`segmentSize=${policy.segmentSize}`,
			`maxPointsPerSegment=${policy.maxPointsPerSegment}`,
			`maxCharsPerPoint=${policy.maxCharsPerPoint}`,
			`requiredFields=${policy.requiredFields.join(",")}`,
		].join("\n");
		const rulesAndTaboosText = [
			`genre=${project.preferences.genre}`,
			`theme=${project.preferences.theme}`,
			`style=${project.preferences.style}`,
			`language=${project.preferences.language}`,
			`taboos=${project.preferences.taboos}`,
		].join("\n");
		const contextPack = buildFineOutlineContextPackV1({
			planText: coarse,
			decisionText: decisionManifestToContextText(decisionManifest),
			volumeConfigText,
			rulesAndTaboosText,
			memoryLedgerText,
		});
		await this.emitContextPack("fine_outline", contextPack.stats, {
			volumeNo,
		});

		const toPreview = (value: string): string => value.replace(/\s+/g, " ").trim().slice(0, 240);

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const systemPrompt = [
				"Role/Task:",
				"You are a long-form novel outline planner.",
				"Build one volume fine outline as strict JSON.",
				"",
				"Output contract:",
				"Return JSON object only.",
				"Schema: { volumeTitle, volumeSlug, segments:[{ startChapter,endChapter,goal,conflict,turn,hook,points:string[] }] }",
				"",
				"Forbidden output:",
				"No markdown fences.",
				"No explanations.",
				"No extra keys outside schema.",
			].join("\n");
			const userPrompt = [
				"Input context block (higher priority first):",
				contextPack.context,
				"",
				`Target volume=${volumeNo}`,
				`Coverage requirement: chapters 1..${chaptersPerVolume} with no gaps and no overlaps.`,
				`Creative prompt: ${project.preferences.prompt || "none"}`,
			].join("\n");

			const raw = await this.llm.completeText(systemPrompt, userPrompt, undefined, {
				workflowStage: "generating",
				operation: `generate_fine_volume_${volumeNo}`,
				projectId: project.id,
				protocol: FINE_OUTLINE_PROTOCOL.name,
				protocolVersion: FINE_OUTLINE_PROTOCOL.version,
			});
			const rawPreview = toPreview(raw);
			lastPreview = rawPreview;

			let repairUsed = false;
			let parseStage = "strict_json_parse";
			let parsed = parseStructuredFineVolume(raw);
			await this.emitJsonParse("fine_outline", {
				volumeNo,
				attempt,
				maxAttempts,
				parseStage,
				success: Boolean(parsed),
				reason: parsed ? "ok" : "structured_json_invalid",
				responsePreview: rawPreview,
			});

			if (!parsed) {
				parseStage = "local_json_extract_parse";
				parsed = parseStructuredFineVolumeLenient(raw, {
					chaptersPerVolume,
					segmentSize: policy.segmentSize,
				});
				await this.emitJsonParse("fine_outline", {
					volumeNo,
					attempt,
					maxAttempts,
					parseStage,
					success: Boolean(parsed),
					reason: parsed ? "ok" : "structured_json_invalid",
					responsePreview: rawPreview,
				});
			}

			if (!parsed) {
				repairUsed = true;
				parseStage = "repair_json_call";
				await this.emitEvent(this.projectId, "fine_control", `Fine volume ${volumeNo} start JSON repair call`, {
					kind: "repair_json_started",
					volumeNo,
					attempt,
					maxAttempts,
					reason: "structured_json_invalid",
					parseStage,
					repairUsed,
					responsePreview: rawPreview,
				});
				try {
					const repairedRaw = await this.repairFineOutlineJson(project, volumeNo, chaptersPerVolume, raw);
					const repairedPreview = toPreview(repairedRaw);
					lastPreview = repairedPreview;
					parsed = parseStructuredFineVolume(repairedRaw) ||
						parseStructuredFineVolumeLenient(repairedRaw, {
							chaptersPerVolume,
							segmentSize: policy.segmentSize,
						});
					await this.emitJsonParse("fine_outline", {
						volumeNo,
						attempt,
						maxAttempts,
						parseStage,
						success: Boolean(parsed),
						reason: parsed ? "ok" : "structured_json_invalid",
						responsePreview: repairedPreview,
						repairUsed,
					});
					if (!parsed) {
						failedAttempts += 1;
						lastFailureReason = "structured_json_invalid";
						lastParseStage = parseStage;
						await this.emitEvent(this.projectId, "fine_control", `Fine volume ${volumeNo} repair output still invalid`, {
							kind: "repair_json_failed",
							volumeNo,
							attempt,
							maxAttempts,
							reason: lastFailureReason,
							parseStage,
							repairUsed,
							responsePreview: repairedPreview,
						});
						continue;
					}
					await this.emitEvent(this.projectId, "fine_control", `Fine volume ${volumeNo} repair call succeeded`, {
						kind: "repair_json_succeeded",
						volumeNo,
						attempt,
						maxAttempts,
						reason: "ok",
						parseStage,
						repairUsed,
						responsePreview: repairedPreview,
					});
				} catch (error) {
					failedAttempts += 1;
					lastFailureReason = `repair_json_call_failed:${error instanceof Error ? error.message : String(error)}`;
					lastParseStage = parseStage;
					await this.emitJsonParse("fine_outline", {
						volumeNo,
						attempt,
						maxAttempts,
						parseStage,
						success: false,
						reason: lastFailureReason,
						responsePreview: rawPreview,
						repairUsed,
					});
					continue;
				}
			}

			const schemaValidation = validateFineOutlinePayloadV1Schema(parsed);
			if (!schemaValidation.ok) {
				failedAttempts += 1;
				lastFailureReason = schemaValidation.reason;
				lastParseStage = parseStage;
				await this.emitJsonParse("fine_outline", {
					volumeNo,
					attempt,
					maxAttempts,
					parseStage,
					success: false,
					reason: schemaValidation.reason,
					details: schemaValidation.details,
					responsePreview: lastPreview || rawPreview,
					repairUsed,
				});
				await this.emitEvent(this.projectId, "fine_control", `Fine volume ${volumeNo} schema validation failed`, {
					kind: "retry_current_volume",
					volumeNo,
					attempt,
					maxAttempts,
					reason: schemaValidation.reason,
					parseStage,
					repairUsed,
					responsePreview: lastPreview || rawPreview,
					details: schemaValidation.details,
				});
				continue;
			}

			let compiled = compileStructuredFineVolume(parsed, {
				volumeNo,
				chaptersPerVolume,
				policy,
			});

			if (!compiled.ok) {
				const repairedStructured = repairStructuredFineVolumeDeterministic(parsed, {
					chaptersPerVolume,
					policy,
				});
				if (repairedStructured) {
					const repairedCompile = compileStructuredFineVolume(repairedStructured, {
						volumeNo,
						chaptersPerVolume,
						policy,
					});
					if (repairedCompile.ok) {
						compiled = repairedCompile;
						parseStage = "deterministic_repair";
						repairUsed = true;
					}
				}
			}

			if (!compiled.ok) {
				failedAttempts += 1;
				lastFailureReason = compiled.reason;
				lastParseStage = parseStage;
				await this.emitJsonParse("fine_outline", {
					volumeNo,
					attempt,
					maxAttempts,
					parseStage,
					success: false,
					reason: compiled.reason,
					details: compiled.details,
					responsePreview: lastPreview || rawPreview,
					repairUsed,
				});
				await this.emitEvent(this.projectId, "fine_control", `Fine volume ${volumeNo} structure validation failed`, {
					kind: "retry_current_volume",
					volumeNo,
					attempt,
					maxAttempts,
					reason: compiled.reason,
					parseStage,
					repairUsed,
					responsePreview: lastPreview || rawPreview,
					details: compiled.details,
					warnings: compiled.warnings,
				});
				continue;
			}

			await this.emitJsonParse("fine_outline", {
				volumeNo,
				attempt,
				maxAttempts,
				parseStage,
				success: true,
				reason: "ok",
				responsePreview: lastPreview || rawPreview,
				repairUsed,
				segmentCount: compiled.segmentCount,
			});

			await this.emitEvent(this.projectId, "fine_control", `Fine volume ${volumeNo} compiled`, {
				kind: "compiled",
				volumeNo,
				attempt,
				maxAttempts,
				reason: "ok",
				parseStage,
				repairUsed,
				responsePreview: lastPreview || rawPreview,
				segmentCount: compiled.segmentCount,
				coverage: compiled.coverage,
				trimCount: compiled.trimCount,
				warnings: compiled.warnings,
			});

			return {
				volumeTitle: compiled.volumeTitle,
				volumeSlug: compiled.volumeSlug,
				outlineMarkdown: compiled.outlineMarkdown,
				chapterGoals: compiled.chapterGoals,
				segmentCount: compiled.segmentCount,
				coverage: compiled.coverage,
				trimCount: compiled.trimCount,
				warnings: compiled.warnings,
				failedAttempts,
			};
		}

		await this.emitEvent(this.projectId, "fine_control", `Fine volume ${volumeNo} failed and task terminated`, {
			kind: "volume_failed_terminated",
			volumeNo,
			attempt: maxAttempts,
			maxAttempts,
			reason: lastFailureReason,
			parseStage: lastParseStage,
			repairUsed: true,
			responsePreview: lastPreview,
		});
		throw new Error(`Fine volume ${volumeNo} failed after ${maxAttempts} attempts (${lastFailureReason})`);
	}

	private async loadFineMemoryLedgers(projectId: string): Promise<string> {
		const dir = this.store.projectMemoryDir(projectId);
		const files = [
			{ label: "Facts", path: join(dir, "facts.jsonl") },
			{ label: "Entities", path: join(dir, "entities.json") },
			{ label: "Timeline", path: join(dir, "timeline.json") },
			{ label: "WorldRules", path: join(dir, "world-rules.json") },
			{ label: "Foreshadowing", path: join(dir, "foreshadowing.json") },
		];
		const lines: string[] = [];
		for (const file of files) {
			try {
				const content = await readFile(file.path, "utf8");
				const normalized = content.trim();
				if (!normalized) {
					continue;
				}
				lines.push(`## ${file.label}`);
				lines.push(normalized.slice(0, 10000));
				lines.push("");
			} catch {
				continue;
			}
		}
		return lines.join("\n").trim() || "No memory ledger entries.";
	}

	private async repairFineOutlineJson(project: NovelProject, volumeNo: number, chaptersPerVolume: number, raw: string): Promise<string> {
		const systemPrompt = [
			"Role/Task:",
			"You repair malformed fine outline output into strict JSON.",
			"",
			"Output contract:",
			"Return only one JSON object with schema { volumeTitle, volumeSlug, segments:[{ startChapter,endChapter,goal,conflict,turn,hook,points:string[] }] }",
			"",
			"Forbidden output:",
			"No markdown fences.",
			"No explanation text.",
		].join("\n");
		const userPrompt = [
			`Project: ${project.title}`,
			`Volume: ${volumeNo}`,
			`Chapters per volume: ${chaptersPerVolume}`,
			"Malformed source:",
			raw,
		].join("\n\n");
		return this.llm.completeText(systemPrompt, userPrompt, undefined, {
			workflowStage: "generating",
			operation: `repair_fine_volume_${volumeNo}`,
			projectId: project.id,
			protocol: FINE_OUTLINE_PROTOCOL.name,
			protocolVersion: FINE_OUTLINE_PROTOCOL.version,
		});
	}

	private buildFineIndexMarkdown(index: FineOutlineIndex): string {
		const lines: string[] = [];
		lines.push("# Fine Outline Index");
		lines.push("");
		lines.push(`- generatedAt: ${index.generatedAt}`);
		lines.push("");
		for (const volume of index.volumePlans) {
			lines.push(`## Volume ${volume.volumeNo}: ${volume.title}`);
			lines.push(`- file: ${volume.outlinePath}`);
			lines.push(`- chapters: ${volume.chapterGoals.length}`);
			for (let i = 0; i < volume.chapterGoals.length; i++) {
				lines.push(`  - ${i + 1}. ${volume.chapterGoals[i]}`);
			}
			lines.push("");
		}
		return `${lines.join("\n")}\n`;
	}

	private async generateChapters(project: NovelProject, state: PipelineState): Promise<boolean> {
		state.status = "chapters_generating";
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "stage_change", "Start chapter generation", { stage: state.status });

		const fineMeta = await this.store.readFineMeta(project.id);
		if (!fineMeta || fineMeta.volumePlans.length === 0) {
			throw new Error("Fine outline metadata missing");
		}

		for (const volumeNo of buildSerialRange(state.currentVolume, fineMeta.volumePlans.length)) {
			const volumePlan = fineMeta.volumePlans.find((item) => item.volumeNo === volumeNo);
			if (!volumePlan) {
				throw new Error(`Missing volume metadata: ${volumeNo}`);
			}

			const startChapter = volumeNo === state.currentVolume ? state.currentChapterInVolume : 1;
			for (let chapterNo = startChapter; chapterNo <= volumePlan.chapterGoals.length; chapterNo++) {
				if (await this.shouldStop()) {
					return false;
				}

				const globalChapterNo = state.globalChapterNo + 1;
				const generated = await this.generateSingleChapter(project, fineMeta, volumePlan, volumeNo, chapterNo, globalChapterNo, []);

				state.globalChapterNo = globalChapterNo;
				state.currentVolume = volumeNo;
				state.currentChapterInVolume = chapterNo + 1;
				await this.store.savePipelineState(state);

				await this.emitEvent(this.projectId, "chapter_generated", `Generated chapter V${volumeNo}-C${chapterNo}`, {
					globalChapterNo,
					volumeNo,
					chapterNo,
					chapterRef: generated.chapterRef,
					chapterPath: generated.path,
					preview: generated.content.slice(0, 240),
				});

				if (globalChapterNo % 5 === 0) {
					const passed = await this.runReviewCycles(project, state, fineMeta, globalChapterNo - 4, globalChapterNo);
					if (!passed) {
						return false;
					}
				}
			}

			state.currentVolume = volumeNo + 1;
			state.currentChapterInVolume = 1;
			await this.store.savePipelineState(state);
		}

		state.status = "completed";
		state.isRunning = false;
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "stage_change", "Task completed", { status: state.status });
		return true;
	}

	private async generateSingleChapter(
		project: NovelProject,
		fineMeta: FineOutlineIndex,
		volumePlan: VolumePlan,
		volumeNo: number,
		chapterNo: number,
		globalChapterNo: number,
		extraRevisionHints: string[],
	): Promise<GeneratedChapterResult> {
		const chapterGoal = volumePlan.chapterGoals[chapterNo - 1] || `Chapter ${chapterNo} advances main conflict`;
		const chapterRef = `V${volumeNo}-C${chapterNo}`;
		const consistency = await this.memoryManager.consistencyPrecheck(project, chapterGoal);
		const memoryDigest = await this.memoryManager.loadMemoryDigest(project.id, chapterGoal);
		const recentChapters = await this.loadRecentChapterSnippet(project.id, 10);
		const coarse = await this.store.readCoarseOutline(project.id);
		void fineMeta;

		const rulesAndTaboosText = [
			`style=${project.preferences.style}`,
			`taboos=${project.preferences.taboos}`,
			`language=${project.preferences.language}`,
			"Consistency precheck:",
			JSON.stringify(consistency, null, 2),
			extraRevisionHints.length > 0 ? `Revision guidance:\n${extraRevisionHints.join("\n")}` : "",
		].join("\n");
		const chapterContextPack = buildChapterContextPackV1({
			planText: coarse,
			volumeGoalsText: volumePlan.chapterGoals.map((goal, idx) => `${idx + 1}. ${goal}`).join("\n"),
			recentChaptersText: recentChapters,
			memoryDigestText: memoryDigest,
			rulesAndTaboosText,
		});
		await this.emitContextPack("chapter_generation", chapterContextPack.stats, {
			chapterRef,
			volumeNo,
			chapterNo,
			globalChapterNo,
		});

		const systemPrompt = [
			"Role/Task:",
			"You are a long-form fiction chapter writer.",
			"Write chapter output in strict JSON.",
			"",
			"Output contract:",
			"Return ONLY one JSON object:",
			"{ chapterRef, title, summary, content, continuity_checks:string[], seed_hooks:string[], forbidden_hit:string[] }",
			"content must be pure narrative prose paragraphs.",
			"",
			"Forbidden output:",
			"No markdown headings, no bullet lists, no numbered section labels, no outline scaffolding.",
			"No markdown fences.",
		].join("\n");
		const userPrompt = [
			"Input context block (higher priority first):",
			chapterContextPack.context,
			"",
			`project=${project.title}`,
			`creativePrompt=${project.preferences.prompt || "none"}`,
			`chapterRef=${chapterRef}`,
			`globalChapterNo=${globalChapterNo}`,
			`chapterGoal=${chapterGoal}`,
		].join("\n");

		const streamPayloadBase = {
			chapterRef,
			globalChapterNo,
			volumeNo,
			chapterNo,
		};
		await this.emitEvent(this.projectId, "chapter_stream", `Start stream ${chapterRef}`, {
			phase: "start",
			...streamPayloadBase,
		});

		const chapterMaxAttempts = 3;
		let lastFailureReason = "chapter_json_invalid";
		let lastPreview = "";

		for (let attempt = 1; attempt <= chapterMaxAttempts; attempt++) {
			const raw = await this.llm.completeText(systemPrompt, userPrompt, undefined, {
				workflowStage: "generating",
				operation: `generate_chapter_${chapterRef.toLowerCase()}`,
				projectId: project.id,
				protocol: CHAPTER_PROTOCOL.name,
				protocolVersion: CHAPTER_PROTOCOL.version,
			});
			const preview = raw.replace(/\s+/g, " ").trim().slice(0, 240);
			lastPreview = preview;

			let parseStage = "strict_json_parse";
			let payload: ChapterPayloadV1 | null = parseChapterPayloadV1Strict(raw);
			await this.emitJsonParse("chapter_generation", {
				chapterRef,
				attempt,
				maxAttempts: chapterMaxAttempts,
				parseStage,
				success: Boolean(payload),
				reason: payload ? "ok" : "chapter_json_invalid",
				responsePreview: preview,
			});

			if (!payload) {
				parseStage = "local_json_extract_parse";
				payload = parseChapterPayloadV1Lenient(raw);
				await this.emitJsonParse("chapter_generation", {
					chapterRef,
					attempt,
					maxAttempts: chapterMaxAttempts,
					parseStage,
					success: Boolean(payload),
					reason: payload ? "ok" : "chapter_json_invalid",
					responsePreview: preview,
				});
			}

			if (!payload) {
				parseStage = "repair_json_call";
				try {
					const repairedRaw = await this.repairChapterJson(project, chapterRef, raw);
					const repairedPreview = repairedRaw.replace(/\s+/g, " ").trim().slice(0, 240);
					lastPreview = repairedPreview;
					payload = parseChapterPayloadV1Strict(repairedRaw) || parseChapterPayloadV1Lenient(repairedRaw);
					await this.emitJsonParse("chapter_generation", {
						chapterRef,
						attempt,
						maxAttempts: chapterMaxAttempts,
						parseStage,
						success: Boolean(payload),
						reason: payload ? "ok" : "chapter_json_invalid",
						responsePreview: repairedPreview,
					});
				} catch (error) {
					lastFailureReason = `repair_json_call_failed:${error instanceof Error ? error.message : String(error)}`;
					await this.emitJsonParse("chapter_generation", {
						chapterRef,
						attempt,
						maxAttempts: chapterMaxAttempts,
						parseStage,
						success: false,
						reason: lastFailureReason,
						responsePreview: preview,
					});
					continue;
				}
			}

			const validated = validateChapterPayloadV1(payload, chapterRef);
			if (!validated.ok) {
				lastFailureReason = validated.reason;
				await this.emitJsonParse("chapter_generation", {
					chapterRef,
					attempt,
					maxAttempts: chapterMaxAttempts,
					parseStage: "schema_semantic_validate",
					success: false,
					reason: validated.reason,
					details: validated.details,
					responsePreview: lastPreview,
				});
				continue;
			}

			let markdown = validated.payload.content;
			const cleaned = sanitizeGeneratedChapter(markdown);
			const finalMarkdown = cleaned.content.length > 0 ? cleaned.content : markdown.trim();
			if (cleaned.removedStructuralLines > 0 || cleaned.normalizedStructuredLines > 0) {
				await this.emitEvent(this.projectId, "progress", `Chapter ${chapterRef} content cleaned`, {
					chapterRef,
					removedStructuralLines: cleaned.removedStructuralLines,
					normalizedStructuredLines: cleaned.normalizedStructuredLines,
				});
			}
			markdown = finalMarkdown;

			await this.emitJsonParse("chapter_generation", {
				chapterRef,
				attempt,
				maxAttempts: chapterMaxAttempts,
				parseStage: "schema_semantic_validate",
				success: true,
				reason: "ok",
				responsePreview: markdown.slice(0, 240),
			});

			await this.emitEvent(this.projectId, "chapter_stream", `End stream ${chapterRef}`, {
				phase: "end",
				title: validated.payload.title,
				summary: validated.payload.summary,
				content: markdown,
				...streamPayloadBase,
			});

			const chapterSlug = slugify(chapterGoal.slice(0, 40) || `chapter-${chapterNo}`);
			const path = await this.store.writeChapter(project.id, volumeNo, volumePlan.slug, chapterNo, chapterSlug, markdown);
			await this.memoryManager.memoryPut(project, chapterRef, markdown);
			return {
				chapterRef,
				chapterSlug,
				path,
				content: markdown,
			};
		}

		await this.emitEvent(this.projectId, "chapter_stream", `Stream failed ${chapterRef}`, {
			phase: "error",
			error: lastFailureReason,
			responsePreview: lastPreview,
			...streamPayloadBase,
		});
		throw new Error(`Chapter ${chapterRef} failed after ${chapterMaxAttempts} attempts (${lastFailureReason})`);
	}

	private async repairChapterJson(project: NovelProject, chapterRef: string, raw: string): Promise<string> {
		const systemPrompt = [
			"Role/Task:",
			"Repair malformed chapter output into strict ChapterProtocol JSON.",
			"",
			"Output contract:",
			"Return ONLY one JSON object:",
			"{ chapterRef, title, summary, content, continuity_checks:string[], seed_hooks:string[], forbidden_hit:string[] }",
			"",
			"Forbidden output:",
			"No markdown fence.",
			"No explanation.",
		].join("\n");
		const userPrompt = [
			`Project: ${project.title}`,
			`chapterRef=${chapterRef}`,
			"Malformed source:",
			raw,
		].join("\n\n");
		return this.llm.completeText(systemPrompt, userPrompt, undefined, {
			workflowStage: "generating",
			operation: `repair_chapter_${chapterRef.toLowerCase()}`,
			projectId: project.id,
			protocol: CHAPTER_PROTOCOL.name,
			protocolVersion: CHAPTER_PROTOCOL.version,
		});
	}

	private async emitContextPack(stage: string, stats: ContextPackStats, extra: Record<string, unknown> = {}): Promise<void> {
		await this.emitEvent(this.projectId, "context_pack", `Context packed: ${stage}`, {
			stage,
			...stats,
			...extra,
		});
	}

	private async emitJsonParse(stage: string, data: Record<string, unknown>): Promise<void> {
		const success = data.success === true;
		const scope = data.chapterRef ? String(data.chapterRef) : data.volumeNo ? `volume-${String(data.volumeNo)}` : stage;
		const parseStage = data.parseStage ? String(data.parseStage) : "unknown";
		await this.emitEvent(this.projectId, "json_parse", `${stage}:${scope}:${parseStage}:${success ? "ok" : "failed"}`, {
			stage,
			...data,
		});
	}


	private async runReviewCycles(
		project: NovelProject,
		state: PipelineState,
		fineMeta: FineOutlineIndex,
		batchStart: number,
		batchEnd: number,
	): Promise<boolean> {
		state.status = "reviewing";
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "stage_change", `Start review batch ${batchStart}-${batchEnd}`, { stage: state.status });

		const profile = await this.store.getModelProfile();
		for (let round = 1; round <= 2; round++) {
			if (await this.shouldStop()) {
				return false;
			}
			const report = await this.reviewAgent.runReview(project, profile, batchStart, batchEnd, round);
			await this.store.appendReviewReport(project.id, batchEnd, {
				round,
				report,
			});
			await this.emitEvent(this.projectId, "review_report", `Review round ${round} completed`, {
				round,
				report,
			});

			if (report.passed) {
				state.reviewCycleCount = 0;
				state.status = "chapters_generating";
				await this.store.savePipelineState(state);
				return true;
			}

			const targets = await this.collectAffectedChapterTargets(report.issues, batchStart, batchEnd);
			const hints = this.collectRevisionHints(report.issues);
			for (const target of targets) {
				const volumePlan = fineMeta.volumePlans.find((item) => item.volumeNo === target.volume);
				if (!volumePlan) {
					continue;
				}
				await this.generateSingleChapter(
					project,
					fineMeta,
					volumePlan,
					target.volume,
					target.chapter,
					(target.volume - 1) * volumePlan.chapterGoals.length + target.chapter,
					hints,
				);
				await this.emitEvent(this.projectId, "progress", `Regenerated chapter by review suggestion V${target.volume}-C${target.chapter}`, {
					target,
					round,
				});
			}

			const chapterRecords = await this.loadAllChapterRecords(project.id);
			await this.memoryManager.rebuildFromChapters(project, chapterRecords);
		}

		state.status = "paused_review_failed";
		state.isRunning = false;
		await this.store.savePipelineState(state);
		await this.emitEvent(this.projectId, "error", "Review failed after two rounds, task paused", {
			batchStart,
			batchEnd,
		});
		return false;
	}

	private async collectAffectedChapterTargets(
		issues: AgenticReviewIssue[],
		batchStart: number,
		batchEnd: number,
	): Promise<Array<{ volume: number; chapter: number }>> {
		const targets = new Map<string, { volume: number; chapter: number }>();
		for (const issue of issues) {
			for (const ref of issue.affectedChapters || []) {
				const parsed = extractVolumeAndChapter(ref);
				if (!parsed) {
					continue;
				}
				targets.set(`${parsed.volume}-${parsed.chapter}`, parsed);
			}
		}
		if (targets.size === 0) {
			const chapterFiles = await this.store.listChapterFiles(this.projectId);
			const batchFiles = chapterFiles.slice(Math.max(0, batchStart - 1), batchEnd);
			for (const file of batchFiles) {
				const normalized = file.replaceAll("\\", "/");
				const volumeMatch = normalized.match(/10-volumes\/(\d+)-/);
				const chapterMatch = normalized.match(/\/(\d+)-[^/]+\.md$/);
				if (!volumeMatch?.[1] || !chapterMatch?.[1]) {
					continue;
				}
				const volume = Number.parseInt(volumeMatch[1], 10);
				const chapter = Number.parseInt(chapterMatch[1], 10);
				if (!Number.isFinite(volume) || !Number.isFinite(chapter)) {
					continue;
				}
				targets.set(`${volume}-${chapter}`, { volume, chapter });
			}
		}
		return Array.from(targets.values());
	}

	private collectRevisionHints(issues: AgenticReviewIssue[]): string[] {
		const hints: string[] = [];
		for (const issue of issues) {
			hints.push(`[${issue.severity}] ${issue.title}: ${issue.suggestedFix}`);
		}
		return hints;
	}

	private async loadRecentChapterSnippet(projectId: string, limit: number): Promise<string> {
		const chapterFiles = await this.store.listChapterFiles(projectId);
		if (chapterFiles.length === 0) {
			return "No recent chapters.";
		}
		const selected = chapterFiles.slice(-limit);
		const snippets: string[] = [];
		for (const file of selected) {
			const text = await readFile(file, "utf8");
			snippets.push(`### ${file}\n${text.slice(0, 800)}`);
		}
		return snippets.join("\n\n");
	}

	private async loadAllChapterRecords(projectId: string): Promise<Array<{ chapterRef: string; content: string }>> {
		const files = await this.store.listChapterFiles(projectId);
		const output: Array<{ chapterRef: string; content: string }> = [];
		let index = 0;
		for (const file of files) {
			index += 1;
			const content = await readFile(file, "utf8");
			const chapterRef = `CH-${pad(index, 3)}`;
			output.push({ chapterRef, content });
		}
		return output;
	}

	private async shouldStop(): Promise<boolean> {
		const state = await this.store.loadPipelineState(this.projectId);
		return state.stopRequested || state.terminated;
	}
}





