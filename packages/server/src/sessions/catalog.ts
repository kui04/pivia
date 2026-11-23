import { createReadStream, readFileSync, type Stats } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
    CURRENT_SESSION_VERSION,
    getAgentDir,
    migrateSessionEntries,
    parseSessionEntries,
    SettingsManager,
    type FileEntry,
} from "@earendil-works/pi-coding-agent";

import {
    assertNever,
    isFileEntryRecord,
    isRecord,
    parseEntriesVersion,
    parseSessionId,
    type CatalogSnapshot,
    type EntriesVersion,
    type SessionDetailResponse,
    type SessionId,
    type SessionPrefixAnchor,
    type SessionSummary,
} from "@pivia/protocol";

import { createLogger } from "../logger.ts";

/** Largest session file the detail endpoint reads into memory. */
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

/** Maximum project subdirectories scanned concurrently so large session roots stay within file-descriptor limits. */
const PROJECT_DISCOVERY_CONCURRENCY = 4;

/** Options for {@link resolveSessionRoot}. */
export interface SessionRootOptions {
    /** Explicit `--session-dir` value; takes priority over the environment and settings. */
    readonly sessionDir?: string | undefined;
    /** Environment lookup for `PI_CODING_AGENT_SESSION_DIR`; defaults to `process.env`. */
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
    /** Agent configuration directory (`getAgentDir()`), which holds `settings.json` and `sessions/`. */
    readonly agentDir?: string | undefined;
    /** Working directory for relative paths and project settings; defaults to `process.cwd()`. */
    readonly cwd?: string | undefined;
}

/** Resolved session root directory. */
export interface SessionRoot {
    /** Absolute root directory. */
    readonly dir: string;
    /**
     * True when `dir` uses the flat `<dir>/*.jsonl` layout, which applies to `--session-dir`, the
     * environment variable, and pi settings. False for the default
     * `<agentDir>/sessions/<encoded-cwd>/*.jsonl` layout.
     */
    readonly isCustom: boolean;
}

/** Structured logger contract used by {@link SessionCatalog}. */
export interface SessionCatalogLogger {
    warn(record: Record<string, unknown>, message: string): void;
}

/** Options for constructing {@link SessionCatalog}. */
export interface SessionCatalogOptions extends SessionRootOptions {
    /** Logger for discovery warnings; defaults to a `stderr` server logger. */
    readonly logger?: SessionCatalogLogger | undefined;
    /** Clock used for `updatedAtMs`; defaults to `Date.now`. */
    readonly nowMs?: (() => number) | undefined;
    /** Largest session file allowed for detail reads or opening; defaults to 64 MiB. */
    readonly maxSessionFileBytes?: number | undefined;
}

interface DiscoveredSession {
    readonly summary: SessionSummary;
    readonly path: string;
}

interface ResolvedDiscoveryRoot extends SessionRoot {
    /** `dir` with symbolic links resolved; used as the containment boundary. */
    readonly realDir: string;
}

interface DiscoveryResult {
    readonly root: ResolvedDiscoveryRoot;
    readonly sessions: readonly DiscoveredSession[];
}

type ContainedFileResult =
    | { readonly kind: "ok"; readonly realPath: string; readonly stats: Stats }
    | { readonly kind: "outside_root" }
    | { readonly kind: "oversized"; readonly realPath: string; readonly stats: Stats }
    | { readonly kind: "non_file"; readonly realPath: string }
    | { readonly kind: "io_error"; readonly error: unknown };

interface CachedFileSummary {
    readonly mtimeMs: number;
    readonly size: number;
    readonly summary: SessionSummary;
}

/** Result of resolving one session file for opening. */
export interface ResolvedSession {
    readonly summary: SessionSummary;
    /** Canonical file path that passed the session root containment check. */
    readonly realPath: string;
    /** File size in bytes from the verification `stat`, used to short-circuit WS inline checks. */
    readonly sizeBytes: number;
    /** Configured session root; `realDir` is the canonical containment boundary. */
    readonly root: SessionRoot & { readonly realDir: string };
}

/** Explicit resolution outcome separating missing files from persisted files above the read limit. */
export type SessionResolution =
    | { readonly kind: "found"; readonly session: ResolvedSession }
    | { readonly kind: "oversized"; readonly realPath: string; readonly sizeBytes: number }
    | { readonly kind: "missing" };

/** Slice result produced by {@link sliceEntriesForAnchor}. */
export interface SlicedEntries {
    readonly baseEntryCount: number;
    readonly entries: readonly FileEntry[];
    readonly prefixMatched: boolean;
}

let cachedEntriesVersion: EntriesVersion | undefined;

/** Resolve the composite `${CURRENT_SESSION_VERSION}:${piSdkVersion}` cache version once at startup. */
export function resolveEntriesVersion(): EntriesVersion {
    if (cachedEntriesVersion !== undefined) {
        return cachedEntriesVersion;
    }
    const entryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    let currentDir = dirname(entryPath);
    for (;;) {
        const candidate = join(currentDir, "package.json");
        try {
            const raw = readFileSync(candidate, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (
                isRecord(parsed) &&
                parsed.name === "@earendil-works/pi-coding-agent" &&
                typeof parsed.version === "string"
            ) {
                const version = parseEntriesVersion(`${CURRENT_SESSION_VERSION}:${parsed.version}`);
                if (version !== null) {
                    cachedEntriesVersion = version;
                    return cachedEntriesVersion;
                }
            }
        } catch {
            // Walk up until the package root is found.
        }
        const parent = dirname(currentDir);
        if (parent === currentDir) {
            break;
        }
        currentDir = parent;
    }
    const fallback = parseEntriesVersion(`${CURRENT_SESSION_VERSION}:unknown`);
    if (fallback === null) {
        throw new Error("Invalid fallback entries version.");
    }
    cachedEntriesVersion = fallback;
    return cachedEntriesVersion;
}

/**
 * Verify a client's prefix anchor against `[header, ...entries]` in O(1) and return the trailing slice.
 */
export function sliceEntriesForAnchor(
    sessionId: SessionId,
    entries: readonly FileEntry[],
    serverEntriesVersion: EntriesVersion | null,
    anchor: SessionPrefixAnchor | undefined,
): SlicedEntries {
    if (
        serverEntriesVersion === null ||
        anchor === undefined ||
        anchor.entriesVersion !== serverEntriesVersion ||
        !Number.isSafeInteger(anchor.afterCount) ||
        anchor.afterCount < 1 ||
        entries.length < anchor.afterCount
    ) {
        return { baseEntryCount: 0, entries, prefixMatched: false };
    }
    const header = entries[0];
    if (header === undefined || header.type !== "session" || header.id !== sessionId) {
        return { baseEntryCount: 0, entries, prefixMatched: false };
    }
    const anchorEntry = entries[anchor.afterCount - 1];
    if (anchorEntry === undefined || anchorEntry.id !== anchor.afterEntryId) {
        return { baseEntryCount: 0, entries, prefixMatched: false };
    }
    return {
        baseEntryCount: anchor.afterCount,
        entries: entries.slice(anchor.afterCount),
        prefixMatched: true,
    };
}

function extractMessageText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    const parts: string[] = [];
    for (const block of content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
            parts.push(block.text);
        }
    }
    return parts.join(" ");
}

function messageActivityTimestampMs(
    entry: Record<string, unknown>,
    message: Record<string, unknown>,
): number | undefined {
    const role = message.role;
    if (role !== "user" && role !== "assistant") {
        return undefined;
    }
    if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
        return message.timestamp;
    }
    if (typeof entry.timestamp === "string") {
        const parsed = Date.parse(entry.timestamp);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

/** Outcome of summarizing a single session `.jsonl` file from its header and messages. */
export type SessionFileSummaryResult =
    | { readonly kind: "ok"; readonly summary: SessionSummary }
    | { readonly kind: "invalid-id" }
    | { readonly kind: "unreadable" };

/**
 * Streamingly parse a `.jsonl` session file into a {@link SessionSummary} without retaining the
 * whole file or parsed entry objects in memory.
 */
export async function summarizeSessionFile(
    realPath: string,
    stats: { readonly mtimeMs: number; readonly size: number },
): Promise<SessionFileSummaryResult> {
    let header: Record<string, unknown> | null = null;
    let messageCount = 0;
    let firstMessage = "";
    let name: string | null = null;
    let lastActivityTime = 0;

    const stream = createReadStream(realPath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            if (!line.trim()) {
                continue;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                continue;
            }
            if (!isRecord(parsed) || typeof parsed.type !== "string") {
                continue;
            }
            if (header === null) {
                if (parsed.type !== "session" || typeof parsed.id !== "string" || parsed.id.length === 0) {
                    return { kind: "unreadable" };
                }
                header = parsed;
                continue;
            }
            if (parsed.type === "session_info") {
                const trimmed = typeof parsed.name === "string" ? parsed.name.trim() : "";
                name = trimmed.length > 0 ? trimmed : null;
                continue;
            }
            if (parsed.type !== "message" || !isRecord(parsed.message)) {
                continue;
            }
            messageCount += 1;
            const activityMs = messageActivityTimestampMs(parsed, parsed.message);
            if (activityMs !== undefined && activityMs > lastActivityTime) {
                lastActivityTime = activityMs;
            }
            const role = parsed.message.role;
            if ((role === "user" || role === "assistant") && firstMessage === "" && role === "user") {
                const text = extractMessageText(parsed.message.content);
                if (text !== "") {
                    firstMessage = text;
                }
            }
        }
    } catch {
        return { kind: "unreadable" };
    } finally {
        rl.close();
        stream.destroy();
    }

    if (header === null || typeof header.id !== "string") {
        return { kind: "unreadable" };
    }
    const sessionId = parseSessionId(header.id);
    if (sessionId === null) {
        return { kind: "invalid-id" };
    }
    const headerTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : Number.NaN;
    const modifiedAtMs =
        lastActivityTime > 0
            ? lastActivityTime
            : Number.isFinite(headerTime)
              ? headerTime
              : Number.isFinite(stats.mtimeMs)
                ? stats.mtimeMs
                : 0;
    const createdAtMs = Number.isFinite(headerTime) ? headerTime : modifiedAtMs;

    return {
        kind: "ok",
        summary: {
            id: sessionId,
            cwd: typeof header.cwd === "string" ? header.cwd : "",
            name,
            firstMessage: firstMessage !== "" ? firstMessage : "(no messages)",
            messageCount,
            createdAtMs,
            modifiedAtMs,
            hasParent: typeof header.parentSession === "string" && header.parentSession.length > 0,
            runtimeState: "idle",
            attachedClients: 0,
        },
    };
}

function expandHomeDirectory(value: string): string {
    if (value === "~") {
        return homedir();
    }
    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return join(homedir(), value.slice(2));
    }
    return value;
}

/**
 * Resolve one configured directory to an absolute path, or `undefined` when the value is unset
 * or blank. A leading `~` expands to the current home directory and relative paths resolve
 * against `cwd`, so the containment check always compares absolute paths.
 */
function normalizeDirectoryOption(value: string | undefined, cwd: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
        return undefined;
    }
    return resolve(cwd, expandHomeDirectory(trimmed));
}

/**
 * Resolve the session root with the same priority as the pi CLI:
 * `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > pi settings > `<agentDir>/sessions`.
 *
 * The agent directory defaults to the SDK `getAgentDir()`, which reads `PI_CODING_AGENT_DIR`.
 * Passing an explicit `agentDir`, `env`, and `cwd` keeps the function free of hidden global
 * state and lets tests use temporary directories.
 */
export function resolveSessionRoot(options: SessionRootOptions = {}): SessionRoot {
    const cwd = options.cwd ?? process.cwd();
    const agentDir = options.agentDir ?? getAgentDir();
    const env = options.env ?? process.env;

    const explicitDir = normalizeDirectoryOption(options.sessionDir, cwd);
    if (explicitDir !== undefined) {
        return { dir: explicitDir, isCustom: true };
    }

    const envDir = normalizeDirectoryOption(env.PI_CODING_AGENT_SESSION_DIR, cwd);
    if (envDir !== undefined) {
        return { dir: envDir, isCustom: true };
    }

    const settingsDir = normalizeDirectoryOption(SettingsManager.create(cwd, agentDir).getSessionDir(), cwd);
    if (settingsDir !== undefined) {
        return { dir: settingsDir, isCustom: true };
    }

    return { dir: resolve(agentDir, "sessions"), isCustom: false };
}

/** Returns true when `child` is `parent` or a path below `parent`. Both must be absolute. */
function isPathWithin(parent: string, child: string): boolean {
    const relativePath = relative(parent, child);
    if (relativePath === "") {
        return true;
    }
    return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

/**
 * Compute the per-project directory of the default session layout.
 *
 * The SDK builds the same name from the project cwd and the agent directory: it strips the leading
 * separator and replaces path separators and Windows drive colons with dashes. The server computes
 * it explicitly so an injected agent directory is honored instead of the process-wide default.
 */
export function defaultProjectSessionDir(sessionsRoot: string, cwd: string): string {
    const resolvedCwd = resolve(cwd);
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return join(sessionsRoot, safePath);
}

function isSessionHeader(entry: FileEntry): boolean {
    return entry.type === "session" && typeof entry.id === "string" && entry.id.length > 0;
}

function countNonEmptyLines(content: string): number {
    let count = 0;
    for (const line of content.split("\n")) {
        if (line.trim() !== "") {
            count += 1;
        }
    }
    return count;
}

/**
 * Read-only view of the sessions stored for one host.
 *
 * Listing and detail reads never write to disk. In particular they do not use
 * `SessionManager.open()` or the SDK `loadEntriesFromFile()`, because both can repair the file
 * on disk (append a missing trailing newline, rewrite the header, or create directories).
 */
export class SessionCatalog {
    readonly entriesVersion: EntriesVersion;
    private readonly options: SessionCatalogOptions;
    private readonly logger: SessionCatalogLogger;
    private readonly nowMs: () => number;
    private readonly maxSessionFileBytes: number;
    private readonly pathCache = new Map<string, CachedFileSummary>();
    private readonly idToPath = new Map<SessionId, string>();

    constructor(options: SessionCatalogOptions = {}) {
        this.options = options;
        this.logger = options.logger ?? createLogger();
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.maxSessionFileBytes =
            options.maxSessionFileBytes !== undefined &&
            Number.isFinite(options.maxSessionFileBytes) &&
            options.maxSessionFileBytes >= 0
                ? options.maxSessionFileBytes
                : MAX_SESSION_FILE_BYTES;
        this.entriesVersion = resolveEntriesVersion();
    }

    /** List every readable session under the session root, newest activity first. */
    async list(): Promise<CatalogSnapshot> {
        const { sessions } = await this.discover();
        return {
            sessions: sessions.map((session) => session.summary),
            updatedAtMs: this.nowMs(),
        };
    }

    /**
     * Resolve the session root used for reads and new sessions. The result is not checked on disk;
     * callers that create directories must handle a missing root.
     */
    resolveRoot(): SessionRoot {
        return resolveSessionRoot(this.options);
    }

    /**
     * Resolve one session file for opening or persistence checks without reading the transcript body.
     */
    async resolveById(id: SessionId): Promise<SessionResolution> {
        const root = await this.resolveDiscoveryRoot();
        const indexedPath = this.idToPath.get(id);
        if (indexedPath !== undefined) {
            const fastHit = await this.verifyIndexedPath(root, id, indexedPath);
            if (fastHit !== undefined) {
                return fastHit;
            }
            this.idToPath.delete(id);
        }

        const { sessions } = await this.discover();
        const match = sessions.find((session) => session.summary.id === id);
        if (match === undefined) {
            return { kind: "missing" };
        }
        return this.verifyDiscoveredPath(root, id, match);
    }

    private async verifyContainedFile(
        root: ResolvedDiscoveryRoot,
        sessionId: SessionId,
        candidatePath: string,
        action: "open" | "read",
    ): Promise<ContainedFileResult> {
        try {
            // Re-resolve symlinks at access time so a swapped link cannot escape the root boundary.
            const realPath = await realpath(candidatePath);
            if (!isPathWithin(root.realDir, realPath)) {
                this.logger.warn(
                    { sessionId, path: candidatePath },
                    `refused to ${action} session outside the session root`,
                );
                return { kind: "outside_root" };
            }
            const stats = await stat(realPath);
            if (!stats.isFile()) {
                return { kind: "non_file", realPath };
            }
            if (stats.size > this.maxSessionFileBytes) {
                return { kind: "oversized", realPath, stats };
            }
            return { kind: "ok", realPath, stats };
        } catch (error) {
            return { kind: "io_error", error };
        }
    }

    private async verifyIndexedPath(
        root: ResolvedDiscoveryRoot,
        id: SessionId,
        candidatePath: string,
    ): Promise<SessionResolution | undefined> {
        const verified = await this.verifyContainedFile(root, id, candidatePath, "open");
        if (verified.kind === "outside_root") {
            return { kind: "missing" };
        }
        if (verified.kind === "oversized") {
            const cached = this.pathCache.get(verified.realPath);
            if (
                cached !== undefined &&
                cached.mtimeMs === verified.stats.mtimeMs &&
                cached.size === verified.stats.size &&
                cached.summary.id === id
            ) {
                return { kind: "oversized", realPath: verified.realPath, sizeBytes: verified.stats.size };
            }
            // Fall back to discover() so an oversized replacement file cannot spoof `id`.
            return undefined;
        }
        if (verified.kind !== "ok") {
            return undefined;
        }
        const { realPath, stats } = verified;
        try {
            const cached = this.pathCache.get(realPath);
            if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
                if (cached.summary.id === id) {
                    return {
                        kind: "found",
                        session: { summary: cached.summary, realPath, sizeBytes: stats.size, root },
                    };
                }
                return undefined;
            }
            const refreshed = await summarizeSessionFile(realPath, stats);
            if (refreshed.kind !== "ok" || refreshed.summary.id !== id) {
                return undefined;
            }
            this.pathCache.set(realPath, { mtimeMs: stats.mtimeMs, size: stats.size, summary: refreshed.summary });
            return {
                kind: "found",
                session: { summary: refreshed.summary, realPath, sizeBytes: stats.size, root },
            };
        } catch {
            return undefined;
        }
    }

    private async verifyDiscoveredPath(
        root: ResolvedDiscoveryRoot,
        id: SessionId,
        match: DiscoveredSession,
    ): Promise<SessionResolution> {
        const verified = await this.verifyContainedFile(root, id, match.path, "open");
        switch (verified.kind) {
            case "ok":
                return {
                    kind: "found",
                    session: {
                        summary: match.summary,
                        realPath: verified.realPath,
                        sizeBytes: verified.stats.size,
                        root,
                    },
                };
            case "oversized":
                return { kind: "oversized", realPath: verified.realPath, sizeBytes: verified.stats.size };
            case "outside_root":
                return { kind: "missing" };
            case "non_file":
                this.logger.warn({ sessionId: id, path: verified.realPath }, "refused to open a non-file session path");
                return { kind: "missing" };
            case "io_error":
                this.logger.warn({ err: verified.error, sessionId: id }, "failed to resolve session file");
                return { kind: "missing" };
            default:
                return assertNever(verified);
        }
    }

    /**
     * Read one session by id, migrating entries to the current format in memory only.
     * Supports optional prefix slicing when `sliceAnchor` matches; otherwise returns full entries.
     * Returns `null` for an unknown id and for files that are unreadable, too large,
     * or outside the session root.
     */
    async getById(id: SessionId, sliceAnchor?: SessionPrefixAnchor): Promise<SessionDetailResponse | null> {
        const resolved = await this.resolveById(id);
        switch (resolved.kind) {
            case "found":
                return this.readSession(
                    resolved.session.root,
                    id,
                    { summary: resolved.session.summary, path: resolved.session.realPath },
                    sliceAnchor,
                );
            case "oversized":
                this.logger.warn(
                    { sessionId: id, size: resolved.sizeBytes },
                    "refused to read an oversized session file",
                );
                return null;
            case "missing":
                return null;
            default:
                return assertNever(resolved);
        }
    }

    private async resolveDiscoveryRoot(): Promise<ResolvedDiscoveryRoot> {
        const root = resolveSessionRoot(this.options);
        const realDir = await realpath(root.dir).catch(() => root.dir);
        return { ...root, realDir };
    }

    private async discover(): Promise<DiscoveryResult> {
        const root = await this.resolveDiscoveryRoot();
        const filePaths = await this.collectSessionFilePaths(root);
        const candidates: DiscoveredSession[] = [];
        const seenRealPaths = new Set<string>();

        for (const filePath of filePaths) {
            const realPath = await realpath(filePath).catch(() => null);
            if (realPath === null || !isPathWithin(root.realDir, realPath)) {
                this.logger.warn({ path: filePath }, "skipped session outside the session root");
                continue;
            }
            if (seenRealPaths.has(realPath)) {
                continue;
            }
            const stats = await stat(realPath).catch(() => null);
            if (stats === null || !stats.isFile()) {
                continue;
            }
            seenRealPaths.add(realPath);

            let summary: SessionSummary;
            const cached = this.pathCache.get(realPath);
            if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
                summary = cached.summary;
            } else {
                const summarized = await summarizeSessionFile(realPath, stats);
                if (summarized.kind === "invalid-id") {
                    this.pathCache.delete(realPath);
                    this.logger.warn({ path: filePath }, "skipped session with an unusable id");
                    continue;
                }
                if (summarized.kind === "unreadable") {
                    this.pathCache.delete(realPath);
                    continue;
                }
                summary = summarized.summary;
                this.pathCache.set(realPath, { mtimeMs: stats.mtimeMs, size: stats.size, summary });
            }

            candidates.push({ summary, path: realPath });
        }

        for (const cachedPath of this.pathCache.keys()) {
            if (!seenRealPaths.has(cachedPath)) {
                this.pathCache.delete(cachedPath);
            }
        }

        // A copied or restored session file can keep the header id of another file. Sorting by
        // activity and then by path makes the winner deterministic, and the warning names both
        // files so an operator can compare them.
        candidates.sort(
            (left, right) =>
                right.summary.modifiedAtMs - left.summary.modifiedAtMs || left.path.localeCompare(right.path),
        );

        const byId = new Map<SessionId, DiscoveredSession>();
        for (const candidate of candidates) {
            const existing = byId.get(candidate.summary.id);
            if (existing !== undefined) {
                this.logger.warn(
                    { sessionId: candidate.summary.id, keptPath: existing.path, skippedPath: candidate.path },
                    "duplicate session id",
                );
                continue;
            }
            byId.set(candidate.summary.id, candidate);
        }

        this.idToPath.clear();
        for (const [id, session] of byId) {
            this.idToPath.set(id, session.path);
        }

        return { root, sessions: [...byId.values()] };
    }

    private async collectJsonlInDir(dir: string): Promise<string[]> {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
        if (entries === null) {
            return [];
        }
        const paths: string[] = [];
        for (const entry of entries) {
            if (!entry.name.endsWith(".jsonl")) {
                continue;
            }
            if (!entry.isFile() && !entry.isSymbolicLink()) {
                continue;
            }
            paths.push(join(dir, entry.name));
        }
        return paths;
    }

    private async collectSessionFilePaths(root: ResolvedDiscoveryRoot): Promise<readonly string[]> {
        if (root.isCustom) {
            return this.collectJsonlInDir(root.dir);
        }

        const entries = await readdir(root.dir, { withFileTypes: true }).catch(() => null);
        if (entries === null) {
            return [];
        }

        const projectDirs: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) {
                continue;
            }
            const dir = join(root.dir, entry.name);
            const realDir = await realpath(dir).catch(() => null);
            if (realDir === null || !isPathWithin(root.realDir, realDir)) {
                this.logger.warn({ path: dir }, "skipped project directory outside the session root");
                continue;
            }
            projectDirs.push(dir);
        }

        const results: string[] = [];
        let nextIndex = 0;
        const workerCount = Math.min(PROJECT_DISCOVERY_CONCURRENCY, projectDirs.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < projectDirs.length) {
                const dir = projectDirs[nextIndex];
                nextIndex += 1;
                if (dir === undefined) {
                    continue;
                }
                const listed = await this.collectJsonlInDir(dir);
                results.push(...listed);
            }
        });
        await Promise.all(workers);
        return results;
    }

    private async readSession(
        root: ResolvedDiscoveryRoot,
        sessionId: SessionId,
        session: DiscoveredSession,
        sliceAnchor?: SessionPrefixAnchor,
    ): Promise<SessionDetailResponse | null> {
        const verified = await this.verifyContainedFile(root, sessionId, session.path, "read");
        if (verified.kind !== "ok") {
            if (verified.kind === "oversized") {
                this.logger.warn({ sessionId, size: verified.stats.size }, "refused to read an oversized session file");
            } else if (verified.kind === "non_file") {
                this.logger.warn({ sessionId, path: verified.realPath }, "refused to read a non-file session path");
            } else if (verified.kind === "io_error") {
                this.logger.warn({ err: verified.error, sessionId }, "failed to read session");
            }
            return null;
        }

        const { realPath } = verified;
        try {
            const content = await readFile(realPath, "utf8");
            const parsed = parseSessionEntries(content);
            const entries = parsed.filter(isFileEntryRecord);
            const header = entries.find((entry) => entry.type === "session");
            if (header === undefined || !isSessionHeader(header) || header.id !== sessionId) {
                this.logger.warn({ sessionId, path: realPath }, "session file has no matching header");
                return null;
            }

            const skippedLines = countNonEmptyLines(content) - entries.length;
            if (skippedLines > 0) {
                this.logger.warn({ sessionId, skippedLines }, "skipped malformed session lines");
            }

            // Capture the on-disk format version before in-memory migration updates `header.version`
            // so clients never cache unmigrated v1/v2 transcripts whose random entry ids vary per read.
            const diskVersion = header.version ?? 1;
            const entriesVersion = diskVersion === CURRENT_SESSION_VERSION ? this.entriesVersion : null;

            migrateSessionEntries(entries);
            const sliced = sliceEntriesForAnchor(sessionId, entries, entriesVersion, sliceAnchor);
            return {
                session: session.summary,
                entriesVersion,
                baseEntryCount: sliced.baseEntryCount,
                entries: sliced.entries,
            };
        } catch (error) {
            this.logger.warn({ err: error, sessionId }, "failed to read session");
            return null;
        }
    }
}
