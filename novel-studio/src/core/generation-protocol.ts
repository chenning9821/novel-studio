import type {
	ChapterPayloadV1,
	ContextPackBucketStats,
	ContextPackStats,
	FineOutlinePayloadV1,
	PlanDecisionManifest,
} from "./types.js";
import { parseJsonObject } from "./utils.js";
import type { StructuredFineVolume } from "./fine-outline-control.js";

export const FINE_OUTLINE_PROTOCOL = {
	name: "FineOutlineProtocol",
	version: "v1",
} as const;

export const CHAPTER_PROTOCOL = {
	name: "ChapterProtocol",
	version: "v1",
} as const;

const JSON_NOISE_KEYS = /(?:volumeTitle|volumeSlug|segments|startChapter|endChapter|goal|conflict|turn|hook)/i;
const STRUCTURED_LABELS = /(?:开篇钩子|主线推进|剧情节点|本章要点|章节目标|outline|hook|mainline)/i;

interface ChapterBudgetSource {
	source: string;
	text: string;
	ratio: number;
	keep: "head" | "tail";
}

function compact(text: string): string {
	return text.replace(/\r\n?/g, "\n").trim();
}

function trimByMode(text: string, maxChars: number, keep: "head" | "tail"): string {
	if (maxChars <= 0) {
		return "";
	}
	if (text.length <= maxChars) {
		return text;
	}
	if (keep === "tail") {
		return text.slice(text.length - maxChars).trim();
	}
	return text.slice(0, maxChars).trim();
}

function normalizeBucket(source: string, rawText: string, maxChars: number, keep: "head" | "tail") {
	const text = compact(rawText);
	const trimmed = trimByMode(text, maxChars, keep);
	const stats: ContextPackBucketStats = {
		source,
		beforeChars: text.length,
		afterChars: trimmed.length,
		truncated: trimmed.length < text.length,
	};
	return { text: trimmed, stats };
}

function joinContextSections(sections: Array<{ source: string; text: string }>): string {
	const lines: string[] = [];
	for (const section of sections) {
		if (!section.text) {
			continue;
		}
		lines.push(`## ${section.source}`);
		lines.push(section.text);
		lines.push("");
	}
	return lines.join("\n").trim();
}

export function buildFineOutlineContextPackV1(input: {
	planText: string;
	decisionText: string;
	volumeConfigText: string;
	rulesAndTaboosText: string;
	memoryLedgerText: string;
}): { context: string; stats: ContextPackStats } {
	const sections = [
		{ source: "Plan", text: input.planText },
		{ source: "Decisions", text: input.decisionText },
		{ source: "VolumeConfig", text: input.volumeConfigText },
		{ source: "RulesAndTaboos", text: input.rulesAndTaboosText },
		{ source: "MemoryLedgers", text: input.memoryLedgerText },
	];

	const bucketStats: ContextPackBucketStats[] = [];
	const normalizedSections = sections.map((section) => {
		const normalized = normalizeBucket(section.source, section.text, Number.MAX_SAFE_INTEGER, "head");
		bucketStats.push(normalized.stats);
		return {
			source: section.source,
			text: normalized.text,
		};
	});

	const totalBeforeChars = bucketStats.reduce((sum, item) => sum + item.beforeChars, 0);
	const totalAfterChars = bucketStats.reduce((sum, item) => sum + item.afterChars, 0);
	return {
		context: joinContextSections(normalizedSections),
		stats: {
			mode: "fine_full",
			protocol: FINE_OUTLINE_PROTOCOL.name,
			protocolVersion: FINE_OUTLINE_PROTOCOL.version,
			totalBeforeChars,
			totalAfterChars,
			buckets: bucketStats,
		},
	};
}

export function buildChapterContextPackV1(input: {
	planText: string;
	volumeGoalsText: string;
	recentChaptersText: string;
	memoryDigestText: string;
	rulesAndTaboosText: string;
	totalBudgetChars?: number;
}): { context: string; stats: ContextPackStats } {
	const totalBudget = Math.max(6000, Math.floor(input.totalBudgetChars || 24000));
	const sources: ChapterBudgetSource[] = [
		{ source: "Plan", text: input.planText, ratio: 0.2, keep: "head" },
		{ source: "CurrentVolumeGoals", text: input.volumeGoalsText, ratio: 0.25, keep: "head" },
		{ source: "Recent10Chapters", text: input.recentChaptersText, ratio: 0.25, keep: "tail" },
		{ source: "Memory", text: input.memoryDigestText, ratio: 0.25, keep: "head" },
		{ source: "RulesAndTaboos", text: input.rulesAndTaboosText, ratio: 0.05, keep: "head" },
	];

	const bucketStats: ContextPackBucketStats[] = [];
	const sections = sources.map((source) => {
		const budget = Math.max(400, Math.floor(totalBudget * source.ratio));
		const normalized = normalizeBucket(source.source, source.text, budget, source.keep);
		bucketStats.push(normalized.stats);
		return {
			source: source.source,
			text: normalized.text,
		};
	});

	const totalBeforeChars = bucketStats.reduce((sum, item) => sum + item.beforeChars, 0);
	const totalAfterChars = bucketStats.reduce((sum, item) => sum + item.afterChars, 0);
	return {
		context: joinContextSections(sections),
		stats: {
			mode: "chapter_budgeted",
			protocol: CHAPTER_PROTOCOL.name,
			protocolVersion: CHAPTER_PROTOCOL.version,
			totalBeforeChars,
			totalAfterChars,
			buckets: bucketStats,
		},
	};
}

function parseJsonStrict<T>(raw: string): T | null {
	const normalized = compact(raw).replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	if (!normalized) {
		return null;
	}
	try {
		return JSON.parse(normalized) as T;
	} catch {
		return null;
	}
}

function extractJsonCandidates(raw: string): string[] {
	const normalized = compact(raw).replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	const startObj = normalized.indexOf("{");
	const endObj = normalized.lastIndexOf("}");
	const candidates = [normalized];
	if (startObj >= 0 && endObj > startObj) {
		const slice = normalized.slice(startObj, endObj + 1);
		candidates.push(slice);
		candidates.push(slice.replace(/,\s*([}\]])/g, "$1"));
		candidates.push(slice.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
	}
	return Array.from(new Set(candidates.filter((candidate) => candidate.trim().length > 0)));
}

function ensureStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0);
}

function looksLikeJsonNoise(value: string): boolean {
	const text = value.trim();
	if (!text) {
		return true;
	}
	if (/^[\{\}\[\]":,\s]+$/u.test(text)) {
		return true;
	}
	if (JSON_NOISE_KEYS.test(text) && text.length < 120) {
		return true;
	}
	const symbolCount = (text.match(/[\{\}\[\]":]/g) || []).length;
	return symbolCount / Math.max(1, text.length) >= 0.18;
}

function hasLanguageSignal(value: string, minChars = 8): boolean {
	const text = value.trim();
	if (!text) {
		return false;
	}
	const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
	const latin = (text.match(/[A-Za-z]/g) || []).length;
	return cjk + latin >= minChars;
}

function containsStructuredScaffold(content: string): string[] {
	const hits: string[] = [];
	const lines = content.split(/\r?\n/);
	for (const line of lines) {
		if (/^\s*#{1,6}\s+/.test(line)) {
			hits.push("markdown_heading");
			continue;
		}
		if (/^\s*(?:[-*]|\d+[.)])\s+/.test(line)) {
			hits.push("list_marker");
			continue;
		}
		if (/^\s*[（(][一二三四五六七八九十\d]+[）)]\s*/u.test(line)) {
			hits.push("cn_ordered_marker");
			continue;
		}
		if (/^\s*第\s*[一二三四五六七八九十\d]+\s*[部分节幕章卷]/u.test(line)) {
			hits.push("cn_section_marker");
			continue;
		}
		if (STRUCTURED_LABELS.test(line)) {
			hits.push("outline_label");
		}
	}
	return Array.from(new Set(hits));
}

function toChapterPayload(raw: unknown): ChapterPayloadV1 | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const record = raw as Record<string, unknown>;
	const chapterRef = typeof record.chapterRef === "string" ? record.chapterRef.trim() : "";
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const summary = typeof record.summary === "string" ? record.summary.trim() : "";
	const content = typeof record.content === "string" ? record.content.trim() : "";
	return {
		chapterRef,
		title,
		summary,
		content,
		continuity_checks: ensureStringArray(record.continuity_checks),
		seed_hooks: ensureStringArray(record.seed_hooks),
		forbidden_hit: ensureStringArray(record.forbidden_hit),
	};
}

export function parseChapterPayloadV1Strict(raw: string): ChapterPayloadV1 | null {
	const parsed = parseJsonStrict<unknown>(raw);
	return toChapterPayload(parsed);
}

export function parseChapterPayloadV1Lenient(raw: string): ChapterPayloadV1 | null {
	const strict = parseChapterPayloadV1Strict(raw);
	if (strict) {
		return strict;
	}
	for (const candidate of extractJsonCandidates(raw)) {
		const parsed = parseJsonObject<unknown>(candidate);
		const payload = toChapterPayload(parsed);
		if (payload) {
			return payload;
		}
	}
	return null;
}

export function validateChapterPayloadV1(
	payload: ChapterPayloadV1 | null,
	expectedChapterRef: string,
): { ok: true; payload: ChapterPayloadV1 } | { ok: false; reason: string; details?: Record<string, unknown> } {
	if (!payload) {
		return {
			ok: false,
			reason: "chapter_json_invalid",
		};
	}
	if (payload.chapterRef && payload.chapterRef !== expectedChapterRef) {
		return {
			ok: false,
			reason: "chapter_ref_mismatch",
			details: { expected: expectedChapterRef, actual: payload.chapterRef },
		};
	}
	if (!payload.title || !hasLanguageSignal(payload.title, 2)) {
		return {
			ok: false,
			reason: "chapter_title_invalid",
		};
	}
	if (!payload.summary || !hasLanguageSignal(payload.summary, 8) || looksLikeJsonNoise(payload.summary)) {
		return {
			ok: false,
			reason: "chapter_summary_invalid",
		};
	}
	if (!payload.content || payload.content.length < 120 || !hasLanguageSignal(payload.content, 40) || looksLikeJsonNoise(payload.content)) {
		return {
			ok: false,
			reason: "chapter_content_invalid",
		};
	}
	const scaffoldHits = containsStructuredScaffold(payload.content);
	if (scaffoldHits.length > 0) {
		return {
			ok: false,
			reason: "chapter_content_structured_scaffold",
			details: { hits: scaffoldHits },
		};
	}
	if (payload.forbidden_hit.length > 0) {
		return {
			ok: false,
			reason: "chapter_forbidden_hit",
			details: { forbidden_hit: payload.forbidden_hit },
		};
	}
	return {
		ok: true,
		payload: {
			...payload,
			chapterRef: expectedChapterRef,
		},
	};
}

function normalizeFineSegment(raw: unknown) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const segment = raw as Record<string, unknown>;
	const startChapter = Number.isFinite(segment.startChapter) ? Math.floor(Number(segment.startChapter)) : NaN;
	const endChapter = Number.isFinite(segment.endChapter) ? Math.floor(Number(segment.endChapter)) : NaN;
	const goal = typeof segment.goal === "string" ? segment.goal.trim() : "";
	const conflict = typeof segment.conflict === "string" ? segment.conflict.trim() : "";
	const turn = typeof segment.turn === "string" ? segment.turn.trim() : "";
	const hook = typeof segment.hook === "string" ? segment.hook.trim() : "";
	const points = ensureStringArray(segment.points);
	return {
		startChapter,
		endChapter,
		goal,
		conflict,
		turn,
		hook,
		points,
	};
}

export function validateFineOutlinePayloadV1Schema(
	payload: StructuredFineVolume | FineOutlinePayloadV1 | null,
): { ok: true } | { ok: false; reason: string; details?: Record<string, unknown> } {
	if (!payload) {
		return { ok: false, reason: "fine_payload_missing" };
	}
	if (!Array.isArray(payload.segments) || payload.segments.length === 0) {
		return { ok: false, reason: "fine_segments_missing" };
	}
	for (let i = 0; i < payload.segments.length; i++) {
		const normalized = normalizeFineSegment(payload.segments[i]);
		if (!normalized) {
			return { ok: false, reason: "fine_segment_invalid", details: { index: i + 1 } };
		}
		if (!Number.isFinite(normalized.startChapter) || !Number.isFinite(normalized.endChapter)) {
			return { ok: false, reason: "fine_segment_chapter_range_invalid", details: { index: i + 1 } };
		}
		for (const [field, value] of Object.entries({
			goal: normalized.goal,
			conflict: normalized.conflict,
			turn: normalized.turn,
			hook: normalized.hook,
		})) {
			if (!value || !hasLanguageSignal(value, 4) || looksLikeJsonNoise(value)) {
				return {
					ok: false,
					reason: "fine_segment_field_invalid",
					details: { index: i + 1, field, value },
				};
			}
		}
	}
	return { ok: true };
}

export function decisionManifestToContextText(manifest: PlanDecisionManifest): string {
	if (!manifest.decisions.length) {
		return "No decision entries.";
	}
	const lines: string[] = [];
	for (const decision of manifest.decisions) {
		lines.push(`- ${decision.title}`);
		const selectedLabels = decision.options
			.filter((option) => decision.selectedOptionIds.includes(option.id))
			.map((option) => option.label);
		if (selectedLabels.length > 0) {
			lines.push(`  selected: ${selectedLabels.join(" | ")}`);
		}
		if (decision.otherText && decision.otherText.trim()) {
			lines.push(`  other: ${decision.otherText.trim()}`);
		}
	}
	return lines.join("\n");
}
