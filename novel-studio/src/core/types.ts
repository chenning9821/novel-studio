export type PipelineStage =
	| "idle"
	| "plan_ready"
	| "coarse_generating"
	| "coarse_ready"
	| "fine_generating"
	| "fine_ready"
	| "chapters_generating"
	| "reviewing"
	| "completed"
	| "paused_ratio_failed"
	| "paused_review_failed"
	| "paused_stopped"
	| "terminated"
	| "error";

export type WorkflowStage = "setup" | "decisions" | "plan_review" | "generating" | "finished";

export type EventType =
	| "info"
	| "warning"
	| "error"
	| "stage_change"
	| "progress"
	| "fine_control"
	| "json_parse"
	| "context_pack"
	| "plan_section_updated"
	| "review_report"
	| "chapter_generated"
	| "chapter_stream"
	| "llm_call";

export interface RetryPolicy {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export interface WordBudgetPolicy {
	targetTotalWords: number;
	fineTargetWords: number;
	coarseTargetWords: number;
	tolerance: number;
	enforceHardGate: boolean;
	maxRatioFailures: number;
}

export type FineOutlineControlMode = "structured_caps";

export type FineOutlineRequiredField = "goal" | "conflict" | "turn" | "hook";

export interface FineOutlineControlPolicy {
	mode: FineOutlineControlMode;
	segmentSize: number;
	maxPointsPerSegment: number;
	maxCharsPerPoint: number;
	requiredFields: FineOutlineRequiredField[];
	maxRetriesPerVolume: number;
}

export interface FineOutlineControlPolicyInput {
	mode?: FineOutlineControlMode;
	segmentSize?: number;
	maxPointsPerSegment?: number;
	maxCharsPerPoint?: number;
	requiredFields?: FineOutlineRequiredField[];
	maxRetriesPerVolume?: number;
}

export interface FineControlState {
	currentVolume: number;
	volumeCoverage: Record<string, number>;
	totalSegments: number;
	trimCount: number;
	failedAttempts: number;
	warnings: string[];
}

export interface ModelProfile {
	api: "openai-completions" | "openai-responses";
	provider: string;
	modelId: string;
	baseUrl: string;
	apiKey: string;
	temperature: number;
	topP: number;
	maxTokens: number;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	rpmLimit: number;
	retry: RetryPolicy;
	extraBody?: Record<string, unknown>;
}

export interface PlanSection {
	id: string;
	title: string;
	required: boolean;
	locked: boolean;
	content: string;
	updatedAt: string;
}

export interface PlanManifest {
	version: number;
	confirmed: boolean;
	confirmedAt?: string;
	sections: PlanSection[];
}

export interface PlanDecisionOption {
	id: string;
	label: string;
	description: string;
	isOther?: boolean;
	recommended?: boolean;
}

export interface PlanDecisionItem {
	id: string;
	title: string;
	description: string;
	required: boolean;
	multiple: boolean;
	options: PlanDecisionOption[];
	selectedOptionIds: string[];
	otherText?: string;
}

export interface PlanDecisionManifest {
	version: number;
	generatedAt?: string;
	appliedAt?: string;
	completed: boolean;
	decisions: PlanDecisionItem[];
}

export interface ProjectPreferences {
	prompt: string;
	genre: string;
	theme: string;
	style: string;
	taboos: string;
	language: string;
	volumeCount: number;
	chaptersPerVolume: number;
}

export interface NovelProject {
	id: string;
	title: string;
	slug: string;
	createdAt: string;
	updatedAt: string;
	wordBudget: WordBudgetPolicy;
	fineOutlineControl: FineOutlineControlPolicy;
	preferences: ProjectPreferences;
	planManifest: PlanManifest;
}

export interface PipelineState {
	projectId: string;
	status: PipelineStage;
	isRunning: boolean;
	stopRequested: boolean;
	terminated: boolean;
	currentVolume: number;
	currentChapterInVolume: number;
	globalChapterNo: number;
	fineVolumeCursor: number;
	ratioFailures: {
		coarse: number;
		fine: number;
	};
	reviewCycleCount: number;
	fineControlState: FineControlState;
	lastError?: string;
	lastEventSeq: number;
	updatedAt: string;
}

export interface VolumePlan {
	volumeNo: number;
	title: string;
	slug: string;
	chapterGoals: string[];
	outlinePath: string;
}

export interface FineOutlineIndex {
	generatedAt: string;
	volumePlans: VolumePlan[];
}

export interface ProjectEvent {
	seq: number;
	timestamp: string;
	type: EventType;
	message: string;
	data?: Record<string, unknown>;
}

export interface MemoryFact {
	factId: string;
	chapterRef: string;
	timestamp: string;
	text: string;
	entityRefs: string[];
	timelineRef?: string;
	confidence: number;
	tags: string[];
}

export interface EntityStateSnapshot {
	entity: string;
	states: Record<string, string>;
	lastUpdatedChapter: string;
	updatedAt: string;
}

export interface TimelineEvent {
	eventId: string;
	chapterRef: string;
	sequence: number;
	description: string;
	timeMarker: string;
	location: string;
	participants: string[];
}

export interface WorldRuleEntry {
	ruleId: string;
	description: string;
	sourceChapter: string;
	updatedAt: string;
}

export interface ForeshadowingEntry {
	foreshadowId: string;
	description: string;
	introducedChapter: string;
	status: "open" | "resolved";
	resolvedChapter?: string;
}

export interface MemoryPackage {
	facts: Array<Omit<MemoryFact, "factId" | "chapterRef" | "timestamp">>;
	entityStates: Array<{ entity: string; states: Record<string, string> }>;
	timelineEvents: Array<Omit<TimelineEvent, "eventId" | "chapterRef" | "sequence">>;
	worldRules: string[];
	foreshadowing: Array<{ description: string; status: "open" | "resolved" }>;
}

export interface ConsistencyIssue {
	severity: "low" | "medium" | "high";
	category: "character" | "timeline" | "location" | "item" | "rule";
	description: string;
	evidence: string;
}

export interface ConsistencyReport {
	passed: boolean;
	issues: ConsistencyIssue[];
}

export interface AgenticReviewIssue {
	severity: "low" | "medium" | "high";
	title: string;
	description: string;
	evidence: string;
	affectedChapters: string[];
	suggestedFix: string;
}

export interface AgenticReviewReport {
	passed: boolean;
	score: number;
	summary: string;
	issues: AgenticReviewIssue[];
	suggestedActions: string[];
}

export interface CreateProjectInput {
	title: string;
	prompt?: string;
	target_total_words: number;
	genre: string;
	theme: string;
	style: string;
	taboos: string;
	language?: string;
	volumeCount?: number;
	chaptersPerVolume?: number;
	fine_control_policy?: FineOutlineControlPolicyInput;
}

export interface UpdatePlanSectionInput {
	content: string;
	lock?: boolean;
}

export interface RegeneratePlanSectionInput {
	guidance?: string;
}

export interface UpdateDecisionSelectionInput {
	selections: Record<string, string[]>;
	otherTextByDecision?: Record<string, string>;
}

export interface RegeneratePlanInput {
	guidance?: string;
}

export interface LlmCallContext {
	workflowStage: WorkflowStage;
	operation: string;
	projectId?: string;
	protocol?: string;
	protocolVersion?: string;
}

export interface LlmCallTelemetryEvent {
	kind: "call_start" | "attempt_start" | "retry_scheduled" | "call_success" | "call_failed";
	timestamp: string;
	callId: string;
	modelId: string;
	provider: string;
	maxTokens: number;
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	elapsedMs?: number;
	responseChars?: number;
	error?: string;
	workflowStage?: WorkflowStage;
	operation?: string;
	projectId?: string;
	protocol?: string;
	protocolVersion?: string;
}

export interface LatestChapterPayload {
	chapterRef: string;
	volumeNo: number;
	chapterNo: number;
	path: string;
	title: string;
	content: string;
}




export interface FineOutlinePayloadV1 {
	volumeTitle: string;
	volumeSlug: string;
	segments: Array<{
		startChapter: number;
		endChapter: number;
		goal: string;
		conflict: string;
		turn: string;
		hook: string;
		points: string[];
	}>;
}

export interface ChapterPayloadV1 {
	chapterRef: string;
	title: string;
	summary: string;
	content: string;
	continuity_checks: string[];
	seed_hooks: string[];
	forbidden_hit: string[];
}

export interface ContextPackBucketStats {
	source: string;
	beforeChars: number;
	afterChars: number;
	truncated: boolean;
}

export interface ContextPackStats {
	mode: "fine_full" | "chapter_budgeted";
	protocol: string;
	protocolVersion: string;
	totalBeforeChars: number;
	totalAfterChars: number;
	buckets: ContextPackBucketStats[];
}
