import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
    getAgentDir,
    migrateSessionEntries,
    parseSessionEntries,
    SessionManager,
    SettingsManager,
    type FileEntry,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import type { SessionDetailResponse, SessionListResponse, SessionSummary } from "@pivia/protocol";

import { createLogger } from "../logger.ts";

/**
 * Session ids mirror the rule of the SDK session manager: non-empty, only alphanumeric
 * characters, `-`, `_`, and `.`, and the first and last character must be alphanumeric.
 * The SDK keeps its `assertValidSessionId` helper internal to the package, so this module owns
 * the same rule. The pattern rejects path separators and `..`; the server never builds a file
 * path from an id and only compares ids against session headers.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** Largest session file the detail endpoint reads into memory. */
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;

/** Maximum project subdirectories scanned concurrently so large session roots stay within file-descriptor limits. */
const PROJECT_DISCOVERY_CONCURRENCY = 4;

/** Returns true when `id` is a session identifier the server accepts. */
export function isValidSessionId(id: string): boolean {
    return SESSION_ID_PATTERN.test(id);
}

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
    /** Clock used for `scannedAtMs`; defaults to `Date.now`. */
    readonly nowMs?: (() => number) | undefined;
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

/** Result of resolving one session file for opening. */
export interface ResolvedSession {
    readonly summary: SessionSummary;
    /** Canonical file path that passed the session root containment check. */
    readonly realPath: string;
    /** Configured session root; `realDir` is the canonical containment boundary. */
    readonly root: SessionRoot & { readonly realDir: string };
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

function toFiniteMilliseconds(value: Date): number | undefined {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function toSessionSummary(info: SessionInfo): SessionSummary {
    const modifiedAtMs = toFiniteMilliseconds(info.modified) ?? 0;
    return {
        id: info.id,
        cwd: info.cwd,
        name: info.name ?? null,
        firstMessage: info.firstMessage,
        messageCount: info.messageCount,
        createdAtMs: toFiniteMilliseconds(info.created) ?? modifiedAtMs,
        modifiedAtMs,
        hasParent: info.parentSessionPath !== undefined && info.parentSessionPath.length > 0,
        runtimeState: "idle",
        attachedClients: 0,
    };
}

function isFileEntryRecord(value: unknown): value is FileEntry {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    return typeof (value as Record<string, unknown>).type === "string";
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
    private readonly options: SessionCatalogOptions;
    private readonly logger: SessionCatalogLogger;
    private readonly nowMs: () => number;

    constructor(options: SessionCatalogOptions = {}) {
        this.options = options;
        this.logger = options.logger ?? createLogger();
        this.nowMs = options.nowMs ?? (() => Date.now());
    }

    /** List every readable session under the session root, newest activity first. */
    async list(): Promise<SessionListResponse> {
        const { sessions } = await this.discover();
        return {
            sessions: sessions.map((session) => session.summary),
            scannedAtMs: this.nowMs(),
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
     * Resolve one session file for opening. Applies the same id, containment, and file checks as
     * {@link getById} without reading the transcript body.
     */
    async resolveById(id: string): Promise<ResolvedSession | null> {
        if (!isValidSessionId(id)) {
            return null;
        }
        const { root, sessions } = await this.discover();
        const match = sessions.find((session) => session.summary.id === id);
        if (match === undefined) {
            return null;
        }
        try {
            // Resolve again after discovery so a swapped symbolic link cannot redirect the open.
            const realPath = await realpath(match.path);
            if (!isPathWithin(root.realDir, realPath)) {
                this.logger.warn(
                    { sessionId: id, path: match.path },
                    "refused to open session outside the session root",
                );
                return null;
            }
            const stats = await stat(realPath);
            if (!stats.isFile()) {
                this.logger.warn({ sessionId: id, path: realPath }, "refused to open a non-file session path");
                return null;
            }
            if (stats.size > MAX_SESSION_FILE_BYTES) {
                this.logger.warn({ sessionId: id, size: stats.size }, "refused to open an oversized session file");
                return null;
            }
            return { summary: match.summary, realPath, root };
        } catch (error) {
            this.logger.warn({ err: error, sessionId: id }, "failed to resolve session file");
            return null;
        }
    }

    /**
     * Read one session by id, migrating entries to the current format in memory only.
     * Returns `null` for an invalid or unknown id and for files that are unreadable, too large,
     * or outside the session root.
     */
    async getById(id: string): Promise<SessionDetailResponse | null> {
        const resolved = await this.resolveById(id);
        if (resolved === null) {
            return null;
        }
        return this.readSession(resolved.root, id, { summary: resolved.summary, path: resolved.realPath });
    }

    private async resolveDiscoveryRoot(): Promise<ResolvedDiscoveryRoot> {
        const root = resolveSessionRoot(this.options);
        const realDir = await realpath(root.dir).catch(() => root.dir);
        return { ...root, realDir };
    }

    private async discover(): Promise<DiscoveryResult> {
        const root = await this.resolveDiscoveryRoot();
        const infos = await this.listSessionInfos(root);
        const candidates: DiscoveredSession[] = [];

        for (const info of infos) {
            if (typeof info.id !== "string" || !isValidSessionId(info.id)) {
                this.logger.warn({ path: info.path }, "skipped session with an unusable id");
                continue;
            }
            const realPath = await realpath(info.path).catch(() => null);
            if (realPath === null || !isPathWithin(root.realDir, realPath)) {
                this.logger.warn({ path: info.path }, "skipped session outside the session root");
                continue;
            }
            candidates.push({ summary: toSessionSummary(info), path: realPath });
        }

        // A copied or restored session file can keep the header id of another file. Sorting by
        // activity and then by path makes the winner deterministic, and the warning names both
        // files so an operator can compare them.
        candidates.sort(
            (left, right) =>
                right.summary.modifiedAtMs - left.summary.modifiedAtMs || left.path.localeCompare(right.path),
        );

        const byId = new Map<string, DiscoveredSession>();
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

        return { root, sessions: [...byId.values()] };
    }

    private async listSessionInfos(root: ResolvedDiscoveryRoot): Promise<readonly SessionInfo[]> {
        if (root.isCustom) {
            return SessionManager.listAll(root.dir);
        }

        // SessionManager.listAll() without a directory reads getAgentDir() from process.env, so it
        // cannot honor an injected agentDir. Scanning each project directory explicitly keeps the
        // default layout, keeps discovery free of process-wide state, and skips unreadable roots.
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

        const results: SessionInfo[] = [];
        let nextIndex = 0;
        const workerCount = Math.min(PROJECT_DISCOVERY_CONCURRENCY, projectDirs.length);
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < projectDirs.length) {
                const dir = projectDirs[nextIndex];
                nextIndex += 1;
                if (dir === undefined) {
                    continue;
                }
                const listed = await SessionManager.listAll(dir);
                results.push(...listed);
            }
        });
        await Promise.all(workers);
        return results;
    }

    private async readSession(
        root: ResolvedDiscoveryRoot,
        sessionId: string,
        session: DiscoveredSession,
    ): Promise<SessionDetailResponse | null> {
        try {
            // Resolve the path again right before the read so a swapped symbolic link cannot point
            // the request at a file outside the session root.
            const realPath = await realpath(session.path);
            if (!isPathWithin(root.realDir, realPath)) {
                this.logger.warn({ sessionId, path: session.path }, "refused to read session outside the session root");
                return null;
            }

            const stats = await stat(realPath);
            if (!stats.isFile()) {
                this.logger.warn({ sessionId, path: realPath }, "refused to read a non-file session path");
                return null;
            }
            if (stats.size > MAX_SESSION_FILE_BYTES) {
                this.logger.warn({ sessionId, size: stats.size }, "refused to read an oversized session file");
                return null;
            }

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

            migrateSessionEntries(entries);
            return { session: session.summary, entries };
        } catch (error) {
            this.logger.warn({ err: error, sessionId }, "failed to read session");
            return null;
        }
    }
}
