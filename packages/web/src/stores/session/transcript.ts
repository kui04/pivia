import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { ParsedSkillBlock } from "@earendil-works/pi-coding-agent";
import { isRecord, type StrictOmit } from "@pivia/protocol";

import { stripAnsi } from "@/lib";

import type { ProjectedTranscriptItem } from "./projection";
import type { LiveToolExecutionState } from "./reducer";
import { readFiniteNumber, readNonEmptyString, readNonNegativeNumber, readPositiveNumber } from "./readers";
import { parseSkillBlock } from "./skill-block";
import {
    buildToolPresentation,
    formatReadLineRangeSummary,
    readToolFilePath,
    toToolArguments,
    toToolResultBlocks,
    type NormalizedToolResultBlock,
    type TranscriptNestedCallStatus,
    type TranscriptNestedCallsSummary,
    type TranscriptToolArguments,
    type TranscriptToolKind,
    type TranscriptToolPreview,
    type TranscriptToolStatus,
    type TranscriptToolWarning,
} from "./tool-details";
import {
    countDroppedThinkingBlocks,
    formatCacheWarmingText,
    formatSystemNoteMeta,
    formatThinkingDropNotice,
    normalizeUsageNote,
    readNonNegativeTokenCount,
    readSummaryBilling,
    readUsageTotalCostUsd,
    type TranscriptNoticeItem,
    type TranscriptSummaryBilling,
} from "./transcript-meta";

function ignoreUnknownVariant(value: never): void {
    // Compile-time exhaustiveness check over the Pi SDK union; unknown variants from a newer
    // session file are ignored at runtime so the rest of the transcript still renders.
    void value;
}

export { formatSystemNoteMeta };

export type {
    TranscriptNestedCallStatus,
    TranscriptNestedCallsSummary,
    TranscriptToolKind,
    TranscriptToolPreview,
    TranscriptToolWarning,
};

type ProjectedEntryItem = Extract<ProjectedTranscriptItem, { kind: "entry" }>;
type SessionEntry = ProjectedEntryItem["entry"];
type EntryOf<TType extends SessionEntry["type"]> = Extract<SessionEntry, { type: TType }>;
type MessageEntry = EntryOf<"message">;
type MessageOf<TRole extends MessageEntry["message"]["role"]> = Extract<MessageEntry["message"], { role: TRole }>;
type AssistantEntryMessage = MessageOf<"assistant">;
type ToolResultEntryMessage = MessageOf<"toolResult">;
type BashExecutionRecord = MessageOf<"bashExecution">;
type CustomMessageEntry = EntryOf<"custom_message">;
type SummaryEntry = EntryOf<"compaction"> | EntryOf<"branch_summary">;
type EditableContent = NonNullable<ProjectedEntryItem["editedContent"]>;

/** Classification and argument digest extracted for one tool call. */
export type TranscriptToolMeta = {
    /** Built-in tool category, or `generic` for extension and MCP tools. */
    readonly toolKind: TranscriptToolKind;
    /** Single-line primary argument summary rendered beside the tool's display label. */
    readonly summary: string;
};

/**
 * How a duration reaches the view.
 *
 * The two cases are exclusive: a static item carries its final duration, and a running item only
 * carries its start time and lets the component count. Keeping both numbers in one item allowed a
 * caller to add them twice.
 */
export type TranscriptTiming =
    | { readonly kind: "static"; readonly durationMs: number | null }
    | { readonly kind: "since"; readonly startedAtMs: number };

/** One collapsible thinking block inside a turn timeline. */
export type TranscriptThinkingStep = {
    readonly kind: "thinking";
    readonly id: string;
    readonly thinking: string;
    readonly redacted: boolean;
    readonly streaming: boolean;
};

/** One collapsible tool call and its paired result inside a turn timeline. */
export type TranscriptToolCallStep = TranscriptToolMeta & {
    readonly kind: "toolCall";
    readonly id: string;
    /** Raw SDK tool name; the view derives the display label and icon from `toolKind`. */
    readonly toolName: string;
    readonly arguments: TranscriptToolArguments;
    readonly argumentsError: string | null;
    readonly status: TranscriptToolStatus;
    readonly output: string;
    readonly images: readonly ImageContent[];
    readonly preview: TranscriptToolPreview;
    readonly warnings: readonly TranscriptToolWarning[];
    readonly nestedCalls: TranscriptNestedCallsSummary | null;
    readonly timing: TranscriptTiming;
};

/** One intermediate assistant reply rendered directly inside the turn timeline. */
export type TranscriptReplyStep = {
    readonly kind: "reply";
    readonly id: string;
    readonly text: string;
    readonly streaming: boolean;
};

/** One chronological item inside a collapsed turn group. */
export type TranscriptStep = TranscriptThinkingStep | TranscriptToolCallStep | TranscriptReplyStep;

/** One user prompt rendered as a bubble. */
export type TranscriptUserItem = {
    readonly kind: "user";
    readonly id: string;
    readonly text: string;
    readonly images: readonly ImageContent[];
};

export type TranscriptSkillItem = {
    readonly kind: "skill";
    readonly id: string;
} & Readonly<StrictOmit<ParsedSkillBlock, "userMessage">>;

/**
 * Terminal state of one persisted `!` command.
 *
 * The session appends the record only after the command ends, so a persisted record is never
 * running; live output needs its own state once the composer can start commands.
 */
export type TranscriptBashStatus =
    | { readonly kind: "succeeded" }
    | { readonly kind: "failed"; readonly exitCode: number }
    | { readonly kind: "cancelled" }
    | { readonly kind: "noExitCode" };

/**
 * Truncation of one persisted `!` record.
 *
 * The record stores only a boolean and an optional full-output path, not a `TruncationResult`, so
 * this model cannot report line or byte counts the way {@link TranscriptToolWarning} does.
 */
export type TranscriptBashTruncation =
    | { readonly kind: "none" }
    | {
          readonly kind: "truncated";
          readonly fullOutputPath: Exclude<BashExecutionRecord["fullOutputPath"], undefined> | null;
      };

/** One user `!` command record, rendered between the conversation turns it ran between. */
export type TranscriptBashItem = {
    readonly kind: "bash";
    readonly id: string;
    readonly command: BashExecutionRecord["command"];
    readonly output: BashExecutionRecord["output"];
    /** True for the `!!` prefix, whose output stays out of the model context. */
    readonly excludeFromContext: Exclude<BashExecutionRecord["excludeFromContext"], undefined>;
    readonly status: TranscriptBashStatus;
    readonly truncation: TranscriptBashTruncation;
};

/**
 * One extension message the transcript shows.
 *
 * The SDK keeps these apart from user prompts: an extension decides the `customType`, the message
 * can carry attachments without text, and the label tells the reader the words are not their own.
 */
export type TranscriptCustomItem = {
    readonly kind: "custom";
    readonly id: string;
    /** Extension-defined message kind, rendered as the block label. */
    readonly customType: string;
    /** Message text as Markdown; empty when the message carried only attachments. */
    readonly text: string;
    readonly images: readonly ImageContent[];
};

/** One system note between prompts, such as a compaction checkpoint or a branch summary. */
export type TranscriptNoteItem = {
    readonly kind: "note";
    readonly id: string;
    /** Short heading that names the checkpoint. */
    readonly title: string;
    /** Text the entry carries; the transcript renders it as Markdown. */
    readonly text: string;
    /** Token count on the branch prior to compaction, when recorded on a `compaction` entry. */
    readonly tokensBefore?: number | undefined;
    /** Summary generation token & cost totals, when recorded on `compaction` or `branch_summary`. */
    readonly billing?: TranscriptSummaryBilling | undefined;
};

/**
 * How an assistant round ended, reduced to the states the transcript shows.
 *
 * `open` merges the SDK's `pending` and `toolUse` reasons because either one leaves the turn open,
 * which is not the same fact as `TranscriptTurnItem.streaming` (that flag follows runtime
 * activity). `aborted` and `error` carry their final text so a renderer never falls back to a
 * default string of its own.
 */
export type TranscriptTurnOutcome =
    | { readonly kind: "open" }
    | { readonly kind: "completed" }
    | { readonly kind: "truncated" }
    | { readonly kind: "deferred" }
    | { readonly kind: "aborted"; readonly message: string }
    | { readonly kind: "error"; readonly message: string };

/**
 * One complete agent response cycle between user prompts.
 *
 * The final text reply sits below the `Worked for Xs` group while all thoughts, tool calls and
 * intermediate replies stay inside `steps`.
 */
export type TranscriptTurnItem = {
    readonly kind: "turn";
    readonly id: string;
    readonly steps: readonly TranscriptStep[];
    readonly finalReply: string | null;
    readonly outcome: TranscriptTurnOutcome;
    readonly timing: TranscriptTiming;
    readonly streaming: boolean;
    /** Warning notice attached when Anthropic dropped additional thinking blocks in this turn. */
    readonly diagnosticsNotice?: string | undefined;
};

/** One top-level entry in the transcript list. */
export type TranscriptItem =
    | TranscriptUserItem
    | TranscriptSkillItem
    | TranscriptBashItem
    | TranscriptCustomItem
    | TranscriptTurnItem
    | TranscriptNoteItem
    | TranscriptNoticeItem;

/** Optional inputs for live transcript rendering. */
export type BuildTranscriptOptions = {
    /**
     * Assistant message still streaming over the socket, or settled and waiting for its persisted
     * entry. It joins the turn aggregation after the projected entries.
     */
    readonly liveMessage?: AssistantMessage | null | undefined;
    /**
     * True while the runtime can still append a result for the trailing turn.
     *
     * Only the trailing turn may report a tool call as running. A historical call without a result
     * cannot still run, and a live message without this flag is not animated, so a reconnected but
     * idle session never shows a fake working state.
     */
    readonly runtimeActive?: boolean | undefined;
    /** Live tool executions indexed by `toolCallId`, used until persisted `toolResult` entries arrive. */
    readonly liveToolExecutions?: Readonly<Record<string, LiveToolExecutionState>> | undefined;
};

/** One normalized assistant content block, safe to render. */
type AssistantBlock =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "thinking"; readonly thinking: string; readonly redacted: boolean }
    | {
          readonly type: "toolCall";
          readonly id: string;
          readonly name: string;
          readonly arguments: TranscriptToolArguments;
          readonly argumentsError: string | null;
      };

type ToolResultBlock = NormalizedToolResultBlock;

type AssistantStopReason = AssistantEntryMessage["stopReason"];

/** Assistant message reduced to the fields the transcript reads. */
type ViewAssistantMessage = {
    readonly role: "assistant";
    readonly content: readonly AssistantBlock[];
    readonly timestamp: number;
    /** Known reason, or null when a session file or socket held an unrecognized value. */
    readonly stopReason: AssistantStopReason | null;
    readonly errorMessage: string | null;
    readonly durationMs: number | null;
    readonly droppedThinkingBlocks: number;
};

/** Tool result reduced to the fields the transcript reads. */
type ViewToolResultMessage = {
    readonly role: "toolResult";
    readonly toolCallId: string;
    readonly content: readonly ToolResultBlock[];
    readonly details: unknown;
    readonly nestedCalls: unknown;
    readonly isError: boolean;
    readonly timestamp: number;
    readonly durationMs: number | null;
};

/** One message of a turn. */
type TurnMessage = {
    readonly message: ViewAssistantMessage | ViewToolResultMessage;
    /** True for the live assistant message that has no persisted entry yet. */
    readonly live: boolean;
};

/** One assistant message of a turn, narrowed so the builder never re-checks the role. */
type AssistantTurnMessage = {
    readonly message: ViewAssistantMessage;
    readonly live: boolean;
};

function collapseWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function stringArg(args: TranscriptToolArguments, key: string): string {
    const raw = args[key];
    return typeof raw === "string" ? collapseWhitespace(raw) : "";
}

function firstCodeLine(args: TranscriptToolArguments): string {
    const raw = args.code;
    if (typeof raw !== "string") {
        return "";
    }
    const line = raw
        .split(/\r?\n/)
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== "");
    return line === undefined ? "" : collapseWhitespace(line);
}

function firstScalarValue(args: TranscriptToolArguments): string {
    for (const value of Object.values(args)) {
        if (typeof value === "string") {
            const collapsed = collapseWhitespace(value);
            if (collapsed !== "") {
                return collapsed;
            }
        } else if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }
    }
    return "";
}

function formatSearchSummary(args: TranscriptToolArguments, extraQualifier?: string): string {
    const pattern = stringArg(args, "pattern");
    const path = stringArg(args, "path");
    const base = pattern !== "" && path !== "" ? `${pattern} in ${path}` : pattern !== "" ? pattern : path;
    if (base === "") {
        return "";
    }
    const limit = readPositiveNumber(args.limit);
    const qualifierSuffix = extraQualifier !== undefined && extraQualifier !== "" ? ` (${extraQualifier})` : "";
    const limitSuffix = limit !== undefined ? ` (limit ${limit})` : "";
    return `${base}${qualifierSuffix}${limitSuffix}`;
}

/**
 * Classifies one tool call and extracts a single-line primary argument summary for its header row.
 *
 * Only Pi's built-in tools map to dedicated kinds; all extension and MCP tools share `generic`.
 * Display labels and icons belong to the view (`ToolCallBlock/toolDisplay.ts`), so this function
 * stays a data projection.
 */
export function describeToolCall(name: string, args: TranscriptToolArguments): TranscriptToolMeta {
    switch (name) {
        case "bash":
        case "powershell": {
            const command = stringArg(args, "command");
            const timeout = readPositiveNumber(args.timeout);
            const summary = timeout !== undefined && command !== "" ? `${command} (timeout ${timeout}s)` : command;
            return { toolKind: name, summary };
        }
        case "read": {
            const path = readToolFilePath(args) ?? "";
            const range = formatReadLineRangeSummary(args.offset, args.limit);
            return { toolKind: name, summary: path !== "" ? `${path}${range}` : "" };
        }
        case "write":
        case "edit":
            return { toolKind: name, summary: readToolFilePath(args) ?? "" };
        case "grep":
            return { toolKind: name, summary: formatSearchSummary(args, stringArg(args, "glob")) };
        case "find":
            return { toolKind: name, summary: formatSearchSummary(args) };
        case "ls": {
            const path = stringArg(args, "path");
            const limit = readPositiveNumber(args.limit);
            const base = path !== "" ? path : ".";
            return { toolKind: name, summary: limit !== undefined ? `${base} (limit ${limit})` : base };
        }
        case "codemode":
            return { toolKind: name, summary: firstCodeLine(args) };
        case "tool_search":
            return { toolKind: name, summary: stringArg(args, "query") };
        default:
            return { toolKind: "generic", summary: firstScalarValue(args) };
    }
}

function parseIsoTimestamp(iso: string): number {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
}

/** Read one assistant block, or return null for an unknown or incomplete block. */
function toAssistantBlock(raw: unknown): AssistantBlock | null {
    if (!isRecord(raw)) {
        return null;
    }
    switch (raw.type) {
        case "text":
            return typeof raw.text === "string" ? { type: "text", text: raw.text } : null;
        case "thinking":
            return typeof raw.thinking === "string"
                ? { type: "thinking", thinking: raw.thinking, redacted: raw.redacted === true }
                : null;
        case "toolCall":
            return {
                type: "toolCall",
                // A call without an id still renders; the step id then falls back to its position.
                id: typeof raw.id === "string" ? raw.id : "",
                name: readNonEmptyString(raw.name) ?? "unknown",
                arguments: toToolArguments(raw.arguments),
                argumentsError: typeof raw.argumentsError === "string" ? raw.argumentsError : null,
            };
        default:
            return null;
    }
}

/**
 * Read edited or stored assistant content as renderable blocks.
 *
 * A `context_edit` may replace an assistant message with a plain string, and a streamed message can
 * hold sparse content holes after an out-of-order delta. Both become a dense, typed block list so
 * no later reader has to re-check the shape.
 */
function toAssistantBlocks(content: unknown): AssistantBlock[] {
    if (typeof content === "string") {
        return [{ type: "text", text: content }];
    }
    return Array.isArray(content) ? content.flatMap((raw) => toAssistantBlock(raw) ?? []) : [];
}

/** Split normalized text/image blocks into the two projections the transcript renders. */
function splitContentBlocks(blocks: readonly NormalizedToolResultBlock[]): {
    texts: string[];
    images: ImageContent[];
} {
    const texts: string[] = [];
    const images: ImageContent[] = [];
    for (const block of blocks) {
        if (block.type === "text") {
            texts.push(block.text);
        } else {
            images.push(block);
        }
    }
    return { texts, images };
}

/** Split user or extension content into text and attachments. */
function readUserContent(content: unknown): { text: string; images: ImageContent[] } {
    const { texts, images } = splitContentBlocks(toToolResultBlocks(content));
    return {
        text: texts
            .map((text) => text.trim())
            .filter((text) => text !== "")
            .join("\n\n"),
        images,
    };
}

function readAssistantMessage(
    message: AssistantEntryMessage,
    editedContent: EditableContent | undefined,
): ViewAssistantMessage {
    return {
        role: "assistant",
        content: toAssistantBlocks(editedContent ?? message.content),
        timestamp: readFiniteNumber(message.timestamp) ?? 0,
        stopReason: isKnownStopReason(message.stopReason) ? message.stopReason : null,
        errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : null,
        durationMs: readNonNegativeNumber(message.durationMs),
        droppedThinkingBlocks: countDroppedThinkingBlocks(message.diagnostics),
    };
}

function readToolResultMessage(
    message: ToolResultEntryMessage,
    editedContent: EditableContent | undefined,
): ViewToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
        content: toToolResultBlocks(editedContent ?? message.content),
        details: message.details,
        nestedCalls: message.nestedCalls,
        isError: message.isError === true,
        timestamp: readFiniteNumber(message.timestamp) ?? 0,
        durationMs: readNonNegativeNumber(message.durationMs),
    };
}

/** Map a cancelled flag and an optional exit code to the state the block shows. */
function readBashStatus(cancelled: boolean, exitCode: number | null): TranscriptBashStatus {
    if (cancelled) {
        return { kind: "cancelled" };
    }
    if (exitCode === null) {
        return { kind: "noExitCode" };
    }
    return exitCode === 0 ? { kind: "succeeded" } : { kind: "failed", exitCode };
}

/** Read one persisted `!` command record; output keeps its text, loses terminal escapes and uses LF. */
function readBashItem(entryId: string, message: BashExecutionRecord): TranscriptBashItem {
    const exitCode = readFiniteNumber(message.exitCode);
    const fullOutputPath = readNonEmptyString(message.fullOutputPath) ?? null;
    return {
        kind: "bash",
        id: `bash-${entryId}`,
        command: typeof message.command === "string" ? message.command : "",
        output: stripAnsi(typeof message.output === "string" ? message.output : ""),
        excludeFromContext: message.excludeFromContext === true,
        status: readBashStatus(message.cancelled === true, exitCode),
        truncation: message.truncated === true ? { kind: "truncated", fullOutputPath } : { kind: "none" },
    };
}

/**
 * Read one displayed extension message.
 *
 * A legacy or hand-edited record can miss `customType` or hold content of an unexpected shape, so
 * every field takes the same boundary checks as a user message and a missing label stays readable.
 */
function readCustomItem(entry: CustomMessageEntry, editedContent: EditableContent | undefined): TranscriptCustomItem {
    const customType = readNonEmptyString(entry.customType) ?? "extension";
    const { text, images } = readUserContent(editedContent ?? entry.content);
    return {
        kind: "custom",
        id: `custom-${entry.id}`,
        customType,
        text,
        images,
    };
}

/** Build the display note shared by a compaction checkpoint and a branch summary. */
function buildNoteItem(entry: SummaryEntry): TranscriptNoteItem {
    return {
        kind: "note",
        id: `note-${entry.id}`,
        title: entry.type === "compaction" ? "Session compacted" : "Branch summary",
        text: entry.summary,
        tokensBefore: entry.type === "compaction" ? readNonNegativeTokenCount(entry.tokensBefore) : undefined,
        billing: readSummaryBilling(entry.usage),
    };
}

function readToolResultContent(content: readonly ToolResultBlock[]): { output: string; images: ImageContent[] } {
    const { texts, images } = splitContentBlocks(content);
    return { output: texts.join("\n"), images };
}

/** Trim a message parsed at the session boundary and use the fallback when it carries no text. */
function messageTextOr(value: string | null, fallback: string): string {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? fallback : trimmed;
}

/** Replace the SDK's generic abort text with the wording the transcript shows. */
function readAbortMessage(errorMessage: string | null): string {
    const text = messageTextOr(errorMessage, "Operation aborted");
    return text === "Request was aborted" ? "Operation aborted" : text;
}

/** Name the failure once, even when the provider's message already starts with an error label. */
function formatErrorOutcomeMessage(errorMessage: string | null): string {
    const text = messageTextOr(errorMessage, "Assistant request failed");
    return /^error:/i.test(text) ? text : `Error: ${text}`;
}

/**
 * One outcome for every stop reason the SDK can record.
 *
 * The mapped type makes a new `StopReason` in the SDK a compile error here instead of a silent
 * fallback to `completed`. `aborted` renames the SDK's generic "Request was aborted" text the same
 * way the terminal UI does, and `error` always names the failure.
 */
const TURN_OUTCOME_BY_STOP_REASON: {
    readonly [Reason in AssistantStopReason]: (errorMessage: string | null) => TranscriptTurnOutcome;
} = {
    pending: () => ({ kind: "open" }),
    toolUse: () => ({ kind: "open" }),
    stop: () => ({ kind: "completed" }),
    length: () => ({ kind: "truncated" }),
    deferred: () => ({ kind: "deferred" }),
    aborted: (errorMessage) => ({ kind: "aborted", message: readAbortMessage(errorMessage) }),
    error: (errorMessage) => ({
        kind: "error",
        message: formatErrorOutcomeMessage(errorMessage),
    }),
};

/**
 * Narrow a reason read from a session file or socket to a reason this build knows.
 *
 * The key set comes from the table itself, so adding a reason to the SDK needs no second list.
 */
function isKnownStopReason(value: unknown): value is AssistantStopReason {
    return typeof value === "string" && Object.hasOwn(TURN_OUTCOME_BY_STOP_REASON, value);
}

function readTurnOutcome(message: ViewAssistantMessage): TranscriptTurnOutcome {
    // A session written by another Pi version can hold a reason this build does not know. The turn
    // still renders without a notice instead of replacing the whole view with an error page, and
    // the mapped table keeps the compile-time signal for reasons the installed SDK declares.
    return message.stopReason === null
        ? { kind: "completed" }
        : TURN_OUTCOME_BY_STOP_REASON[message.stopReason](message.errorMessage);
}

function computeToolDurationMs(
    assistant: ViewAssistantMessage,
    result: ViewToolResultMessage | undefined,
): number | null {
    if (result === undefined) {
        return null;
    }
    if (result.durationMs !== null) {
        return result.durationMs;
    }
    return result.timestamp >= assistant.timestamp ? result.timestamp - assistant.timestamp : null;
}

function buildTurnItem(
    turnMessages: readonly TurnMessage[],
    precedingUserTimestamp: number | null,
    options: BuildTranscriptOptions,
    isTrailingTurn: boolean,
    previousDroppedThinking: number,
): { readonly turn: TranscriptTurnItem | null; readonly nextDroppedThinking: number } {
    const assistants: AssistantTurnMessage[] = [];
    const toolResults = new Map<string, ViewToolResultMessage>();
    for (const turnMessage of turnMessages) {
        if (turnMessage.message.role === "assistant") {
            assistants.push({ message: turnMessage.message, live: turnMessage.live });
        } else {
            toolResults.set(turnMessage.message.toolCallId, turnMessage.message);
        }
    }

    const firstAssistant = assistants[0];
    const lastAssistant = assistants.at(-1);
    if (firstAssistant === undefined || lastAssistant === undefined) {
        return { turn: null, nextDroppedThinking: previousDroppedThinking };
    }

    const lastMessage = lastAssistant.message;
    const lastIsFinalReplyCandidate =
        lastMessage.stopReason !== "toolUse" && !lastMessage.content.some((block) => block.type === "toolCall");
    // Only the trailing turn can still receive a tool result; a historical call without one was
    // interrupted and must not show a spinner that never stops.
    const canStillRun = isTrailingTurn && options.runtimeActive === true;

    const steps: TranscriptStep[] = [];
    const seenToolIds = new Set<string>();
    let finalReply: string | null = null;
    let runningDroppedThinking = previousDroppedThinking;
    let noticedDroppedThinking: number | null = null;

    for (let assistantIndex = 0; assistantIndex < assistants.length; assistantIndex += 1) {
        const turnMessage = assistants[assistantIndex];
        if (turnMessage === undefined) {
            continue;
        }
        const assistant = turnMessage.message;
        const isTerminalFailure = assistant.stopReason === "aborted" || assistant.stopReason === "error";
        if (!isTerminalFailure && assistant.droppedThinkingBlocks > runningDroppedThinking) {
            noticedDroppedThinking = assistant.droppedThinkingBlocks;
        }
        runningDroppedThinking = assistant.droppedThinkingBlocks;
        const isLastAssistant = assistantIndex === assistants.length - 1;
        const extractFinalText = isLastAssistant && lastIsFinalReplyCandidate;
        // A live message only animates while the runtime can still append to it; a persisted
        // pending message has no live flag but is still mid-turn.
        const isStreamingAssistant = turnMessage.live
            ? options.runtimeActive === true && assistant.stopReason === "pending"
            : assistant.stopReason === "pending";
        const finalTextParts: string[] = [];

        for (let blockIndex = 0; blockIndex < assistant.content.length; blockIndex += 1) {
            const block = assistant.content[blockIndex];
            if (block === undefined) {
                continue;
            }
            const isTrailingBlock = isStreamingAssistant && blockIndex === assistant.content.length - 1;
            // The timestamp and indices survive the live-to-persisted handover, so ids stay stable
            // and an expanded step keeps its state while the entry lands.
            const stepPrefix = `${assistant.timestamp}-${assistantIndex}-${blockIndex}`;

            if (block.type === "thinking") {
                if (block.thinking.trim() === "" && !block.redacted && !isTrailingBlock) {
                    continue;
                }
                steps.push({
                    kind: "thinking",
                    id: `${stepPrefix}-thinking`,
                    thinking: block.thinking,
                    redacted: block.redacted,
                    streaming: isTrailingBlock,
                });
            } else if (block.type === "text") {
                if (extractFinalText) {
                    if (block.text.trim() !== "") {
                        finalTextParts.push(block.text.trim());
                    }
                } else if (block.text.trim() !== "" || isTrailingBlock) {
                    steps.push({
                        kind: "reply",
                        id: `${stepPrefix}-reply`,
                        text: block.text.trim(),
                        streaming: isTrailingBlock,
                    });
                }
            } else {
                const persistedResult = toolResults.get(block.id);
                const liveExecution =
                    persistedResult === undefined && canStillRun && isLastAssistant && block.id !== ""
                        ? options.liveToolExecutions?.[block.id]
                        : undefined;
                const effectiveArgs =
                    Object.keys(block.arguments).length === 0 &&
                    liveExecution !== undefined &&
                    Object.keys(liveExecution.args).length > 0
                        ? liveExecution.args
                        : block.arguments;
                const meta = describeToolCall(block.name, effectiveArgs);

                const activeResult =
                    persistedResult ??
                    (liveExecution?.kind === "running"
                        ? liveExecution.partialResult
                        : liveExecution?.kind === "settled"
                          ? liveExecution.result
                          : null);

                const { output, images } = readToolResultContent(activeResult?.content ?? []);

                let status: TranscriptToolStatus;
                let timing: TranscriptTiming;
                if (persistedResult !== undefined) {
                    status = persistedResult.isError ? "error" : "done";
                    timing = { kind: "static", durationMs: computeToolDurationMs(assistant, persistedResult) };
                } else if (liveExecution?.kind === "settled") {
                    status = liveExecution.isError ? "error" : "done";
                    timing = { kind: "static", durationMs: liveExecution.durationMs };
                } else if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
                    status = "error";
                    timing = { kind: "static", durationMs: null };
                } else if (canStillRun && isLastAssistant) {
                    status = "running";
                    timing = { kind: "since", startedAtMs: assistant.timestamp };
                } else {
                    status = "error";
                    timing = { kind: "static", durationMs: null };
                }

                let stepId = block.id !== "" ? block.id : `${stepPrefix}-tool`;
                if (seenToolIds.has(stepId)) {
                    stepId = `${stepId}-${stepPrefix}`;
                }
                seenToolIds.add(stepId);

                const presentation = buildToolPresentation({
                    toolKind: meta.toolKind,
                    args: effectiveArgs,
                    argumentsError: block.argumentsError,
                    status,
                    output,
                    hasImages: images.length > 0,
                    details: activeResult?.details,
                    nestedCalls: persistedResult?.nestedCalls,
                });

                steps.push({
                    kind: "toolCall",
                    id: stepId,
                    toolName: block.name,
                    ...meta,
                    arguments: effectiveArgs,
                    argumentsError: block.argumentsError,
                    status,
                    output: presentation.output,
                    images,
                    preview: presentation.preview,
                    warnings: presentation.warnings,
                    nestedCalls: presentation.nestedCalls,
                    timing,
                });
            }
        }

        if (extractFinalText && finalTextParts.length > 0) {
            finalReply = finalTextParts.join("\n\n");
        }
    }

    const awaitingNextRound =
        isTrailingTurn &&
        options.runtimeActive === true &&
        (lastMessage.stopReason === "toolUse" || lastMessage.stopReason === "pending");
    const streaming =
        (lastAssistant.live && options.runtimeActive === true) || awaitingNextRound || steps.some(isRunningToolStep);

    const startMs = precedingUserTimestamp ?? firstAssistant.message.timestamp;
    let settledDurationMs: number | null = null;
    if (!streaming) {
        let endMs = firstAssistant.message.timestamp;
        for (const turnMessage of turnMessages) {
            if (turnMessage.message.role === "assistant") {
                const candidate = turnMessage.message.timestamp + (turnMessage.message.durationMs ?? 0);
                if (candidate > endMs) {
                    endMs = candidate;
                }
            } else if (turnMessage.message.timestamp > endMs) {
                endMs = turnMessage.message.timestamp;
            }
        }
        if (endMs >= startMs) {
            settledDurationMs = endMs - startMs;
        }
    }

    const diagnosticsNotice =
        noticedDroppedThinking !== null ? formatThinkingDropNotice(noticedDroppedThinking) : undefined;

    return {
        turn: {
            kind: "turn",
            id: `turn-${firstAssistant.message.timestamp}`,
            steps,
            finalReply,
            outcome: readTurnOutcome(lastMessage),
            timing: streaming
                ? { kind: "since", startedAtMs: startMs }
                : { kind: "static", durationMs: settledDurationMs },
            streaming,
            diagnosticsNotice,
        },
        nextDroppedThinking: runningDroppedThinking,
    };
}

function isRunningToolStep(step: TranscriptStep): boolean {
    return step.kind === "toolCall" && step.status === "running";
}

/**
 * Aggregate projected transcript items into user bubbles, system notes and `Worked for Xs` groups.
 *
 * Every assistant round and tool result between two user prompts shares one turn group, with the
 * final text-only assistant reply placed outside the group below `steps`. A compaction or branch
 * summary ends the running turn because it marks a context boundary the reader must see.
 */
export function buildTranscript(
    items: readonly ProjectedTranscriptItem[],
    options: BuildTranscriptOptions = {},
): TranscriptItem[] {
    const transcript: TranscriptItem[] = [];
    const usedTurnIds = new Set<string>();
    let pendingTurn: TurnMessage[] = [];
    let lastUserTimestamp: number | null = null;
    let liveMessageDuplicated = false;
    let lastDroppedThinking = 0;
    let deferredCacheWarms: {
        readonly id: string;
        readonly note: string | undefined;
        readonly cost: number;
    }[] = [];
    let lastCacheWarmNotice: {
        readonly transcriptIndex: number;
        readonly note: string | undefined;
        totalCost: number;
    } | null = null;

    const pushCacheWarmNotice = (entryId: string, note: string | undefined, cost: number): void => {
        // Collapse adjacent cache-warm refreshes with the same qualifier into one cumulative line.
        if (
            lastCacheWarmNotice !== null &&
            transcript.length - 1 === lastCacheWarmNotice.transcriptIndex &&
            lastCacheWarmNotice.note === note
        ) {
            lastCacheWarmNotice.totalCost += cost;
            const previous = transcript[lastCacheWarmNotice.transcriptIndex];
            if (previous?.kind === "notice") {
                transcript[lastCacheWarmNotice.transcriptIndex] = {
                    ...previous,
                    text: formatCacheWarmingText(lastCacheWarmNotice.totalCost, note),
                };
            }
            return;
        }
        const noticeItem: TranscriptNoticeItem = {
            kind: "notice",
            id: `notice-${entryId}`,
            text: formatCacheWarmingText(cost, note),
        };
        lastCacheWarmNotice = {
            transcriptIndex: transcript.length,
            note,
            totalCost: cost,
        };
        transcript.push(noticeItem);
    };

    const flushTurn = (isTrailingTurn: boolean): void => {
        const warmsToFlush = deferredCacheWarms;
        deferredCacheWarms = [];
        if (pendingTurn.length > 0) {
            const { turn, nextDroppedThinking } = buildTurnItem(
                pendingTurn,
                lastUserTimestamp,
                options,
                isTrailingTurn,
                lastDroppedThinking,
            );
            pendingTurn = [];
            lastDroppedThinking = nextDroppedThinking;
            // A note or compaction ends the previous cycle; the next turn must not inherit its prompt
            // time when no new user message precedes it.
            lastUserTimestamp = null;
            if (turn !== null) {
                // A turn id must stay unique across the list; the live-to-persisted handover keeps the same
                // timestamp, so the same suffix is chosen in both phases.
                let id = turn.id;
                let suffix = 1;
                while (usedTurnIds.has(id)) {
                    id = `${turn.id}-${suffix}`;
                    suffix += 1;
                }
                usedTurnIds.add(id);
                transcript.push(id === turn.id ? turn : { ...turn, id });
            }
        }
        for (const warm of warmsToFlush) {
            pushCacheWarmNotice(warm.id, warm.note, warm.cost);
        }
    };

    for (const item of items) {
        if (item.kind === "compaction") {
            flushTurn(false);
            transcript.push(buildNoteItem(item.entry));
            continue;
        }

        const entry = item.entry;
        switch (entry.type) {
            case "message": {
                const message = entry.message;
                switch (message.role) {
                    case "user": {
                        flushTurn(false);
                        const timestamp = readFiniteNumber(message.timestamp) ?? 0;
                        const { text, images } = readUserContent(item.editedContent ?? message.content);
                        const skillBlock = parseSkillBlock(text);
                        if (skillBlock === null) {
                            transcript.push({
                                kind: "user",
                                id: `user-${entry.id}`,
                                text,
                                images,
                            });
                        } else {
                            // The terminal client shows the expanded skill block first and the typed
                            // prompt after it, so one persisted entry can become two rows.
                            transcript.push({
                                kind: "skill",
                                id: `skill-${entry.id}`,
                                name: skillBlock.name,
                                location: skillBlock.location,
                                content: skillBlock.content,
                            });
                            const userText = skillBlock.userMessage ?? "";
                            if (userText !== "" || images.length > 0) {
                                transcript.push({
                                    kind: "user",
                                    id: `user-${entry.id}`,
                                    text: userText,
                                    images,
                                });
                            }
                        }
                        // A prompt starts the next turn's clock. An unreadable timestamp parses to 0
                        // and must not become a start, or the turn would count from the epoch.
                        lastUserTimestamp = timestamp > 0 ? timestamp : null;
                        break;
                    }
                    case "assistant": {
                        if (options.liveMessage?.timestamp === message.timestamp) {
                            liveMessageDuplicated = true;
                        }
                        pendingTurn.push({ message: readAssistantMessage(message, item.editedContent), live: false });
                        break;
                    }
                    case "toolResult": {
                        pendingTurn.push({ message: readToolResultMessage(message, item.editedContent), live: false });
                        break;
                    }
                    case "bashExecution": {
                        // The command ran between turns, so it ends the pending one and starts no
                        // new prompt: its timestamp must not seed the next turn's duration.
                        flushTurn(false);
                        transcript.push(readBashItem(entry.id, message));
                        break;
                    }
                    case "system":
                    case "custom":
                    case "branchSummary":
                    case "compactionSummary":
                        // Prompt scaffolding and LLM-context-only messages never render as conversation.
                        break;
                    default:
                        ignoreUnknownVariant(message);
                        break;
                }
                break;
            }
            case "custom_message": {
                if (!entry.display) {
                    break;
                }
                flushTurn(false);
                const timestamp = parseIsoTimestamp(entry.timestamp);
                transcript.push(readCustomItem(entry, item.editedContent));
                // A displayed extension message can start the next turn, so its time seeds that
                // turn's duration the way a prompt does. An unreadable timestamp parses to 0 and
                // must not become a start, or the next turn would count from the epoch.
                lastUserTimestamp = timestamp > 0 ? timestamp : null;
                break;
            }
            case "branch_summary": {
                flushTurn(false);
                transcript.push(buildNoteItem(entry));
                break;
            }
            case "usage": {
                if (entry.kind !== "cache_warm") {
                    break;
                }
                const cost = readUsageTotalCostUsd(entry.usage);
                if (cost === null) {
                    break;
                }
                const note = normalizeUsageNote(entry.note);
                // CacheWarmer can refresh during a long tool turn; deferring until flushTurn avoids
                // splitting an open toolUse round from its incoming toolResult.
                if (pendingTurn.length > 0) {
                    deferredCacheWarms.push({ id: entry.id, note, cost });
                } else {
                    pushCacheWarmNotice(entry.id, note, cost);
                }
                break;
            }
            case "compaction":
                // Only the newest compaction shapes the view. Older ones inside a kept range stay
                // model-context metadata and would repeat a summary the reader already saw.
                break;
            case "thinking_level_change":
            case "model_change":
            case "custom":
            case "context_edit":
            case "label":
            case "session_info":
                // Model, thinking-level and bookmark metadata never render as conversation.
                break;
            default:
                ignoreUnknownVariant(entry);
                break;
        }
    }

    const live = options.liveMessage ?? null;
    if (live !== null && !liveMessageDuplicated) {
        pendingTurn.push({
            message: readAssistantMessage(live, undefined),
            live: true,
        });
    }
    flushTurn(true);

    return transcript;
}
