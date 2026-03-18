import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	CreateProjectInput,
	FineOutlineIndex,
	LatestChapterPayload,
	ModelProfile,
	NovelProject,
	PipelineState,
	PlanDecisionManifest,
	PlanManifest,
	PlanSection,
	ProjectEvent,
	UpdatePlanSectionInput,
} from "./types.js";
import { countWords, createId, nowIso, pad, slugify } from "./utils.js";
import {
	createInitialFineControlState,
	normalizeFineOutlineControlPolicy,
} from "./fine-outline-control.js";

const PROJECTS_DIR = "projects";
const SETTINGS_DIR = "settings";
const MODEL_PROFILE_FILE = "model-profile.json";
const PROJECT_FILE = "project.json";
const PIPELINE_FILE = "pipeline-state.json";
const EVENTS_FILE = "events.jsonl";

const PLAN_SECTION_TEMPLATES: Array<Pick<PlanSection, "id" | "title" | "required">> = [
	{ id: "master_plan", title: "总策划 Plan（兼粗纲）", required: true },
];

function defaultPlanManifest(): PlanManifest {
	const now = nowIso();
	return {
		version: 1,
		confirmed: false,
		sections: PLAN_SECTION_TEMPLATES.map((section) => ({
			...section,
			locked: false,
			content: "",
			updatedAt: now,
		})),
	};
}

function normalizeSectionContent(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (content === null || content === undefined) {
		return "";
	}
	if (Array.isArray(content)) {
		return content.map((item) => normalizeSectionContent(item)).filter((item) => item.length > 0).join("\n\n").trim();
	}
	if (typeof content === "object") {
		const obj = content as Record<string, unknown>;
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
	return String(content).trim();
}

function normalizePlanManifest(manifest: PlanManifest | null | undefined): PlanManifest {
	const fallback = defaultPlanManifest();
	if (!manifest || typeof manifest !== "object") {
		return fallback;
	}
	const now = nowIso();
	const rawSections = Array.isArray(manifest.sections) && manifest.sections.length > 0 ? manifest.sections : fallback.sections;
	const normalizedSections = rawSections.map((section, index) => {
		const template = PLAN_SECTION_TEMPLATES.find((item) => item.id === section.id);
		const id = section.id || template?.id || `section-${index + 1}`;
		return {
			id,
			title: section.title || template?.title || id,
			required: section.required ?? template?.required ?? false,
			locked: Boolean(section.locked),
			content: normalizeSectionContent(section.content),
			updatedAt: section.updatedAt || now,
		};
	});
	return {
		version: Number.isFinite(manifest.version) && manifest.version > 0 ? Math.floor(manifest.version) : 1,
		confirmed: Boolean(manifest.confirmed),
		confirmedAt: manifest.confirmed ? manifest.confirmedAt : undefined,
		sections: normalizedSections,
	};
}

function normalizeProject(project: NovelProject): NovelProject {
	return {
		...project,
		fineOutlineControl: normalizeFineOutlineControlPolicy(project.fineOutlineControl),
		planManifest: normalizePlanManifest(project.planManifest),
	};
}

function normalizePipelineState(state: PipelineState): PipelineState {
	const normalizedFineState = state.fineControlState || createInitialFineControlState();
	return {
		...state,
		fineControlState: {
			currentVolume:
				Number.isFinite(normalizedFineState.currentVolume) && normalizedFineState.currentVolume > 0
					? Math.floor(normalizedFineState.currentVolume)
					: 1,
			volumeCoverage: normalizedFineState.volumeCoverage || {},
			totalSegments:
				Number.isFinite(normalizedFineState.totalSegments) && normalizedFineState.totalSegments >= 0
					? Math.floor(normalizedFineState.totalSegments)
					: 0,
			trimCount:
				Number.isFinite(normalizedFineState.trimCount) && normalizedFineState.trimCount >= 0
					? Math.floor(normalizedFineState.trimCount)
					: 0,
			failedAttempts:
				Number.isFinite(normalizedFineState.failedAttempts) && normalizedFineState.failedAttempts >= 0
					? Math.floor(normalizedFineState.failedAttempts)
					: 0,
			warnings: Array.isArray(normalizedFineState.warnings)
				? normalizedFineState.warnings.filter((item): item is string => typeof item === "string").slice(0, 100)
				: [],
		},
	};
}
function defaultDecisionManifest(): PlanDecisionManifest {
	return {
		version: 1,
		completed: false,
		decisions: [],
	};
}

function defaultPipelineState(projectId: string): PipelineState {
	return {
		projectId,
		status: "idle",
		isRunning: false,
		stopRequested: false,
		terminated: false,
		currentVolume: 1,
		currentChapterInVolume: 1,
		globalChapterNo: 0,
		fineVolumeCursor: 1,
		ratioFailures: {
			coarse: 0,
			fine: 0,
		},
		reviewCycleCount: 0,
		fineControlState: createInitialFineControlState(),
		lastEventSeq: 0,
		updatedAt: nowIso(),
	};
}

async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function readJson<T>(path: string): Promise<T> {
	const raw = await readFile(path, "utf8");
	return JSON.parse(raw) as T;
}

function isRenameRetryableError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}
	const code = (error as { code?: string }).code;
	return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function sleep(ms: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const payload = `${JSON.stringify(value, null, "\t")}\n`;
	const maxAttempts = 8;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const temp = `${path}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
		await writeFile(temp, payload, "utf8");
		try {
			await rename(temp, path);
			return;
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {});
			if (!isRenameRetryableError(error) || attempt >= maxAttempts) {
				throw error;
			}
			const delayMs = Math.min(1200, 30 * 2 ** (attempt - 1));
			await sleep(delayMs);
		}
	}
}
function buildDefaultProfile(): ModelProfile {
	return {
		api: "openai-completions",
		provider: "nvidia",
		modelId: "deepseek-ai/deepseek-v3.2",
		baseUrl: "https://integrate.api.nvidia.com/v1",
		apiKey: "",
		temperature: 1,
		topP: 0.95,
		maxTokens: 8192,
		thinking: "high",
		rpmLimit: 40,
		retry: {
			maxRetries: 6,
			baseDelayMs: 2000,
			maxDelayMs: 60000,
		},

	};
}

export class FileStore {
	readonly rootDir: string;
	readonly projectsDir: string;
	readonly settingsDir: string;
	private readonly eventAppendQueues = new Map<string, Promise<void>>();
	private readonly pipelineStateQueues = new Map<string, Promise<void>>();

	constructor(rootDir: string) {
		this.rootDir = rootDir;
		this.projectsDir = join(rootDir, PROJECTS_DIR);
		this.settingsDir = join(rootDir, SETTINGS_DIR);
	}

	async init(): Promise<void> {
		await ensureDir(this.rootDir);
		await ensureDir(this.projectsDir);
		await ensureDir(this.settingsDir);
	}

	projectDir(projectId: string): string {
		return join(this.projectsDir, projectId);
	}

	projectNovelDir(projectId: string): string {
		return join(this.projectDir(projectId), "novel");
	}

	projectPlanManifestPath(projectId: string): string {
		return join(this.projectNovelDir(projectId), "01-plan", "manifest.json");
	}

	projectDecisionManifestPath(projectId: string): string {
		return join(this.projectNovelDir(projectId), "01-plan", "decisions.json");
	}

	projectPlanMarkdownPath(projectId: string): string {
		return join(this.projectNovelDir(projectId), "01-plan", "plan.md");
	}

	projectCoarsePath(projectId: string): string {
		return join(this.projectNovelDir(projectId), "02-outline", "coarse-outline.md");
	}

	projectFineDir(projectId: string): string {
		return join(this.projectNovelDir(projectId), "03-outline-fine");
	}

	projectFineIndexPath(projectId: string): string {
		return join(this.projectFineDir(projectId), "index.md");
	}

	projectFineMetaPath(projectId: string): string {
		return join(this.projectFineDir(projectId), "meta.json");
	}

	projectVolumesDir(projectId: string): string {
		return join(this.projectNovelDir(projectId), "10-volumes");
	}

	projectMemoryDir(projectId: string): string {
		return join(this.projectNovelDir(projectId), "90-memory");
	}

	projectReviewDir(projectId: string): string {
		return join(this.projectNovelDir(projectId), "99-reviews");
	}

	private async initializeProjectDirs(projectId: string): Promise<void> {
		const projectDir = this.projectDir(projectId);
		await ensureDir(projectDir);
		await ensureDir(join(this.projectNovelDir(projectId), "01-plan"));
		await ensureDir(join(this.projectNovelDir(projectId), "02-outline"));
		await ensureDir(this.projectFineDir(projectId));
		await ensureDir(this.projectVolumesDir(projectId));
		await ensureDir(this.projectMemoryDir(projectId));
		await ensureDir(this.projectReviewDir(projectId));
	}

	private modelProfilePath(): string {
		return join(this.settingsDir, MODEL_PROFILE_FILE);
	}

	private projectPath(projectId: string): string {
		return join(this.projectDir(projectId), PROJECT_FILE);
	}

	private pipelinePath(projectId: string): string {
		return join(this.projectDir(projectId), PIPELINE_FILE);
	}

	private eventsPath(projectId: string): string {
		return join(this.projectDir(projectId), EVENTS_FILE);
	}

	async getModelProfile(): Promise<ModelProfile> {
		const path = this.modelProfilePath();
		if (!(await exists(path))) {
			const profile = buildDefaultProfile();
			await writeJsonAtomic(path, profile);
			return profile;
		}
		return readJson<ModelProfile>(path);
	}

	async saveModelProfile(profile: ModelProfile): Promise<ModelProfile> {
		await writeJsonAtomic(this.modelProfilePath(), profile);
		return profile;
	}

	async createProject(input: CreateProjectInput): Promise<NovelProject> {
		const id = createId();
		const now = nowIso();
		const totalWords = Math.max(5000, Math.round(input.target_total_words));
		const fineTarget = Math.max(100, Math.round(totalWords / 100));
		const coarseTarget = 0;
		const project: NovelProject = {
			id,
			title: input.title.trim(),
			slug: slugify(input.title),
			createdAt: now,
			updatedAt: now,
			wordBudget: {
				targetTotalWords: totalWords,
				fineTargetWords: fineTarget,
				coarseTargetWords: coarseTarget,
				tolerance: 0.15,
				enforceHardGate: true,
				maxRatioFailures: 3,
			},
			fineOutlineControl: normalizeFineOutlineControlPolicy(input.fine_control_policy),
			preferences: {
				prompt: input.prompt || "",
				genre: input.genre,
				theme: input.theme,
				style: input.style,
				taboos: input.taboos,
				language: input.language || "中文",
				volumeCount: Math.max(1, input.volumeCount || 3),
				chaptersPerVolume: Math.max(1, input.chaptersPerVolume || 20),
			},
			planManifest: defaultPlanManifest(),
		};

		await this.initializeProjectDirs(id);
		await writeJsonAtomic(this.projectPath(id), project);
		await writeJsonAtomic(this.pipelinePath(id), defaultPipelineState(id));
		await writeJsonAtomic(this.projectPlanManifestPath(id), project.planManifest);
		await writeJsonAtomic(this.projectDecisionManifestPath(id), defaultDecisionManifest());
		await this.writePlanMarkdown(project.id, project.planManifest);
		await writeFile(this.eventsPath(id), "", "utf8");
		await this.initializeMemoryFiles(id);
		return project;
	}

	private async initializeMemoryFiles(projectId: string): Promise<void> {
		const memoryDir = this.projectMemoryDir(projectId);
		await writeJsonAtomic(join(memoryDir, "entities.json"), []);
		await writeJsonAtomic(join(memoryDir, "timeline.json"), []);
		await writeJsonAtomic(join(memoryDir, "world-rules.json"), []);
		await writeJsonAtomic(join(memoryDir, "foreshadowing.json"), []);
		await writeFile(join(memoryDir, "facts.jsonl"), "", "utf8");
	}

	async listProjects(): Promise<NovelProject[]> {
		const entries = await readdir(this.projectsDir, { withFileTypes: true });
		const projects: NovelProject[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const path = this.projectPath(entry.name);
			if (!(await exists(path))) {
				continue;
			}
			projects.push(normalizeProject(await readJson<NovelProject>(path)));
		}
		projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return projects;
	}

	async loadProject(projectId: string): Promise<NovelProject> {
		return normalizeProject(await readJson<NovelProject>(this.projectPath(projectId)));
	}

	async saveProject(project: NovelProject): Promise<void> {
		project.updatedAt = nowIso();
		await writeJsonAtomic(this.projectPath(project.id), project);
	}

	async loadPipelineState(projectId: string): Promise<PipelineState> {
		return normalizePipelineState(await readJson<PipelineState>(this.pipelinePath(projectId)));
	}
	async savePipelineState(state: PipelineState): Promise<void> {
		await this.enqueuePipelineStateWrite(state.projectId, async () => {
			const path = this.pipelinePath(state.projectId);
			if (await exists(path)) {
				const current = await readJson<PipelineState>(path);
				state.lastEventSeq = Math.max(current.lastEventSeq || 0, state.lastEventSeq || 0);
			}
			state.updatedAt = nowIso();
			await writeJsonAtomic(path, state);
		});
	}
	async updatePlanSection(projectId: string, sectionId: string, input: UpdatePlanSectionInput): Promise<PlanManifest> {
		const project = await this.loadProject(projectId);
		const manifest = await this.loadPlanManifest(projectId);
		const section = manifest.sections.find((item) => item.id === sectionId);
		if (!section) {
			throw new Error(`Unknown section: ${sectionId}`);
		}
		section.content = normalizeSectionContent(input.content);
		if (input.lock) {
			section.locked = true;
		}
		section.updatedAt = nowIso();
		manifest.confirmed = false;
		manifest.confirmedAt = undefined;
		manifest.version += 1;
		project.planManifest = manifest;
		await this.saveProject(project);
		await writeJsonAtomic(this.projectPlanManifestPath(projectId), manifest);
		await this.writePlanMarkdown(projectId, manifest);
		await this.invalidateDownstreamState(projectId);
		return manifest;
	}

	async setPlanManifest(projectId: string, manifest: PlanManifest): Promise<void> {
		const normalized = normalizePlanManifest(manifest);
		const project = await this.loadProject(projectId);
		project.planManifest = normalized;
		await this.saveProject(project);
		await writeJsonAtomic(this.projectPlanManifestPath(projectId), normalized);
		await this.writePlanMarkdown(projectId, normalized);
		await this.invalidateDownstreamState(projectId);
	}

	async loadPlanManifest(projectId: string): Promise<PlanManifest> {
		const path = this.projectPlanManifestPath(projectId);
		if (await exists(path)) {
			return normalizePlanManifest(await readJson<PlanManifest>(path));
		}
		return defaultPlanManifest();
	}

	async loadDecisionManifest(projectId: string): Promise<PlanDecisionManifest> {
		const path = this.projectDecisionManifestPath(projectId);
		if (await exists(path)) {
			return readJson<PlanDecisionManifest>(path);
		}
		return defaultDecisionManifest();
	}

	async saveDecisionManifest(projectId: string, manifest: PlanDecisionManifest): Promise<void> {
		await writeJsonAtomic(this.projectDecisionManifestPath(projectId), manifest);
	}

	async confirmPlan(projectId: string): Promise<PlanManifest> {
		const manifest = await this.loadPlanManifest(projectId);
		for (const section of manifest.sections) {
			section.content = normalizeSectionContent(section.content);
		}
		const missing = manifest.sections.filter((section) => section.required && section.content.trim().length === 0);
		if (missing.length > 0) {
			throw new Error(`Plan has unlocked or empty required sections: ${missing.map((section) => section.title).join(", ")}`);
		}
		manifest.confirmed = true;
		manifest.confirmedAt = nowIso();
		await this.setPlanManifest(projectId, manifest);
		const pipeline = await this.loadPipelineState(projectId);
		pipeline.status = "plan_ready";
		pipeline.terminated = false;
		pipeline.stopRequested = false;
		pipeline.isRunning = false;
		pipeline.lastError = undefined;
		await this.savePipelineState(pipeline);
		return manifest;
	}

	private async invalidateDownstreamState(projectId: string): Promise<void> {
		await rm(this.projectCoarsePath(projectId), { force: true });
		await rm(this.projectFineDir(projectId), { recursive: true, force: true });
		await rm(this.projectVolumesDir(projectId), { recursive: true, force: true });
		await ensureDir(this.projectFineDir(projectId));
		await ensureDir(this.projectVolumesDir(projectId));
		const pipeline = await this.loadPipelineState(projectId);
		pipeline.status = "plan_ready";
		pipeline.currentVolume = 1;
		pipeline.currentChapterInVolume = 1;
		pipeline.globalChapterNo = 0;
		pipeline.fineVolumeCursor = 1;
		pipeline.ratioFailures.coarse = 0;
		pipeline.ratioFailures.fine = 0;
		pipeline.reviewCycleCount = 0;
		pipeline.fineControlState = createInitialFineControlState();
		await this.savePipelineState(pipeline);
	}

	private async writePlanMarkdown(projectId: string, manifest: PlanManifest): Promise<void> {
		const lines: string[] = [];
		lines.push(`# 精细 Plan v${manifest.version}`);
		lines.push("");
		lines.push(`- confirmed: ${manifest.confirmed}`);
		lines.push(`- confirmedAt: ${manifest.confirmedAt || ""}`);
		lines.push("");
		for (const section of manifest.sections) {
			lines.push(`## ${section.title} (${section.id})`);
			lines.push("");
			lines.push(normalizeSectionContent(section.content) || "（待填写）");
			lines.push("");
			lines.push(`- locked: ${section.locked}`);
			lines.push(`- updatedAt: ${section.updatedAt}`);
			lines.push("");
		}
		await writeFile(this.projectPlanMarkdownPath(projectId), `${lines.join("\n")}\n`, "utf8");
	}

	private async readLastEventSeq(projectId: string): Promise<number> {
		const path = this.eventsPath(projectId);
		if (!(await exists(path))) {
			return 0;
		}
		const raw = await readFile(path, "utf8");
		const lines = raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		let maxSeq = 0;
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as ProjectEvent;
				if (Number.isFinite(parsed.seq)) {
					maxSeq = Math.max(maxSeq, parsed.seq);
				}
			} catch {
				// ignore malformed line
			}
		}
		return maxSeq;
	}

	private async enqueueEventAppend<T>(projectId: string, task: () => Promise<T>): Promise<T> {
		let result!: T;
		const previous = this.eventAppendQueues.get(projectId) || Promise.resolve();
		const current = previous.then(async () => {
			result = await task();
		});
		this.eventAppendQueues.set(
			projectId,
			current.catch(() => {
				// keep queue chain alive after failures
			}),
		);
		try {
			await current;
			return result;
		} finally {
			if (this.eventAppendQueues.get(projectId) === current) {
				this.eventAppendQueues.delete(projectId);
			}
		}
	}

	private async enqueuePipelineStateWrite<T>(projectId: string, task: () => Promise<T>): Promise<T> {
		let result!: T;
		const previous = this.pipelineStateQueues.get(projectId) || Promise.resolve();
		const current = previous.then(async () => {
			result = await task();
		});
		this.pipelineStateQueues.set(
			projectId,
			current.catch(() => {
				// keep queue chain alive after failures
			}),
		);
		try {
			await current;
			return result;
		} finally {
			if (this.pipelineStateQueues.get(projectId) === current) {
				this.pipelineStateQueues.delete(projectId);
			}
		}
	}
	async appendEvent(projectId: string, event: Omit<ProjectEvent, "seq" | "timestamp">): Promise<ProjectEvent> {
		return this.enqueueEventAppend(projectId, async () => {
			const state = await this.loadPipelineState(projectId);
			const lastFromFile = await this.readLastEventSeq(projectId);
			const baseSeq = Math.max(state.lastEventSeq || 0, lastFromFile);
			const next: ProjectEvent = {
				seq: baseSeq + 1,
				timestamp: nowIso(),
				type: event.type,
				message: event.message,
				data: event.data,
			};
			state.lastEventSeq = next.seq;
			await this.savePipelineState(state);
			await writeFile(this.eventsPath(projectId), `${JSON.stringify(next)}\n`, { encoding: "utf8", flag: "a" });
			return next;
		});
	}

	async readEvents(projectId: string, fromSeq: number): Promise<ProjectEvent[]> {
		const path = this.eventsPath(projectId);
		if (!(await exists(path))) {
			return [];
		}
		const raw = await readFile(path, "utf8");
		const lines = raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		const events: ProjectEvent[] = [];
		for (const line of lines) {
			const parsed = JSON.parse(line) as ProjectEvent;
			if (parsed.seq > fromSeq) {
				events.push(parsed);
			}
		}
		return events;
	}

	async writeCoarseOutline(projectId: string, content: string): Promise<void> {
		await writeFile(this.projectCoarsePath(projectId), content, "utf8");
	}

	async readCoarseOutline(projectId: string): Promise<string> {
		return readFile(this.projectCoarsePath(projectId), "utf8");
	}

	volumeFinePath(projectId: string, volumeNo: number, volumeSlug: string): string {
		return join(this.projectFineDir(projectId), `${pad(volumeNo)}-${volumeSlug}.md`);
	}

	volumeDir(projectId: string, volumeNo: number, volumeSlug: string): string {
		return join(this.projectVolumesDir(projectId), `${pad(volumeNo)}-${volumeSlug}`);
	}

	chapterPath(projectId: string, volumeNo: number, volumeSlug: string, chapterNo: number, chapterSlug: string): string {
		return join(this.volumeDir(projectId, volumeNo, volumeSlug), `${pad(chapterNo, 3)}-${chapterSlug}.md`);
	}

	async ensureVolumeDir(projectId: string, volumeNo: number, volumeSlug: string): Promise<void> {
		await ensureDir(this.volumeDir(projectId, volumeNo, volumeSlug));
	}

	async writeFineOutline(projectId: string, volumeNo: number, volumeSlug: string, content: string): Promise<void> {
		await writeFile(this.volumeFinePath(projectId, volumeNo, volumeSlug), content, "utf8");
	}

	async readAllFineOutlines(projectId: string): Promise<Array<{ path: string; content: string }>> {
		const dir = this.projectFineDir(projectId);
		if (!(await exists(dir))) {
			return [];
		}
		const entries = await readdir(dir, { withFileTypes: true });
		const output: Array<{ path: string; content: string }> = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
				continue;
			}
			const path = join(dir, entry.name);
			output.push({ path, content: await readFile(path, "utf8") });
		}
		output.sort((a, b) => a.path.localeCompare(b.path));
		return output;
	}

	async writeFineIndex(projectId: string, content: string): Promise<void> {
		await writeFile(this.projectFineIndexPath(projectId), content, "utf8");
	}

	async writeFineMeta(projectId: string, value: FineOutlineIndex): Promise<void> {
		await writeJsonAtomic(this.projectFineMetaPath(projectId), value);
	}

	async readFineMeta(projectId: string): Promise<FineOutlineIndex | null> {
		const path = this.projectFineMetaPath(projectId);
		if (!(await exists(path))) {
			return null;
		}
		return readJson<FineOutlineIndex>(path);
	}

	async writeChapter(projectId: string, volumeNo: number, volumeSlug: string, chapterNo: number, chapterSlug: string, content: string): Promise<string> {
		await this.ensureVolumeDir(projectId, volumeNo, volumeSlug);
		const path = this.chapterPath(projectId, volumeNo, volumeSlug, chapterNo, chapterSlug);
		await writeFile(path, content, "utf8");
		return path;
	}

	async listChapterFiles(projectId: string): Promise<string[]> {
		const result: string[] = [];
		const volumesDir = this.projectVolumesDir(projectId);
		if (!(await exists(volumesDir))) {
			return result;
		}
		const volumeEntries = await readdir(volumesDir, { withFileTypes: true });
		for (const volume of volumeEntries) {
			if (!volume.isDirectory()) {
				continue;
			}
			const volumePath = join(volumesDir, volume.name);
			const chapterEntries = await readdir(volumePath, { withFileTypes: true });
			for (const chapter of chapterEntries) {
				if (chapter.isFile() && chapter.name.endsWith(".md")) {
					result.push(join(volumePath, chapter.name));
				}
			}
		}
		result.sort();
		return result;
	}

	
	async readLatestChapter(projectId: string): Promise<LatestChapterPayload | null> {
		const files = await this.listChapterFiles(projectId);
		if (files.length === 0) {
			return null;
		}
		const path = files[files.length - 1];
		if (!path) {
			return null;
		}
		const content = await readFile(path, "utf8");
		const normalized = path.replaceAll("\\", "/");
		const match = normalized.match(/10-volumes\/(\d+)-[^/]+\/(\d+)-([^/]+)\.md$/i);
		const volumeNo = match?.[1] ? Number.parseInt(match[1], 10) : 0;
		const chapterNo = match?.[2] ? Number.parseInt(match[2], 10) : 0;
		const titleSlug = (match?.[3] || `chapter-${files.length}`).trim();
		return {
			chapterRef: volumeNo > 0 && chapterNo > 0 ? `V${volumeNo}-C${chapterNo}` : `CH-${pad(files.length, 3)}`,
			volumeNo,
			chapterNo,
			path,
			title: titleSlug.replace(/-/g, " "),
			content,
		};
	}
	async readProjectFileTree(projectId: string): Promise<string[]> {
		const projectDir = this.projectDir(projectId);
		const output: string[] = [];
		const walk = async (base: string, relativeBase: string) => {
			const entries = await readdir(base, { withFileTypes: true });
			for (const entry of entries) {
				const absolute = join(base, entry.name);
				const relative = join(relativeBase, entry.name).replaceAll("\\", "/");
				if (entry.isDirectory()) {
					await walk(absolute, relative);
				} else {
					output.push(relative);
				}
			}
		};
		await walk(projectDir, ".");
		output.sort();
		return output;
	}

	async appendReviewReport(projectId: string, chapterNo: number, report: unknown): Promise<void> {
		const path = join(this.projectReviewDir(projectId), `review-${pad(chapterNo, 3)}.json`);
		await writeJsonAtomic(path, report);
	}

	async readFineWordCount(projectId: string): Promise<number> {
		const outlines = await this.readAllFineOutlines(projectId);
		let total = 0;
		for (const item of outlines) {
			total += countWords(item.content);
		}
		return total;
	}
}













