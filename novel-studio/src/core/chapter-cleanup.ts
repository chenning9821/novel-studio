export interface ChapterCleanupResult {
	content: string;
	removedStructuralLines: number;
	normalizedStructuredLines: number;
}

const STRUCTURAL_LABEL_PATTERN = /^(开篇钩子|主线推进|冲突升级|矛盾升级|高潮|高潮爆发|结尾钩子|尾声钩子|伏笔回收|章节目标|本章要点|剧情节点|情节推进)$/u;

function collapseBlankLines(lines: string[]): string[] {
	const output: string[] = [];
	let lastBlank = true;
	for (const line of lines) {
		const blank = line.trim().length === 0;
		if (blank && lastBlank) {
			continue;
		}
		output.push(blank ? "" : line);
		lastBlank = blank;
	}
	while (output.length > 0 && output[0] === "") {
		output.shift();
	}
	while (output.length > 0 && output[output.length - 1] === "") {
		output.pop();
	}
	return output;
}

function stripEnumeratedPrefix(text: string): string {
	return text
		.replace(/^[（(【\[]\s*[一二三四五六七八九十百千0-9]+\s*[）)】\]]\s*/u, "")
		.replace(/^第\s*[一二三四五六七八九十百千0-9]+\s*[部分节幕章卷]\s*/u, "")
		.trim();
}

function isPlainEnumeratedLabel(text: string): boolean {
	const trimmed = text.trim();
	if (/^[（(【\[]\s*[一二三四五六七八九十百千0-9]+\s*[）)】\]]\s*.+$/u.test(trimmed)) {
		return true;
	}
	if (/^第\s*[一二三四五六七八九十百千0-9]+\s*[部分节幕章卷]\s*.+$/u.test(trimmed)) {
		return true;
	}
	return false;
}

function isStructuralSectionLabel(text: string, fromStructuredLine: boolean): boolean {
	const trimmed = text.trim();
	if (!trimmed) {
		return true;
	}
	const normalized = stripEnumeratedPrefix(trimmed);
	if (!normalized) {
		return true;
	}
	if (STRUCTURAL_LABEL_PATTERN.test(normalized)) {
		return true;
	}
	if (/^(hook|summary|outline|section|part|arc)\b/i.test(normalized)) {
		return true;
	}
	if (isPlainEnumeratedLabel(trimmed)) {
		return true;
	}
	if (fromStructuredLine && normalized.length <= 24 && !/[。！？!?]/u.test(normalized)) {
		return true;
	}
	return false;
}

function normalizeStructuredLine(line: string): { normalized: string; removed: boolean; converted: boolean } {
	const trimmed = line.trim();
	const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/u);
	if (headingMatch?.[1]) {
		const candidate = headingMatch[1].trim();
		if (isStructuralSectionLabel(candidate, true)) {
			return { normalized: "", removed: true, converted: false };
		}
		return { normalized: candidate, removed: false, converted: true };
	}
	const bulletMatch = trimmed.match(/^(?:[-*]|\d+[.)])\s+(.+)$/u);
	if (bulletMatch?.[1]) {
		const candidate = bulletMatch[1].trim();
		if (isStructuralSectionLabel(candidate, true)) {
			return { normalized: "", removed: true, converted: false };
		}
		return { normalized: candidate, removed: false, converted: true };
	}
	if (isStructuralSectionLabel(trimmed, false)) {
		return { normalized: "", removed: true, converted: false };
	}
	return { normalized: line, removed: false, converted: false };
}

export function sanitizeGeneratedChapter(raw: string): ChapterCleanupResult {
	const lines = raw.replace(/\r\n?/g, "\n").split("\n");
	const output: string[] = [];
	let removedStructuralLines = 0;
	let normalizedStructuredLines = 0;

	for (const line of lines) {
		if (line.trim().length === 0) {
			output.push("");
			continue;
		}
		const normalized = normalizeStructuredLine(line);
		if (normalized.removed) {
			removedStructuralLines += 1;
			continue;
		}
		if (normalized.converted) {
			normalizedStructuredLines += 1;
		}
		output.push(normalized.normalized);
	}

	const collapsed = collapseBlankLines(output);
	return {
		content: collapsed.join("\n").trim(),
		removedStructuralLines,
		normalizedStructuredLines,
	};
}
