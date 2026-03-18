import { createHash, randomUUID } from "node:crypto";

export function nowIso(): string {
	return new Date().toISOString();
}

export function createId(): string {
	return randomUUID();
}

export function slugify(value: string): string {
	const normalized = value
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9\-\u4e00-\u9fff]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return normalized.length > 0 ? normalized : "untitled";
}

export function pad(num: number, length = 2): string {
	return String(num).padStart(length, "0");
}

export function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function countWords(text: string): number {
	const cjkChars = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
	const latinWords = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
	return cjkChars + latinWords;
}

export function extractTextBlocks(raw: string): string {
	return raw.replace(/```[\s\S]*?```/g, "").trim();
}

export function parseJsonObject<T>(raw: string): T | null {
	const trimmed = raw.trim();
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) {
			const slice = trimmed.slice(start, end + 1);
			try {
				return JSON.parse(slice) as T;
			} catch {
				return null;
			}
		}
	}
	return null;
}

export function parseJsonArray<T>(raw: string): T[] | null {
	const trimmed = raw.trim();
	try {
		return JSON.parse(trimmed) as T[];
	} catch {
		const start = trimmed.indexOf("[");
		const end = trimmed.lastIndexOf("]");
		if (start >= 0 && end > start) {
			const slice = trimmed.slice(start, end + 1);
			try {
				return JSON.parse(slice) as T[];
			} catch {
				return null;
			}
		}
	}
	return null;
}

export function ensureWithinTolerance(actual: number, target: number, tolerance: number): boolean {
	if (target <= 0) {
		return true;
	}
	const lower = target * (1 - tolerance);
	const upper = target * (1 + tolerance);
	return actual >= lower && actual <= upper;
}

export function tokenizeSearchText(value: string): string[] {
	const tokens = value
		.toLowerCase()
		.split(/[^a-z0-9\u4e00-\u9fff]+/)
		.filter((token) => token.length > 0);
	return Array.from(new Set(tokens));
}

export function scoreTokenOverlap(tokensA: string[], tokensB: string[]): number {
	if (tokensA.length === 0 || tokensB.length === 0) {
		return 0;
	}
	const setB = new Set(tokensB);
	let overlap = 0;
	for (const token of tokensA) {
		if (setB.has(token)) {
			overlap++;
		}
	}
	return overlap / Math.max(tokensA.length, tokensB.length);
}

