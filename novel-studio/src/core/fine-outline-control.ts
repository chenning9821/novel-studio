import type {
	FineControlState,
	FineOutlineControlPolicy,
	FineOutlineControlPolicyInput,
	FineOutlineRequiredField,
} from "./types.js";
import { parseJsonObject, slugify } from "./utils.js";

const DEFAULT_REQUIRED_FIELDS: FineOutlineRequiredField[] = ["goal", "conflict", "turn", "hook"];

interface RawFineSegment {
	startChapter?: number;
	endChapter?: number;
	goal: string;
	conflict: string;
	turn: string;
	hook: string;
	points: string[];
}

export interface StructuredFineVolume {
	volumeTitle: string;
	volumeSlug: string;
	segments: RawFineSegment[];
}

export interface StructuredFineCompileSuccess {
	ok: true;
	volumeTitle: string;
	volumeSlug: string;
	outlineMarkdown: string;
	chapterGoals: string[];
	segmentCount: number;
	coverage: number;
	trimCount: number;
	warnings: string[];
}

export interface StructuredFineCompileFailure {
	ok: false;
	reason: string;
	warnings: string[];
	details?: Record<string, unknown>;
}

export type StructuredFineCompileResult = StructuredFineCompileSuccess | StructuredFineCompileFailure;

export interface CompileStructuredFineVolumeOptions {
	volumeNo: number;
	chaptersPerVolume: number;
	policy: FineOutlineControlPolicy;
}

export interface LenientParseOptions {
	chaptersPerVolume: number;
	segmentSize?: number;
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) {
		return min;
	}
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeRequiredFields(input?: FineOutlineRequiredField[]): FineOutlineRequiredField[] {
	if (!Array.isArray(input) || input.length === 0) {
		return [...DEFAULT_REQUIRED_FIELDS];
	}
	const allowed = new Set<FineOutlineRequiredField>(DEFAULT_REQUIRED_FIELDS);
	const output = Array.from(new Set(input.filter((field): field is FineOutlineRequiredField => allowed.has(field))));
	return output.length > 0 ? output : [...DEFAULT_REQUIRED_FIELDS];
}

export function defaultFineOutlineControlPolicy(): FineOutlineControlPolicy {
	return {
		mode: "structured_caps",
		segmentSize: 5,
		maxPointsPerSegment: 4,
		maxCharsPerPoint: 80,
		requiredFields: [...DEFAULT_REQUIRED_FIELDS],
		maxRetriesPerVolume: 3,
	};
}

export function normalizeFineOutlineControlPolicy(input?: FineOutlineControlPolicyInput): FineOutlineControlPolicy {
	const defaults = defaultFineOutlineControlPolicy();
	return {
		mode: "structured_caps",
		segmentSize: clampInt(Number(input?.segmentSize ?? defaults.segmentSize), 1, 20),
		maxPointsPerSegment: clampInt(Number(input?.maxPointsPerSegment ?? defaults.maxPointsPerSegment), 1, 12),
		maxCharsPerPoint: clampInt(Number(input?.maxCharsPerPoint ?? defaults.maxCharsPerPoint), 20, 300),
		requiredFields: normalizeRequiredFields(input?.requiredFields),
		maxRetriesPerVolume: clampInt(Number(input?.maxRetriesPerVolume ?? defaults.maxRetriesPerVolume), 1, 10),
	};
}

export function createInitialFineControlState(): FineControlState {
	return {
		currentVolume: 1,
		volumeCoverage: {},
		totalSegments: 0,
		trimCount: 0,
		failedAttempts: 0,
		warnings: [],
	};
}

function stripCodeFence(raw: string): string {
	const trimmed = raw.trim();
	return trimmed.replace(/^```(?:json|markdown|md|text)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function readString(source: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return "";
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === "string" && value.trim().length > 0) {
			const parsed = Number.parseInt(value.trim(), 10);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

function readRange(source: Record<string, unknown>): { start?: number; end?: number } {
	const directStart = readNumber(source, ["startChapter", "start", "chapterStart", "from", "start_chapter", "章节开始", "起始章节"]);
	const directEnd = readNumber(source, ["endChapter", "end", "chapterEnd", "to", "end_chapter", "章节结束", "结束章节"]);
	if (directStart !== undefined || directEnd !== undefined) {
		return { start: directStart, end: directEnd };
	}
	const range = readString(source, ["range", "chapterRange", "chapters", "章节范围", "范围"]);
	if (!range) {
		return {};
	}
	const match = range.match(/(\d+)\s*[-~\u2013\u2014至到]\s*(\d+)/i);
	if (!match?.[1] || !match?.[2]) {
		return {};
	}
	return {
		start: Number.parseInt(match[1], 10),
		end: Number.parseInt(match[2], 10),
	};
}

function readStringList(source: Record<string, unknown>, keys: string[]): string[] {
	for (const key of keys) {
		const value = source[key];
		if (!Array.isArray(value)) {
			continue;
		}
		const list = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0);
		if (list.length > 0) {
			return list;
		}
	}
	return [];
}

function normalizeLine(value: string): string {
	return value
		.replace(/^[#>*\-\d.\s]+/, "")
		.replace(/[`*_]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function limitText(value: string, maxLength = 120): string {
	const normalized = normalizeLine(value);
	if (!normalized) {
		return "";
	}
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return normalized.slice(0, maxLength).trim();
}

function looksLikeJsonNoise(value: string): boolean {
	const text = value.trim();
	if (!text) {
		return true;
	}
	if (/^[\{\}\[\]":,\s]+$/u.test(text)) {
		return true;
	}
	if (/^(?:\{|\[|")/u.test(text) && text.length <= 20) {
		return true;
	}
	if (/(?:volumeTitle|volumeSlug|segments|startChapter|endChapter|goal|conflict|turn|hook)\s*[":]/i.test(text)) {
		return true;
	}
	const symbolCount = (text.match(/[\{\}\[\]":]/g) || []).length;
	if (symbolCount / Math.max(1, text.length) >= 0.18) {
		return true;
	}
	return false;
}

function hasLanguageSignal(value: string, minChars = 4): boolean {
	const text = value.trim();
	if (!text) {
		return false;
	}
	const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
	const latin = (text.match(/[A-Za-z]/g) || []).length;
	return cjk + latin >= minChars;
}

function sanitizeSemanticText(value: string, maxLength = 120): string {
	const limited = limitText(value, maxLength);
	if (!limited) {
		return "";
	}
	if (looksLikeJsonNoise(limited)) {
		return "";
	}
	return limited;
}
function firstMeaningfulLine(lines: string[]): string {
	for (const line of lines) {
		const normalized = normalizeLine(line);
		if (normalized.length >= 4) {
			return normalized;
		}
	}
	return "";
}

function extractLabeledValue(block: string, labels: string[]): string {
	for (const label of labels) {
		const pattern = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${label}\\s*[:：]\\s*(.+)$`, "im");
		const match = block.match(pattern);
		if (match?.[1]) {
			const value = limitText(match[1]);
			if (value) {
				return value;
			}
		}
	}
	return "";
}

function extractBulletPoints(block: string): string[] {
	const lines = block.split(/\r?\n/);
	const points: string[] = [];
	for (const line of lines) {
		const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
		if (!match?.[1]) {
			continue;
		}
		const point = limitText(match[1]);
		if (point) {
			points.push(point);
		}
	}
	return points;
}

function fallbackField(base: string, field: FineOutlineRequiredField, index: number): string {
	const normalizedBase = sanitizeSemanticText(base, 100);
	const anchor = normalizedBase || `第${index + 1}段`;
	if (field === "goal") {
		return `${anchor}推进核心目标`;
	}
	if (field === "conflict") {
		return `${anchor}遭遇更强阻力`;
	}
	if (field === "turn") {
		return `${anchor}出现关键转折`;
	}
	return `${anchor}留下下一章悬念`;
}

function parseRawSegments(value: unknown): RawFineSegment[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const segments: RawFineSegment[] = [];
	for (const item of value) {
		const record = asRecord(item);
		if (!record) {
			continue;
		}
		const range = readRange(record);
		segments.push({
			startChapter: range.start,
			endChapter: range.end,
			goal: readString(record, ["goal", "segmentGoal", "coreGoal", "goal_text", "目标", "主目标", "核心目标"]),
			conflict: readString(record, ["conflict", "coreConflict", "tension", "冲突", "核心冲突", "矛盾"]),
			turn: readString(record, ["turn", "twist", "turningPoint", "转折", "反转", "关键转折"]),
			hook: readString(record, ["hook", "cliffhanger", "endingHook", "钩子", "悬念", "收尾悬念"]),
			points: readStringList(record, ["points", "beats", "events", "要点", "剧情点", "事件"]),
		});
	}
	return segments;
}

function parseStructuredFineFromRecord(parsed: Record<string, unknown>): StructuredFineVolume | null {
	const root = asRecord(parsed.volume) || parsed;
	const segments = parseRawSegments(root.segments || root.segmentCards || root.cards || root.segments_list);
	if (segments.length === 0) {
		return null;
	}
	const title =
		readString(root, ["volumeTitle", "volume_title", "title", "volume", "volumeName", "volume_name", "volume Title", "卷标题", "卷名"]) ||
		"";
	const slug = readString(root, ["volumeSlug", "volume_slug", "slug", "卷标识", "卷slug"]);
	return {
		volumeTitle: title,
		volumeSlug: slug,
		segments,
	};
}

function extractJsonCandidate(raw: string): string[] {
	const body = stripCodeFence(raw);
	const normalized = body
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/：/g, ":")
		.replace(/，/g, ",");
	const start = normalized.indexOf("{");
	const end = normalized.lastIndexOf("}");
	const candidates = [raw, body, normalized];
	if (start >= 0 && end > start) {
		const slice = normalized.slice(start, end + 1);
		candidates.push(slice);
		candidates.push(slice.replace(/,\s*([}\]])/g, "$1"));
		candidates.push(slice.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"').replace(/,\s*([}\]])/g, "$1"));
	}
	return Array.from(new Set(candidates.filter((candidate) => candidate.trim().length > 0)));
}

function parseByJsonCandidates(raw: string): StructuredFineVolume | null {
	const candidates = extractJsonCandidate(raw);
	for (const candidate of candidates) {
		const parsed = parseJsonObject<Record<string, unknown>>(candidate);
		if (!parsed) {
			continue;
		}
		const volume = parseStructuredFineFromRecord(parsed);
		if (volume) {
			return volume;
		}
	}
	return null;
}

function extractVolumeTitleFromText(raw: string): string {
	const lines = stripCodeFence(raw).split(/\r?\n/);
	for (const line of lines) {
		const heading = line.match(/^\s*#{1,3}\s*(.+)$/);
		if (heading?.[1]) {
			return limitText(heading[1], 60);
		}
		const volumeMatch = line.match(/第\s*\d+\s*卷[^\n]*/);
		if (volumeMatch?.[0]) {
			return limitText(volumeMatch[0], 60);
		}
	}
	return "";
}

function parseByRangeBlocks(raw: string, options: LenientParseOptions): StructuredFineVolume | null {
	const lines = stripCodeFence(raw).split(/\r?\n/);
	const blocks: Array<{ start: number; end: number; lines: string[]; heading: string }> = [];
	let current: { start: number; end: number; lines: string[]; heading: string } | null = null;

	const rangePattern = /(?:\u7b2c\s*)?(\d+)\s*[-~\u2013\u2014\u81f3\u5230]\s*(\d+)\s*\u7ae0|(?:ch(?:apter)?\s*)(\d+)\s*[-~\u2013\u2014to]\s*(\d+)/i;
	for (const line of lines) {
		const match = line.match(rangePattern);
		if (match) {
			if (current) {
				blocks.push(current);
			}
			const start = Number.parseInt(match[1] || match[3] || "0", 10);
			const end = Number.parseInt(match[2] || match[4] || "0", 10);
			current = {
				start: Number.isFinite(start) ? start : 0,
				end: Number.isFinite(end) ? end : 0,
				lines: [],
				heading: line,
			};
			continue;
		}
		if (current) {
			current.lines.push(line);
		}
	}
	if (current) {
		blocks.push(current);
	}
	if (blocks.length === 0) {
		return null;
	}

	const totalChapters = Math.max(1, Math.floor(options.chaptersPerVolume));
	const segments: RawFineSegment[] = blocks.map((block, index) => {
		const start = clampInt(block.start || index * (options.segmentSize || 5) + 1, 1, totalChapters);
		const end = clampInt(block.end || Math.min(start + (options.segmentSize || 5) - 1, totalChapters), 1, totalChapters);
		const blockText = block.lines.join("\n");
		const summaryCandidate = firstMeaningfulLine(block.lines) || limitText(block.heading, 100);
		const summary = sanitizeSemanticText(summaryCandidate, 100) || `segment ${start}-${end}`;
		const goal =
			sanitizeSemanticText(extractLabeledValue(blockText, ["goal", "目标", "主目标", "核心目标"]), 120) ||
			fallbackField(summary, "goal", index);
		const conflict =
			sanitizeSemanticText(extractLabeledValue(blockText, ["conflict", "冲突", "矛盾", "核心冲突"]), 120) ||
			fallbackField(summary, "conflict", index);
		const turn =
			sanitizeSemanticText(extractLabeledValue(blockText, ["turn", "转折", "反转", "关键转折"]), 120) ||
			fallbackField(summary, "turn", index);
		const hook =
			sanitizeSemanticText(extractLabeledValue(blockText, ["hook", "钩子", "悬念", "收尾悬念"]), 120) ||
			fallbackField(summary, "hook", index);
		const points = extractBulletPoints(blockText).map((point) => sanitizeSemanticText(point, 120)).filter((point) => point.length > 0);
		return {
			startChapter: start,
			endChapter: end,
			goal,
			conflict,
			turn,
			hook,
			points,
		};
	});

	if (segments.every((segment) => !hasLanguageSignal(segment.goal) && !hasLanguageSignal(segment.conflict))) {
		return null;
	}

	return {
		volumeTitle: extractVolumeTitleFromText(raw) || "",
		volumeSlug: "",
		segments,
	};
}

function parseByParagraphFallback(raw: string, options: LenientParseOptions): StructuredFineVolume | null {
	const lines = stripCodeFence(raw)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) {
		return null;
	}
	const totalChapters = Math.max(1, Math.floor(options.chaptersPerVolume));
	const segmentSize = Math.max(1, Math.floor(options.segmentSize || 5));
	const expectedSegments = Math.max(1, Math.ceil(totalChapters / segmentSize));
	const paragraphs = stripCodeFence(raw)
		.split(/\n\s*\n+/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	if (paragraphs.length === 0) {
		return null;
	}

	const usableParagraphs = paragraphs.filter((paragraph) => {
		const preview = limitText(paragraph, 200);
		return !looksLikeJsonNoise(preview);
	});
	if (usableParagraphs.length === 0) {
		return null;
	}

	const segments: RawFineSegment[] = [];
	for (let i = 0; i < expectedSegments; i++) {
		const paragraph = usableParagraphs[i] || usableParagraphs[usableParagraphs.length - 1] || lines[0] || `segment ${i + 1}`;
		const pointLines = paragraph
			.split(/\r?\n/)
			.map((line) => sanitizeSemanticText(normalizeLine(line), 120))
			.filter((line) => line.length > 0);
		const start = i * segmentSize + 1;
		const end = i === expectedSegments - 1 ? totalChapters : Math.min(start + segmentSize - 1, totalChapters);
		const summary = sanitizeSemanticText(pointLines[0] || `segment ${start}-${end}`, 100) || `segment ${start}-${end}`;
		segments.push({
			startChapter: start,
			endChapter: end,
			goal: fallbackField(summary, "goal", i),
			conflict: fallbackField(summary, "conflict", i),
			turn: fallbackField(summary, "turn", i),
			hook: fallbackField(summary, "hook", i),
			points: pointLines.slice(0, 4),
		});
	}

	return {
		volumeTitle: extractVolumeTitleFromText(raw) || "",
		volumeSlug: "",
		segments,
	};
}

export function parseStructuredFineVolume(raw: string): StructuredFineVolume | null {
	const parsed = parseByJsonCandidates(raw);
	if (!parsed || parsed.segments.length === 0) {
		return null;
	}
	return parsed;
}

export function parseStructuredFineVolumeLenient(raw: string, options: LenientParseOptions): StructuredFineVolume | null {
	const strict = parseStructuredFineVolume(raw);
	if (strict) {
		return strict;
	}
	const byRangeBlocks = parseByRangeBlocks(raw, options);
	if (byRangeBlocks) {
		return byRangeBlocks;
	}
	return parseByParagraphFallback(raw, options);
}

export function repairStructuredFineVolumeDeterministic(
	parsed: StructuredFineVolume | null,
	options: { chaptersPerVolume: number; policy: FineOutlineControlPolicy },
): StructuredFineVolume | null {
	if (!parsed) {
		return null;
	}
	const totalChapters = Math.max(1, Math.floor(options.chaptersPerVolume));
	const segmentSize = Math.max(1, Math.floor(options.policy.segmentSize));
	const expectedSegments = Math.max(1, Math.ceil(totalChapters / segmentSize));
	const sourceSegments = parsed.segments.length > 0 ? parsed.segments : [];
	if (sourceSegments.length === 0) {
		return null;
	}

	const normalized: RawFineSegment[] = [];
	for (let i = 0; i < expectedSegments; i++) {
		const source = sourceSegments[i] || sourceSegments[sourceSegments.length - 1] || sourceSegments[0];
		const start = i * segmentSize + 1;
		const end = i === expectedSegments - 1 ? totalChapters : Math.min(start + segmentSize - 1, totalChapters);
		const seedCandidate = firstMeaningfulLine([source.goal, source.conflict, source.turn, source.hook, ...(source.points || [])]);
		const seed = sanitizeSemanticText(seedCandidate, 100) || `第${start}-${end}章`;
		const goal = sanitizeSemanticText(source.goal, 120) || fallbackField(seed, "goal", i);
		const conflict = sanitizeSemanticText(source.conflict, 120) || fallbackField(seed, "conflict", i);
		const turn = sanitizeSemanticText(source.turn, 120) || fallbackField(seed, "turn", i);
		const hook = sanitizeSemanticText(source.hook, 120) || fallbackField(seed, "hook", i);
		let points = (source.points || [])
			.map((item) => sanitizeSemanticText(item, options.policy.maxCharsPerPoint))
			.filter((item) => item.length > 0)
			.slice(0, options.policy.maxPointsPerSegment);
		if (points.length === 0) {
			points = [goal, conflict, turn, hook]
				.map((item) => sanitizeSemanticText(item, options.policy.maxCharsPerPoint))
				.filter((item) => item.length > 0)
				.slice(0, options.policy.maxPointsPerSegment);
		}
		normalized.push({
			startChapter: start,
			endChapter: end,
			goal,
			conflict,
			turn,
			hook,
			points,
		});
	}

	return {
		volumeTitle: parsed.volumeTitle || "",
		volumeSlug: parsed.volumeSlug || "",
		segments: normalized,
	};
}

function normalizePoint(value: string, maxChars: number): { text: string; trimmed: boolean } {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return { text: "", trimmed: false };
	}
	if (normalized.length <= maxChars) {
		return { text: normalized, trimmed: false };
	}
	return { text: normalized.slice(0, maxChars).trim(), trimmed: true };
}

export function compileStructuredFineVolume(
	parsed: StructuredFineVolume | null,
	options: CompileStructuredFineVolumeOptions,
): StructuredFineCompileResult {
	const warnings = new Set<string>();
	const policy = options.policy;
	const totalChapters = Math.max(1, Math.floor(options.chaptersPerVolume));
	if (!parsed) {
		return {
			ok: false,
			reason: "structured_json_invalid",
			warnings: [],
		};
	}

	let trimCount = 0;
	const normalizedSegments = parsed.segments.map((segment, index) => {
		const defaultStart = index * policy.segmentSize + 1;
		const start = clampInt(segment.startChapter ?? defaultStart, 1, totalChapters);
		const endDefault = Math.min(start + policy.segmentSize - 1, totalChapters);
		const end = clampInt(segment.endChapter ?? endDefault, 1, totalChapters);
		const fields: Record<FineOutlineRequiredField, string> = {
			goal: segment.goal,
			conflict: segment.conflict,
			turn: segment.turn,
			hook: segment.hook,
		};
		for (const field of ["goal", "conflict", "turn", "hook"] as FineOutlineRequiredField[]) {
			const normalizedField = normalizePoint(fields[field], policy.maxCharsPerPoint);
			if (normalizedField.trimmed) {
				trimCount += 1;
				warnings.add(`trimmed_${field}`);
			}
			fields[field] = sanitizeSemanticText(normalizedField.text, policy.maxCharsPerPoint);
			if (!fields[field] && normalizedField.text) {
				warnings.add(`invalid_${field}`);
			}
		}
		let points = (segment.points || [])
			.map((item) => normalizePoint(item, policy.maxCharsPerPoint))
			.map((item) => ({ ...item, text: sanitizeSemanticText(item.text, policy.maxCharsPerPoint) }))
			.filter((item) => item.text.length > 0 && hasLanguageSignal(item.text, 3));
		for (const item of points) {
			if (item.trimmed) {
				trimCount += 1;
				warnings.add("trimmed_point");
			}
		}
		if (points.length === 0) {
			points = [fields.goal, fields.conflict, fields.turn, fields.hook]
				.map((item) => normalizePoint(item, policy.maxCharsPerPoint))
				.map((item) => ({ ...item, text: sanitizeSemanticText(item.text, policy.maxCharsPerPoint) }))
				.filter((item) => item.text.length > 0 && hasLanguageSignal(item.text, 3));
		}
		if (points.length > policy.maxPointsPerSegment) {
			trimCount += points.length - policy.maxPointsPerSegment;
			warnings.add("trimmed_points_list");
			points = points.slice(0, policy.maxPointsPerSegment);
		}
		return {
			start,
			end,
			goal: fields.goal,
			conflict: fields.conflict,
			turn: fields.turn,
			hook: fields.hook,
			points: points.map((item) => item.text),
		};
	});
	for (const [index, segment] of normalizedSegments.entries()) {
		if (segment.start > segment.end) {
			return {
				ok: false,
				reason: "segment_range_invalid",
				warnings: Array.from(warnings),
				details: { segmentIndex: index + 1, start: segment.start, end: segment.end },
			};
		}
		for (const field of policy.requiredFields) {
			if (!segment[field] || segment[field].trim().length === 0) {
				return {
					ok: false,
					reason: "required_field_missing",
					warnings: Array.from(warnings),
					details: { segmentIndex: index + 1, field },
				};
			}
			if (!hasLanguageSignal(segment[field]) || looksLikeJsonNoise(segment[field])) {
				return {
					ok: false,
					reason: "required_field_invalid",
					warnings: Array.from(warnings),
					details: { segmentIndex: index + 1, field, value: segment[field] },
				};
			}
		}
	}

	normalizedSegments.sort((a, b) => a.start - b.start || a.end - b.end);
	const coverage = new Array<number>(totalChapters).fill(0);
	for (const segment of normalizedSegments) {
		for (let chapter = segment.start; chapter <= segment.end; chapter++) {
			coverage[chapter - 1] += 1;
		}
	}
	const gaps: number[] = [];
	const overlaps: number[] = [];
	coverage.forEach((count, index) => {
		if (count === 0) {
			gaps.push(index + 1);
		}
		if (count > 1) {
			overlaps.push(index + 1);
		}
	});
	if (gaps.length > 0 || overlaps.length > 0) {
		return {
			ok: false,
			reason: "coverage_invalid",
			warnings: Array.from(warnings),
			details: { gaps, overlaps },
		};
	}

	const chapterGoals: string[] = [];
	for (let chapter = 1; chapter <= totalChapters; chapter++) {
		const segment = normalizedSegments.find((item) => chapter >= item.start && chapter <= item.end);
		if (!segment) {
			return {
				ok: false,
				reason: "chapter_goal_build_failed",
				warnings: Array.from(warnings),
				details: { chapter },
			};
		}
		chapterGoals.push(`Chapter ${chapter}: ${segment.goal}`);
	}

	const volumeTitle = (parsed.volumeTitle || `Volume ${options.volumeNo}`).trim();
	const volumeSlug = slugify(parsed.volumeSlug || volumeTitle || `volume-${options.volumeNo}`);
	const lines: string[] = [];
	lines.push(`# ${volumeTitle}`);
	lines.push("");
	lines.push(`- control_mode: ${policy.mode}`);
	lines.push(`- segment_size: ${policy.segmentSize}`);
	lines.push(`- coverage: 100% (${totalChapters}/${totalChapters})`);
	lines.push(`- segment_count: ${normalizedSegments.length}`);
	lines.push("");
	lines.push("## Segments");
	lines.push("");
	for (const [index, segment] of normalizedSegments.entries()) {
		lines.push(`### Segment ${index + 1} (Ch ${segment.start}-${segment.end})`);
		lines.push(`- goal: ${segment.goal}`);
		lines.push(`- conflict: ${segment.conflict}`);
		lines.push(`- turn: ${segment.turn}`);
		lines.push(`- hook: ${segment.hook}`);
		if (segment.points.length > 0) {
			lines.push("- points:");
			for (const point of segment.points) {
				lines.push(`  - ${point}`);
			}
		}
		lines.push("");
	}
	lines.push("## Chapter Goals");
	lines.push("");
	for (let i = 0; i < chapterGoals.length; i++) {
		lines.push(`${i + 1}. ${chapterGoals[i]}`);
	}

	return {
		ok: true,
		volumeTitle,
		volumeSlug,
		outlineMarkdown: `${lines.join("\n")}\n`,
		chapterGoals,
		segmentCount: normalizedSegments.length,
		coverage: 1,
		trimCount,
		warnings: Array.from(warnings),
	};
}




