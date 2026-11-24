import type {
    BashToolDetails,
    EditToolDetails,
    FindToolDetails,
    GrepToolDetails,
    LsToolDetails,
    ReadToolDetails,
    ToolCallEvent,
    TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { assertNever, isFiniteNumber, isRecord } from "@pivia/protocol";

import { resolveLanguage } from "@/components/CodeBlock/highlight";

const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_LINES = 2000;
const READ_CONTINUATION_FOOTER =
    /\n\n\[(Showing lines \d+-\d+ of \d+[^\]]*|\d+ more lines in file\. Use offset=\d+ to continue\.)\]$/;

type LiteralToolName<TEvent> = TEvent extends { readonly toolName: infer TName extends string }
    ? string extends TName
        ? never
        : TName
    : never;

/** Core tool names derived from the SDK {@link ToolCallEvent} union. */
export type SdkBuiltinToolName = LiteralToolName<ToolCallEvent>;

/**
 * The Pi built-in tools that receive dedicated icons and argument summaries in the transcript.
 *
 * Every extension or MCP tool falls back to `generic`, so a custom ecosystem never splinters into
 * inconsistent row layouts.
 */
export type TranscriptToolKind = SdkBuiltinToolName | "codemode" | "tool_search" | "generic";

/**
 * Tool arguments as they reached the view.
 *
 * Session parsing only checks the message envelope, so the values stay unknown and every reader
 * narrows them again. A caller must not assume any key exists.
 */
export type TranscriptToolArguments = Readonly<Record<string, unknown>>;

/** Terminal outcome of a single tool step, aligned with `TranscriptToolCallStep["status"]`. */
export type TranscriptToolStatus = "running" | "done" | "error";

/**
 * Rich visual preview extracted for a tool invocation card.
 *
 * Invariants:
 * - `diff` is only produced when `diff.length > 0` and the tool did not fail.
 * - `code` is only produced when `code.length > 0`; `startLine` is a positive 1-based line number.
 */
export type TranscriptToolPreview =
    | { readonly kind: "none" }
    | {
          readonly kind: "diff";
          /** Standard unified patch (preferred) or legacy display diff when `patch` is absent. */
          readonly diff: EditToolDetails["patch"];
      }
    | {
          readonly kind: "code";
          readonly code: string;
          readonly language: string | undefined;
          readonly startLine: number;
      };

/**
 * Actionable truncation or limit notice attached to a tool result.
 *
 * Separating `fullOutput` from plain `notice` lines lets the UI render the path in monospace code
 * without string-splitting rendered notices.
 */
export type TranscriptToolWarning =
    | { readonly kind: "notice"; readonly message: string }
    | { readonly kind: "fullOutput"; readonly path: NonNullable<BashToolDetails["fullOutputPath"]> };

/** Combined rich preview and warning metadata for one tool call step. */
export interface TranscriptToolPresentation {
    readonly preview: TranscriptToolPreview;
    readonly warnings: readonly TranscriptToolWarning[];
}

/** Input needed to derive a tool call's rich preview and truncation notices. */
export interface BuildToolPresentationInput {
    readonly toolKind: TranscriptToolKind;
    readonly args: TranscriptToolArguments;
    readonly argumentsError: string | null;
    readonly status: TranscriptToolStatus;
    readonly output: string;
    readonly hasImages: boolean;
    readonly details: unknown;
}

const EXTENSION_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
    mjs: "javascript",
    cjs: "javascript",
    htm: "html",
    h: "c",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    gradle: "groovy",
    zsh: "bash",
};

const BASENAME_LANGUAGES: Readonly<Record<string, string>> = {
    dockerfile: "dockerfile",
    makefile: "makefile",
    gnumakefile: "makefile",
};

function parsePositiveInteger(value: unknown): number | undefined {
    const num =
        typeof value === "string" && value.trim() !== "" ? Number(value) : isFiniteNumber(value) ? value : undefined;
    return num !== undefined && Number.isInteger(num) && num >= 1 ? num : undefined;
}

/** Returns `value` when it is a finite positive number, or `undefined` otherwise. */
export function readOptionalPositiveNumber(value: unknown): number | undefined {
    return isFiniteNumber(value) && value > 0 ? value : undefined;
}

function readOptionalNonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

/** Read the target path from `path` or legacy `file_path` arguments, falling back if `path` is blank. */
export function readToolFilePath(args: TranscriptToolArguments): string | null {
    for (const key of ["path", "file_path"] as const) {
        const raw = args[key];
        if (typeof raw === "string") {
            const trimmed = raw.trim();
            if (trimmed !== "") {
                return trimmed;
            }
        }
    }
    return null;
}

/** Formats a byte count using the same IEC units as `pi-coding-agent` (`B`, `KB`, `MB`). */
export function formatByteSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "0B";
    }
    if (bytes < 1024) {
        return `${bytes}B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)}KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Formats optional positive integer `offset` / `limit` arguments for a `read` tool summary
 * (`:10`, `:10-59`), returning an empty string for absent or invalid inputs.
 */
export function formatReadLineRangeSummary(offset: unknown, limit: unknown): string {
    if (offset == null && limit == null) {
        return "";
    }
    const start = offset == null ? 1 : parsePositiveInteger(offset);
    if (start === undefined) {
        return "";
    }
    if (limit == null) {
        return `:${start}`;
    }
    const count = parsePositiveInteger(limit);
    if (count === undefined) {
        return "";
    }
    const end = start + count - 1;
    return `:${start}-${end}`;
}

/**
 * Resolves a Shiki-compatible language id from a file path extension or basename, or `undefined`
 * when no highlighting grammar applies.
 */
export function inferLanguageFromPath(filePath: string): string | undefined {
    const trimmed = filePath.trim();
    if (trimmed === "") {
        return undefined;
    }
    const slashIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    const basename = slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
    const byBasename = BASENAME_LANGUAGES[basename.toLowerCase()];
    if (byBasename !== undefined) {
        return resolveLanguage(byBasename)?.id;
    }
    const dotIndex = basename.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex === basename.length - 1) {
        return undefined;
    }
    const ext = basename.slice(dotIndex + 1).toLowerCase();
    const candidate = EXTENSION_LANGUAGE_ALIASES[ext] ?? ext;
    return resolveLanguage(candidate)?.id;
}

/** Boundary parser for an SDK {@link TruncationResult} object; returns `null` if malformed. */
export function parseTruncationResult(raw: unknown): TruncationResult | null {
    if (!isRecord(raw) || typeof raw.truncated !== "boolean") {
        return null;
    }
    const truncatedBy = raw.truncatedBy;
    if (truncatedBy !== "lines" && truncatedBy !== "bytes" && truncatedBy !== null) {
        return null;
    }
    if (
        typeof raw.content !== "string" ||
        !isFiniteNumber(raw.totalLines) ||
        !isFiniteNumber(raw.totalBytes) ||
        !isFiniteNumber(raw.outputLines) ||
        !isFiniteNumber(raw.outputBytes) ||
        typeof raw.lastLinePartial !== "boolean" ||
        typeof raw.firstLineExceedsLimit !== "boolean" ||
        !isFiniteNumber(raw.maxLines) ||
        !isFiniteNumber(raw.maxBytes)
    ) {
        return null;
    }
    return {
        content: raw.content,
        truncated: raw.truncated,
        truncatedBy,
        totalLines: raw.totalLines,
        totalBytes: raw.totalBytes,
        outputLines: raw.outputLines,
        outputBytes: raw.outputBytes,
        lastLinePartial: raw.lastLinePartial,
        firstLineExceedsLimit: raw.firstLineExceedsLimit,
        maxLines: raw.maxLines,
        maxBytes: raw.maxBytes,
    };
}

/**
 * Boundary parser for {@link EditToolDetails}; returns `null` when neither `patch` nor `diff` is a
 * non-empty string.
 */
export function parseEditToolDetails(
    raw: unknown,
): Pick<EditToolDetails, "patch" | "diff" | "firstChangedLine"> | null {
    if (!isRecord(raw)) {
        return null;
    }
    const patch = readOptionalNonEmptyString(raw.patch) ?? "";
    const diff = readOptionalNonEmptyString(raw.diff) ?? "";
    if (patch === "" && diff === "") {
        return null;
    }
    return {
        patch,
        diff,
        ...(isFiniteNumber(raw.firstChangedLine) ? { firstChangedLine: raw.firstChangedLine } : {}),
    };
}

/** Boundary parser for {@link BashToolDetails}. */
export function parseShellToolDetails(raw: unknown): BashToolDetails | null {
    if (!isRecord(raw)) {
        return null;
    }
    const truncation = parseTruncationResult(raw.truncation);
    const fullOutputPath = readOptionalNonEmptyString(raw.fullOutputPath);
    if (truncation === null && fullOutputPath === undefined) {
        return null;
    }
    return {
        ...(truncation === null ? {} : { truncation }),
        ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
    };
}

/** Boundary parser for {@link ReadToolDetails}. */
export function parseReadToolDetails(raw: unknown): ReadToolDetails | null {
    if (!isRecord(raw)) {
        return null;
    }
    const truncation = parseTruncationResult(raw.truncation);
    return truncation === null ? null : { truncation };
}

/** Boundary parser for {@link GrepToolDetails}. */
export function parseGrepToolDetails(raw: unknown): GrepToolDetails | null {
    if (!isRecord(raw)) {
        return null;
    }
    const truncation = parseTruncationResult(raw.truncation);
    const matchLimitReached = readOptionalPositiveNumber(raw.matchLimitReached);
    const linesTruncated = raw.linesTruncated === true ? true : undefined;
    if (truncation === null && matchLimitReached === undefined && linesTruncated === undefined) {
        return null;
    }
    return {
        ...(truncation === null ? {} : { truncation }),
        ...(matchLimitReached === undefined ? {} : { matchLimitReached }),
        ...(linesTruncated === undefined ? {} : { linesTruncated }),
    };
}

function parseSingleLimitDetails<TKey extends "resultLimitReached" | "entryLimitReached">(
    raw: unknown,
    limitKey: TKey,
): ({ truncation?: TruncationResult } & { [K in TKey]?: number }) | null {
    if (!isRecord(raw)) {
        return null;
    }
    const truncation = parseTruncationResult(raw.truncation);
    const limit = readOptionalPositiveNumber(raw[limitKey]);
    if (truncation === null && limit === undefined) {
        return null;
    }
    return {
        ...(truncation === null ? {} : { truncation }),
        ...(limit === undefined ? {} : { [limitKey]: limit }),
    } as { truncation?: TruncationResult } & { [K in TKey]?: number };
}

/** Boundary parser for {@link FindToolDetails}. */
export function parseFindToolDetails(raw: unknown): FindToolDetails | null {
    return parseSingleLimitDetails(raw, "resultLimitReached");
}

/** Boundary parser for {@link LsToolDetails}. */
export function parseLsToolDetails(raw: unknown): LsToolDetails | null {
    return parseSingleLimitDetails(raw, "entryLimitReached");
}

function formatTruncationNotice(truncation: TruncationResult, includeMaxLinesLimit: boolean): TranscriptToolWarning {
    if (truncation.firstLineExceedsLimit) {
        return {
            kind: "notice",
            message: `First line exceeds ${formatByteSize(truncation.maxBytes || DEFAULT_MAX_BYTES)} limit`,
        };
    }
    if (truncation.truncatedBy === "lines") {
        const suffix = includeMaxLinesLimit ? ` (${truncation.maxLines || DEFAULT_MAX_LINES} line limit)` : "";
        return {
            kind: "notice",
            message: `Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines${suffix}`,
        };
    }
    return {
        kind: "notice",
        message: `Truncated: ${truncation.outputLines} lines shown (${formatByteSize(truncation.maxBytes || DEFAULT_MAX_BYTES)} limit)`,
    };
}

function buildShellWarnings(details: BashToolDetails | null): TranscriptToolWarning[] {
    if (details === null) {
        return [];
    }
    const warnings: TranscriptToolWarning[] = [];
    if (details.fullOutputPath !== undefined) {
        warnings.push({ kind: "fullOutput", path: details.fullOutputPath });
    }
    if (details.truncation?.truncated === true) {
        warnings.push(formatTruncationNotice(details.truncation, false));
    }
    return warnings;
}

function buildLimitTruncationWarnings(
    limitMessage: string | null,
    truncation: TruncationResult | undefined,
    extraNote?: string,
): TranscriptToolWarning[] {
    const parts: string[] = [];
    if (limitMessage !== null) {
        parts.push(limitMessage);
    }
    if (truncation?.truncated === true) {
        parts.push(`${formatByteSize(truncation.maxBytes || DEFAULT_MAX_BYTES)} limit`);
    }
    if (extraNote !== undefined) {
        parts.push(extraNote);
    }
    return parts.length === 0 ? [] : [{ kind: "notice", message: `Truncated: ${parts.join(", ")}` }];
}

function buildCodePreview(args: TranscriptToolArguments, code: string, startLine: number): TranscriptToolPreview {
    if (code === "") {
        return { kind: "none" };
    }
    const filePath = readToolFilePath(args);
    return {
        kind: "code",
        code,
        language: filePath === null ? undefined : inferLanguageFromPath(filePath),
        startLine,
    };
}

function buildWritePreview(input: BuildToolPresentationInput): TranscriptToolPreview {
    if (input.status === "error" || input.argumentsError !== null || typeof input.args.content !== "string") {
        return { kind: "none" };
    }
    // Trim a single trailing newline emitted at EOF so CodeBlock does not add a blank line.
    const normalized = input.args.content.replace(/\r\n/g, "\n").replace(/\n$/, "");
    return buildCodePreview(input.args, normalized, 1);
}

function buildReadPresentation(input: BuildToolPresentationInput): TranscriptToolPresentation {
    const readDetails = parseReadToolDetails(input.details);
    const truncation = readDetails?.truncation;
    const warnings = truncation?.truncated === true ? [formatTruncationNotice(truncation, true)] : [];

    // When the first line exceeds the byte limit, `output` is a bracketed diagnostic, not file code.
    if (
        input.status === "error" ||
        input.hasImages ||
        input.output === "" ||
        truncation?.firstLineExceedsLimit === true
    ) {
        return { preview: { kind: "none" }, warnings };
    }

    const match = READ_CONTINUATION_FOOTER.exec(input.output);
    const code = match === null ? input.output : input.output.slice(0, match.index);
    if (match !== null && match[1] !== undefined && warnings.length === 0) {
        warnings.push({ kind: "notice", message: match[1] });
    }

    return {
        preview: buildCodePreview(input.args, code, parsePositiveInteger(input.args.offset) ?? 1),
        warnings,
    };
}

/**
 * Builds the rich preview (`diff` or highlighted `code`) and truncation/limit warnings for one
 * tool call step from its arguments, output, and SDK `details` payload.
 */
export function buildToolPresentation(input: BuildToolPresentationInput): TranscriptToolPresentation {
    switch (input.toolKind) {
        case "edit": {
            const editDetails = input.status === "error" ? null : parseEditToolDetails(input.details);
            // Prefer the standard unified `patch` for CodeBlock's diff parser; fall back to `diff`
            // only when reading legacy records without `patch`.
            const diffText =
                editDetails === null ? "" : editDetails.patch !== "" ? editDetails.patch : editDetails.diff;
            return {
                preview: diffText === "" ? { kind: "none" } : { kind: "diff", diff: diffText },
                warnings: [],
            };
        }
        case "write":
            return {
                preview: buildWritePreview(input),
                warnings: [],
            };
        case "read":
            return buildReadPresentation(input);
        case "bash":
        case "powershell":
            return {
                preview: { kind: "none" },
                warnings: buildShellWarnings(parseShellToolDetails(input.details)),
            };
        case "grep": {
            const grepDetails = parseGrepToolDetails(input.details);
            return {
                preview: { kind: "none" },
                warnings:
                    grepDetails === null
                        ? []
                        : buildLimitTruncationWarnings(
                              grepDetails.matchLimitReached !== undefined
                                  ? `${grepDetails.matchLimitReached} matches limit`
                                  : null,
                              grepDetails.truncation,
                              grepDetails.linesTruncated ? "some lines truncated" : undefined,
                          ),
            };
        }
        case "find": {
            const findDetails = parseFindToolDetails(input.details);
            return {
                preview: { kind: "none" },
                warnings:
                    findDetails === null
                        ? []
                        : buildLimitTruncationWarnings(
                              findDetails.resultLimitReached !== undefined
                                  ? `${findDetails.resultLimitReached} results limit`
                                  : null,
                              findDetails.truncation,
                          ),
            };
        }
        case "ls": {
            const lsDetails = parseLsToolDetails(input.details);
            return {
                preview: { kind: "none" },
                warnings:
                    lsDetails === null
                        ? []
                        : buildLimitTruncationWarnings(
                              lsDetails.entryLimitReached !== undefined
                                  ? `${lsDetails.entryLimitReached} entries limit`
                                  : null,
                              lsDetails.truncation,
                          ),
            };
        }
        case "codemode":
        case "tool_search":
        case "generic":
            return {
                preview: { kind: "none" },
                warnings: buildShellWarnings(parseShellToolDetails(input.details)),
            };
        default:
            return assertNever(input.toolKind);
    }
}
