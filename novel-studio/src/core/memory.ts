import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ConsistencyReport,
	EntityStateSnapshot,
	ForeshadowingEntry,
	MemoryFact,
	MemoryPackage,
	NovelProject,
	TimelineEvent,
	WorldRuleEntry,
} from "./types.js";
import { hashText, nowIso, parseJsonObject, scoreTokenOverlap, tokenizeSearchText } from "./utils.js";
import { FileStore } from "./storage.js";
import { LlmGateway } from "./llm.js";

interface ChapterRecord {
	chapterRef: string;
	content: string;
}

function defaultMemoryPackage(): MemoryPackage {
	return {
		facts: [],
		entityStates: [],
		timelineEvents: [],
		worldRules: [],
		foreshadowing: [],
	};
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
	try {
		const raw = await readFile(path, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

async function readJsonLines<T>(path: string): Promise<T[]> {
	try {
		const raw = await readFile(path, "utf8");
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as T);
	} catch {
		return [];
	}
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "a" });
}

export class MemoryManager {
	private readonly store: FileStore;
	private readonly llm: LlmGateway;

	constructor(store: FileStore, llm: LlmGateway) {
		this.store = store;
		this.llm = llm;
	}

	private memoryPaths(projectId: string) {
		const base = this.store.projectMemoryDir(projectId);
		return {
			facts: join(base, "facts.jsonl"),
			entities: join(base, "entities.json"),
			timeline: join(base, "timeline.json"),
			worldRules: join(base, "world-rules.json"),
			foreshadowing: join(base, "foreshadowing.json"),
		};
	}

	async memoryPut(project: NovelProject, chapterRef: string, chapterContent: string): Promise<void> {
		const packageData = await this.extractMemoryPackage(project, chapterRef, chapterContent);
		await this.applyMemoryPackage(project.id, chapterRef, packageData);
	}

	async rebuildFromChapters(project: NovelProject, chapters: ChapterRecord[]): Promise<void> {
		const paths = this.memoryPaths(project.id);
		await writeFile(paths.facts, "", "utf8");
		await writeJsonFile(paths.entities, []);
		await writeJsonFile(paths.timeline, []);
		await writeJsonFile(paths.worldRules, []);
		await writeJsonFile(paths.foreshadowing, []);

		for (const chapter of chapters) {
			await this.memoryPut(project, chapter.chapterRef, chapter.content);
		}
	}

	async memoryGet(projectId: string, query: string, maxFacts = 24): Promise<MemoryFact[]> {
		const paths = this.memoryPaths(projectId);
		const facts = await readJsonLines<MemoryFact>(paths.facts);
		const queryTokens = tokenizeSearchText(query);
		const ranked = facts
			.map((fact) => {
				const factTokens = tokenizeSearchText(`${fact.text} ${fact.entityRefs.join(" ")} ${fact.tags.join(" ")}`);
				const score = scoreTokenOverlap(queryTokens, factTokens) + fact.confidence * 0.15;
				return {
					fact,
					score,
				};
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, maxFacts)
			.map((entry) => entry.fact);
		return ranked;
	}

	async loadMemoryDigest(projectId: string, query: string): Promise<string> {
		const relevantFacts = await this.memoryGet(projectId, query, 30);
		const paths = this.memoryPaths(projectId);
		const entities = await readJsonFile<EntityStateSnapshot[]>(paths.entities, []);
		const timeline = await readJsonFile<TimelineEvent[]>(paths.timeline, []);
		const worldRules = await readJsonFile<WorldRuleEntry[]>(paths.worldRules, []);
		const foreshadowing = await readJsonFile<ForeshadowingEntry[]>(paths.foreshadowing, []);

		const lines: string[] = [];
		lines.push("# Relevant Facts");
		for (const fact of relevantFacts) {
			lines.push(`- [${fact.chapterRef}] ${fact.text}`);
		}
		lines.push("");
		lines.push("# Entity States");
		for (const entity of entities.slice(0, 30)) {
			lines.push(`- ${entity.entity}: ${JSON.stringify(entity.states)}`);
		}
		lines.push("");
		lines.push("# Timeline");
		for (const event of timeline.slice(-30)) {
			lines.push(`- ${event.chapterRef}: ${event.description} @ ${event.timeMarker} (${event.location})`);
		}
		lines.push("");
		lines.push("# World Rules");
		for (const rule of worldRules.slice(0, 30)) {
			lines.push(`- ${rule.description}`);
		}
		lines.push("");
		lines.push("# Unresolved Foreshadowing");
		for (const item of foreshadowing.filter((entry) => entry.status === "open").slice(0, 30)) {
			lines.push(`- ${item.description} (introduced: ${item.introducedChapter})`);
		}
		return lines.join("\n");
	}

	async consistencyPrecheck(project: NovelProject, chapterGoal: string): Promise<ConsistencyReport> {
		const digest = await this.loadMemoryDigest(project.id, chapterGoal);
		const systemPrompt = `你是小说一致性检查员。你只能返回 JSON：{"passed":boolean,"issues":[{"severity":"low|medium|high","category":"character|timeline|location|item|rule","description":"...","evidence":"..."}]}`;
		const userPrompt = `小说标题：${project.title}\n章节目标：${chapterGoal}\n\n记忆摘要：\n${digest}\n\n请检查该章节目标在执行前可能出现的冲突。`;
		try {
			const report = await this.llm.completeJson<ConsistencyReport>(systemPrompt, userPrompt, undefined, { workflowStage: "generating", operation: "consistency_precheck", projectId: project.id });
			return {
				passed: report.passed,
				issues: Array.isArray(report.issues) ? report.issues : [],
			};
		} catch {
			return {
				passed: true,
				issues: [],
			};
		}
	}

	private async extractMemoryPackage(project: NovelProject, chapterRef: string, chapterContent: string): Promise<MemoryPackage> {
		const systemPrompt = [
			"你是小说记忆抽取器。",
			"输出严格 JSON 对象，结构：",
			"{",
			'  "facts": [{"text":string,"entityRefs":string[],"timelineRef":string,"confidence":number,"tags":string[]}],',
			'  "entityStates": [{"entity":string,"states":{[k:string]:string}}],',
			'  "timelineEvents": [{"description":string,"timeMarker":string,"location":string,"participants":string[]}],',
			'  "worldRules": string[],',
			'  "foreshadowing": [{"description":string,"status":"open|resolved"}]',
			"}",
			"不要输出 Markdown，不要输出额外文本。",
		].join("\n");
		const userPrompt = `项目：${project.title}\n章节：${chapterRef}\n\n正文：\n${chapterContent.slice(0, 12000)}`;
		try {
			const data = await this.llm.completeJson<MemoryPackage>(systemPrompt, userPrompt, undefined, { workflowStage: "generating", operation: "memory_put_extract", projectId: project.id });
			return {
				...defaultMemoryPackage(),
				...data,
			};
		} catch {
			const fallback = parseJsonObject<MemoryPackage>(chapterContent);
			if (fallback) {
				return fallback;
			}
			return {
				facts: [
					{
						text: `章节 ${chapterRef} 已生成。`,
						entityRefs: [],
						timelineRef: chapterRef,
						confidence: 0.3,
						tags: ["fallback"],
					},
				],
				entityStates: [],
				timelineEvents: [],
				worldRules: [],
				foreshadowing: [],
			};
		}
	}

	private async applyMemoryPackage(projectId: string, chapterRef: string, memoryPackage: MemoryPackage): Promise<void> {
		const paths = this.memoryPaths(projectId);
		const now = nowIso();

		for (const fact of memoryPackage.facts || []) {
			const text = fact.text?.trim();
			if (!text) {
				continue;
			}
			const record: MemoryFact = {
				factId: hashText(`${chapterRef}:${text}:${JSON.stringify(fact.entityRefs || [])}`),
				chapterRef,
				timestamp: now,
				text,
				entityRefs: fact.entityRefs || [],
				timelineRef: fact.timelineRef,
				confidence: Math.max(0, Math.min(1, fact.confidence ?? 0.5)),
				tags: fact.tags || [],
			};
			await appendJsonLine(paths.facts, record);
		}

		const entities = await readJsonFile<EntityStateSnapshot[]>(paths.entities, []);
		const entityMap = new Map<string, EntityStateSnapshot>(entities.map((item) => [item.entity, item]));
		for (const update of memoryPackage.entityStates || []) {
			const entityName = update.entity?.trim();
			if (!entityName) {
				continue;
			}
			const previous = entityMap.get(entityName);
			entityMap.set(entityName, {
				entity: entityName,
				states: {
					...(previous?.states || {}),
					...(update.states || {}),
				},
				lastUpdatedChapter: chapterRef,
				updatedAt: now,
			});
		}
		await writeJsonFile(paths.entities, Array.from(entityMap.values()).sort((a, b) => a.entity.localeCompare(b.entity)));

		const timeline = await readJsonFile<TimelineEvent[]>(paths.timeline, []);
		let seq = timeline.length;
		for (const event of memoryPackage.timelineEvents || []) {
			seq += 1;
			timeline.push({
				eventId: hashText(`${chapterRef}:${event.description}:${seq}`),
				chapterRef,
				sequence: seq,
				description: event.description,
				timeMarker: event.timeMarker || "unspecified",
				location: event.location || "unspecified",
				participants: event.participants || [],
			});
		}
		await writeJsonFile(paths.timeline, timeline);

		const rules = await readJsonFile<WorldRuleEntry[]>(paths.worldRules, []);
		const ruleMap = new Map<string, WorldRuleEntry>(rules.map((rule) => [rule.description, rule]));
		for (const rule of memoryPackage.worldRules || []) {
			const description = rule.trim();
			if (!description) {
				continue;
			}
			ruleMap.set(description, {
				ruleId: hashText(description),
				description,
				sourceChapter: chapterRef,
				updatedAt: now,
			});
		}
		await writeJsonFile(paths.worldRules, Array.from(ruleMap.values()));

		const foreshadowing = await readJsonFile<ForeshadowingEntry[]>(paths.foreshadowing, []);
		const foreshadowMap = new Map<string, ForeshadowingEntry>(foreshadowing.map((entry) => [entry.description, entry]));
		for (const entry of memoryPackage.foreshadowing || []) {
			const description = entry.description?.trim();
			if (!description) {
				continue;
			}
			const previous = foreshadowMap.get(description);
			if (!previous) {
				foreshadowMap.set(description, {
					foreshadowId: hashText(description),
					description,
					introducedChapter: chapterRef,
					status: entry.status || "open",
					resolvedChapter: entry.status === "resolved" ? chapterRef : undefined,
				});
				continue;
			}
			if (entry.status === "resolved") {
				foreshadowMap.set(description, {
					...previous,
					status: "resolved",
					resolvedChapter: chapterRef,
				});
			}
		}
		await writeJsonFile(paths.foreshadowing, Array.from(foreshadowMap.values()));
	}
}



