import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { parseSessionId, type SessionId } from "@pivia/protocol";

import { afterEach, describe, expect, it } from "vitest";

import {
    resolveSessionRoot,
    SessionCatalog,
    type SessionCatalogLogger,
    type SessionCatalogOptions,
} from "./catalog.ts";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

interface MessageFixture {
    readonly role: string;
    readonly text: string;
    readonly timestamp?: string;
}

interface SessionFixture {
    readonly id: string;
    readonly cwd?: string;
    readonly timestamp?: string;
    readonly messages?: readonly MessageFixture[];
    readonly name?: string;
    readonly parentSession?: string;
    /** `null` produces a v1 file without tree fields; defaults to v3. */
    readonly version?: number | null;
}

interface LogRecord {
    readonly message: string;
    readonly record: Record<string, unknown>;
}

const tempDirs: string[] = [];

afterEach(() => {
    let dir = tempDirs.pop();
    while (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        dir = tempDirs.pop();
    }
});

function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function buildSessionContent(fixture: SessionFixture): string {
    const timestamp = fixture.timestamp ?? "2026-03-01T10:00:00.000Z";
    const versioned = fixture.version !== null;
    const header: Record<string, unknown> = {
        type: "session",
        id: fixture.id,
        timestamp,
        cwd: fixture.cwd ?? "/tmp/pivia-project",
    };
    if (versioned) {
        header.version = fixture.version ?? 3;
    }
    if (fixture.parentSession !== undefined) {
        header.parentSession = fixture.parentSession;
    }

    const lines = [JSON.stringify(header)];
    let parentId: string | null = null;
    let index = 0;
    for (const message of fixture.messages ?? []) {
        const entryId = `entry-${index}`;
        const entryTimestamp = message.timestamp ?? timestamp;
        lines.push(
            JSON.stringify({
                type: "message",
                ...(versioned ? { id: entryId, parentId } : {}),
                timestamp: entryTimestamp,
                message: {
                    role: message.role,
                    content: message.text,
                    timestamp: Date.parse(entryTimestamp),
                },
            }),
        );
        parentId = entryId;
        index += 1;
    }
    if (fixture.name !== undefined) {
        lines.push(
            JSON.stringify({
                type: "session_info",
                ...(versioned ? { id: `entry-${index}`, parentId } : {}),
                timestamp,
                name: fixture.name,
            }),
        );
    }
    return lines.join("\n");
}

function writeSessionFile(filePath: string, fixture: SessionFixture): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${buildSessionContent(fixture)}\n`, "utf8");
}

function createRecordingLogger(): { readonly logger: SessionCatalogLogger; readonly logs: LogRecord[] } {
    const logs: LogRecord[] = [];
    return {
        logs,
        logger: {
            warn(record, message) {
                logs.push({ record, message });
            },
        },
    };
}

function createCatalog(options: SessionCatalogOptions): SessionCatalog {
    return new SessionCatalog({
        // Defaults keep the test away from the user's real home directory and session store.
        cwd: createTempDir("pivia-cwd-"),
        env: {},
        ...options,
    });
}

describe("resolveSessionRoot", () => {
    it("uses the default per-project root when nothing is configured", () => {
        const agentDir = createTempDir("pivia-agent-");
        expect(resolveSessionRoot({ agentDir, cwd: createTempDir("pivia-cwd-"), env: {} })).toEqual({
            dir: join(agentDir, "sessions"),
            isCustom: false,
        });
    });

    it("prefers --session-dir over the environment and the pi sessionDir setting", () => {
        const explicitDir = createTempDir("pivia-explicit-");
        const envDir = createTempDir("pivia-env-");
        const settingsDir = createTempDir("pivia-settings-");
        const agentDir = createTempDir("pivia-agent-");
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: settingsDir }), "utf8");
        const cwd = createTempDir("pivia-cwd-");

        expect(
            resolveSessionRoot({
                sessionDir: explicitDir,
                env: { PI_CODING_AGENT_SESSION_DIR: envDir },
                agentDir,
                cwd,
            }),
        ).toEqual({ dir: resolve(explicitDir), isCustom: true });
        expect(resolveSessionRoot({ env: { PI_CODING_AGENT_SESSION_DIR: envDir }, agentDir, cwd })).toEqual({
            dir: resolve(envDir),
            isCustom: true,
        });
        expect(resolveSessionRoot({ env: {}, agentDir, cwd })).toEqual({
            dir: resolve(settingsDir),
            isCustom: true,
        });
    });

    it("expands a leading ~ in PI_CODING_AGENT_SESSION_DIR", () => {
        const homeDir = createTempDir("pivia-home-");
        const previousHome = process.env.HOME;
        process.env.HOME = homeDir;
        try {
            expect(
                resolveSessionRoot({
                    agentDir: createTempDir("pivia-agent-"),
                    cwd: createTempDir("pivia-cwd-"),
                    env: { PI_CODING_AGENT_SESSION_DIR: "~/pivia-sessions" },
                }),
            ).toEqual({ dir: join(homeDir, "pivia-sessions"), isCustom: true });
        } finally {
            if (previousHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = previousHome;
            }
        }
    });

    it("treats blank option and environment values as unset", () => {
        const agentDir = createTempDir("pivia-agent-");
        expect(
            resolveSessionRoot({
                sessionDir: "   ",
                env: { PI_CODING_AGENT_SESSION_DIR: "" },
                agentDir,
                cwd: createTempDir("pivia-cwd-"),
            }),
        ).toEqual({ dir: join(agentDir, "sessions"), isCustom: false });
    });
});

describe("SessionCatalog", () => {
    it("lists sessions from the default per-project layout only", async () => {
        const agentDir = createTempDir("pivia-agent-");
        const sessionsRoot = join(agentDir, "sessions");
        writeSessionFile(join(sessionsRoot, "-tmp-project-a", "older.jsonl"), {
            id: "session-older",
            cwd: "/tmp/project-a",
            timestamp: "2026-01-01T00:00:00.000Z",
            messages: [{ role: "user", text: "older question", timestamp: "2026-01-01T00:00:01.000Z" }],
        });
        writeSessionFile(join(sessionsRoot, "-tmp-project-b", "newer.jsonl"), {
            id: "session-newer",
            cwd: "/tmp/project-b",
            timestamp: "2026-02-01T00:00:00.000Z",
            name: "Newer session",
            messages: [
                { role: "user", text: "newer question", timestamp: "2026-02-01T00:00:01.000Z" },
                { role: "assistant", text: "newer answer", timestamp: "2026-02-01T00:00:02.000Z" },
            ],
        });
        // A session file directly in the sessions root belongs to the flat custom layout.
        writeSessionFile(join(sessionsRoot, "direct.jsonl"), { id: "session-direct" });
        writeFileSync(join(sessionsRoot, "-tmp-project-a", "notes.txt"), "not a session\n", "utf8");

        const { logger } = createRecordingLogger();
        const catalog = createCatalog({ agentDir, logger, nowMs: () => 4242 });

        const result = await catalog.list();

        expect(result.updatedAtMs).toBe(4242);
        expect(result.sessions.map((session) => session.id)).toEqual(["session-newer", "session-older"]);
        expect(result.sessions[0]).toEqual({
            id: "session-newer",
            cwd: "/tmp/project-b",
            name: "Newer session",
            firstMessage: "newer question",
            messageCount: 2,
            createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
            modifiedAtMs: Date.parse("2026-02-01T00:00:02.000Z"),
            hasParent: false,
            runtimeState: "idle",
            attachedClients: 0,
        });
        expect(result.sessions[1]?.name).toBeNull();
        expect(result.sessions[1]?.hasParent).toBe(false);

        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("allMessagesText");
        expect(serialized).not.toContain(sessionsRoot);
    });

    it("preserves a long first user message in full in the session summary", async () => {
        const agentDir = createTempDir("pivia-agent-");
        const sessionDir = createTempDir("pivia-sessions-");
        const longMessage = "x".repeat(2_000);
        writeSessionFile(join(sessionDir, "long.jsonl"), {
            id: "session-long",
            messages: [{ role: "user", text: longMessage, timestamp: "2026-01-01T00:00:01.000Z" }],
        });

        const catalog = createCatalog({ agentDir, sessionDir, logger: createRecordingLogger().logger });
        const result = await catalog.list();

        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]?.firstMessage).toBe(longMessage);
    });

    it("lists sessions from a flat custom directory and ignores nested files", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        writeSessionFile(join(sessionDir, "flat.jsonl"), { id: "session-flat", messages: [] });
        writeSessionFile(join(sessionDir, "nested", "deep.jsonl"), { id: "session-nested", messages: [] });

        const { logger } = createRecordingLogger();
        const result = await createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger }).list();

        expect(result.sessions.map((session) => session.id)).toEqual(["session-flat"]);
    });

    it("skips malformed lines and files without a session header", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        const validContent = buildSessionContent({
            id: "session-kept",
            messages: [{ role: "user", text: "kept question" }],
        });
        writeFileSync(join(sessionDir, "prefixed.jsonl"), `{not json\n${validContent}\n{"foo":1}\n`, "utf8");
        writeFileSync(
            join(sessionDir, "no-header.jsonl"),
            `${JSON.stringify({ type: "message", id: "only", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
            "utf8",
        );

        const { logger, logs } = createRecordingLogger();
        const catalog = createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger });

        const result = await catalog.list();
        expect(result.sessions.map((session) => session.id)).toEqual(["session-kept"]);

        const detail = await catalog.getById(sid("session-kept"));
        expect(detail?.entries).toHaveLength(2);
        expect(logs.some((log) => log.message === "skipped malformed session lines")).toBe(true);
        const malformedLog = logs.find((log) => log.message === "skipped malformed session lines");
        expect(malformedLog?.record.skippedLines).toBe(2);
    });

    it("falls back to finite timestamps when the session header timestamp is malformed", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        writeSessionFile(join(sessionDir, "bad-time.jsonl"), {
            id: "session-bad-time",
            timestamp: "not-a-timestamp",
            messages: [],
        });

        const { logger } = createRecordingLogger();
        const result = await createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger }).list();

        expect(result.sessions).toHaveLength(1);
        const session = result.sessions[0];
        expect(session?.createdAtMs).toBe(session?.modifiedAtMs);
        expect(Number.isFinite(session?.createdAtMs)).toBe(true);
        expect(Number.isFinite(session?.modifiedAtMs)).toBe(true);
    });

    it("keeps the most recent file when several files share a session id", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        writeSessionFile(join(sessionDir, "older.jsonl"), {
            id: "session-duplicate",
            timestamp: "2026-01-01T00:00:00.000Z",
            messages: [{ role: "user", text: "older copy", timestamp: "2026-01-01T00:00:01.000Z" }],
        });
        writeSessionFile(join(sessionDir, "newer.jsonl"), {
            id: "session-duplicate",
            timestamp: "2026-02-01T00:00:00.000Z",
            messages: [{ role: "user", text: "newer copy", timestamp: "2026-02-01T00:00:01.000Z" }],
        });

        const { logger, logs } = createRecordingLogger();
        const catalog = createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger });

        const result = await catalog.list();
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0]?.firstMessage).toBe("newer copy");
        expect(logs.some((log) => log.message === "duplicate session id")).toBe(true);

        const detail = await catalog.getById(sid("session-duplicate"));
        expect(detail?.session.firstMessage).toBe("newer copy");
    });

    it("migrates a v1 session to v3 in memory without changing the source file", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        const filePath = join(sessionDir, "legacy.jsonl");
        const content = buildSessionContent({
            id: "session-legacy",
            version: null,
            timestamp: "2025-05-01T00:00:00.000Z",
            messages: [
                { role: "user", text: "legacy question" },
                { role: "assistant", text: "legacy answer" },
            ],
        });
        // No trailing newline: the SDK loadEntriesFromFile() would append one on open.
        writeFileSync(filePath, content, "utf8");
        const before = {
            content: readFileSync(filePath, "utf8"),
            mtimeMs: statSync(filePath).mtimeMs,
            size: statSync(filePath).size,
        };

        const { logger } = createRecordingLogger();
        const detail = await createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger }).getById(
            sid("session-legacy"),
        );

        expect(detail).not.toBeNull();
        const entries = detail?.entries ?? [];
        expect(entries).toHaveLength(3);
        expect(entries[0]).toMatchObject({ type: "session", id: "session-legacy", version: 3 });

        const messageEntries = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
        expect(messageEntries).toHaveLength(2);
        expect(messageEntries[0]?.parentId).toBeNull();
        expect(typeof messageEntries[0]?.id).toBe("string");
        expect(messageEntries[1]?.parentId).toBe(messageEntries[0]?.id);

        const after = {
            content: readFileSync(filePath, "utf8"),
            mtimeMs: statSync(filePath).mtimeMs,
            size: statSync(filePath).size,
        };
        expect(after).toEqual(before);
    });

    it("migrates v2 hook messages to custom messages in memory", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        writeSessionFile(join(sessionDir, "v2.jsonl"), {
            id: "session-v2",
            version: 2,
            messages: [{ role: "hookMessage", text: "hooked message" }],
        });

        const { logger } = createRecordingLogger();
        const detail = await createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger }).getById(
            sid("session-v2"),
        );

        const entries = detail?.entries ?? [];
        expect(entries[0]).toMatchObject({ type: "session", version: 3 });
        expect(JSON.stringify(entries)).not.toContain("hookMessage");
    });

    it("returns null for unknown ids", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        writeSessionFile(join(sessionDir, "alpha.jsonl"), { id: "session-alpha", messages: [] });

        const { logger } = createRecordingLogger();
        const catalog = createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger });

        expect(await catalog.getById(sid("session-unknown"))).toBeNull();
        expect(await catalog.getById(sid("session-alpha"))).not.toBeNull();
    });

    it("skips and warns on session files whose header has an unusable id", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        writeSessionFile(join(sessionDir, "bad-id.jsonl"), { id: "../bad", messages: [] });

        const { logger, logs } = createRecordingLogger();
        const catalog = createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger });

        expect((await catalog.list()).sessions).toEqual([]);
        expect(logs.some((log) => log.message === "skipped session with an unusable id")).toBe(true);
    });

    it("refuses symbolic links that point outside the session root", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        const outsideDir = createTempDir("pivia-outside-");
        const outsideFile = join(outsideDir, "outside.jsonl");
        writeSessionFile(outsideFile, { id: "session-outside", messages: [{ role: "user", text: "secret" }] });
        symlinkSync(outsideFile, join(sessionDir, "escape.jsonl"));

        const { logger, logs } = createRecordingLogger();
        const catalog = createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger });

        expect((await catalog.list()).sessions).toEqual([]);
        expect(await catalog.getById(sid("session-outside"))).toBeNull();
        expect(logs.some((log) => log.message === "skipped session outside the session root")).toBe(true);
    });

    it("ignores project directories that link outside the default session root", async () => {
        const agentDir = createTempDir("pivia-agent-");
        const outsideDir = createTempDir("pivia-outside-");
        writeSessionFile(join(outsideDir, "hidden.jsonl"), { id: "session-hidden", messages: [] });
        mkdirSync(join(agentDir, "sessions"), { recursive: true });
        symlinkSync(outsideDir, join(agentDir, "sessions", "-linked-project"));

        const { logger, logs } = createRecordingLogger();
        const catalog = createCatalog({ agentDir, logger });

        expect((await catalog.list()).sessions).toEqual([]);
        expect(logs.some((log) => log.message === "skipped project directory outside the session root")).toBe(true);
    });

    it("returns an empty list when the session root does not exist", async () => {
        const { logger } = createRecordingLogger();
        const agentDir = join(createTempDir("pivia-agent-"), "missing");
        const result = await createCatalog({ agentDir, logger }).list();

        expect(result.sessions).toEqual([]);
        expect(Number.isFinite(result.updatedAtMs)).toBe(true);
    });

    it("keeps a session whose header has a parent session", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        writeSessionFile(join(sessionDir, "fork.jsonl"), {
            id: "session-fork",
            parentSession: "/tmp/pivia-project/older.jsonl",
            messages: [],
        });

        const { logger } = createRecordingLogger();
        const result = await createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger }).list();

        expect(result.sessions[0]?.hasParent).toBe(true);
    });

    it("orders sessions by file modification time when the header timestamp is unusable", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        const firstFile = join(sessionDir, "first.jsonl");
        const secondFile = join(sessionDir, "second.jsonl");
        writeSessionFile(firstFile, { id: "session-first", timestamp: "invalid-time", messages: [] });
        writeSessionFile(secondFile, { id: "session-second", timestamp: "invalid-time", messages: [] });
        utimesSync(firstFile, 1_700_000_000, 1_700_000_000);
        utimesSync(secondFile, 1_700_000_100, 1_700_000_100);

        const { logger } = createRecordingLogger();
        const result = await createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger }).list();

        expect(result.sessions.map((session) => session.id)).toEqual(["session-second", "session-first"]);
    });

    it("lists sessions across more project directories than the discovery concurrency limit", async () => {
        const agentDir = createTempDir("pivia-agent-");
        const sessionsRoot = join(agentDir, "sessions");
        const expectedIds: string[] = [];
        for (let i = 0; i < 6; i += 1) {
            const id = `session-proj-${i}`;
            expectedIds.push(id);
            writeSessionFile(join(sessionsRoot, `-tmp-project-${i}`, `${id}.jsonl`), {
                id,
                cwd: `/tmp/project-${i}`,
                timestamp: `2026-03-0${i + 1}T00:00:00.000Z`,
                messages: [],
            });
        }

        const { logger } = createRecordingLogger();
        const result = await createCatalog({ agentDir, logger }).list();

        expect(result.sessions.map((session) => session.id)).toEqual([...expectedIds].reverse());
    });

    it("caches summaries by mtime/size, resolves indexed ids, refreshes on change, and prunes deleted files", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        const filePath = join(sessionDir, "cached.jsonl");
        writeSessionFile(filePath, {
            id: "session-cached",
            timestamp: "2026-03-01T00:00:00.000Z",
            messages: [{ role: "user", text: "initial question", timestamp: "2026-03-01T00:00:01.000Z" }],
        });

        const { logger } = createRecordingLogger();
        const catalog = createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger });

        const firstList = await catalog.list();
        expect(firstList.sessions).toHaveLength(1);
        expect(firstList.sessions[0]?.messageCount).toBe(1);

        // Append a reply with a different size & mtime; resolveById must refresh single-file summary.
        writeSessionFile(filePath, {
            id: "session-cached",
            timestamp: "2026-03-01T00:00:00.000Z",
            name: "Updated Title",
            messages: [
                { role: "user", text: "initial question", timestamp: "2026-03-01T00:00:01.000Z" },
                { role: "assistant", text: "updated reply", timestamp: "2026-03-01T00:00:05.000Z" },
            ],
        });
        const resolved = await catalog.resolveById(sid("session-cached"));
        expect(resolved.kind).toBe("found");
        if (resolved.kind === "found") {
            expect(resolved.session.summary.messageCount).toBe(2);
            expect(resolved.session.summary.name).toBe("Updated Title");
            expect(resolved.session.sizeBytes).toBe(statSync(filePath).size);
        }

        // Deleting the file removes it on the next list() and makes resolveById return missing.
        rmSync(filePath);
        expect(await catalog.resolveById(sid("session-cached"))).toEqual({ kind: "missing" });
        expect((await catalog.list()).sessions).toEqual([]);
    });

    it("reports oversized persisted sessions without dropping them from list or misclassifying them as missing", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        const filePath = join(sessionDir, "oversized.jsonl");
        writeSessionFile(filePath, {
            id: "session-oversized",
            messages: [{ role: "user", text: "x".repeat(500) }],
        });
        const fileSize = statSync(filePath).size;

        const { logger, logs } = createRecordingLogger();
        const catalog = new SessionCatalog({
            sessionDir,
            agentDir: createTempDir("pivia-agent-"),
            cwd: sessionDir,
            env: {},
            logger,
            maxSessionFileBytes: 100,
        });

        expect((await catalog.list()).sessions.map((session) => session.id)).toEqual(["session-oversized"]);

        const firstResolution = await catalog.resolveById(sid("session-oversized"));
        expect(firstResolution).toMatchObject({ kind: "oversized", sizeBytes: fileSize });
        expect(logs.some((entry) => entry.message.includes("oversized"))).toBe(false);

        // Cached fast path must preserve the oversized classification without triggering a read warning.
        const secondResolution = await catalog.resolveById(sid("session-oversized"));
        expect(secondResolution).toMatchObject({ kind: "oversized", sizeBytes: fileSize });
        expect(logs.some((entry) => entry.message.includes("oversized"))).toBe(false);

        expect(await catalog.getById(sid("session-oversized"))).toBeNull();
        expect(logs.some((entry) => entry.message.includes("refused to read an oversized session file"))).toBe(true);
    });

    it("returns null entriesVersion for unmigrated v1/v2 files and slices v3 files by prefix anchor", async () => {
        const sessionDir = createTempDir("pivia-sessions-");
        writeSessionFile(join(sessionDir, "v1.jsonl"), {
            id: "session-v1",
            version: null,
            messages: [{ role: "user", text: "v1 question" }],
        });
        writeSessionFile(join(sessionDir, "v3.jsonl"), {
            id: "session-v3",
            version: 3,
            messages: [
                { role: "user", text: "q1" },
                { role: "assistant", text: "a1" },
            ],
        });

        const { logger } = createRecordingLogger();
        const catalog = createCatalog({ sessionDir, agentDir: createTempDir("pivia-agent-"), logger });

        const v1Detail = await catalog.getById(sid("session-v1"));
        expect(v1Detail?.entriesVersion).toBeNull();
        expect(v1Detail?.baseEntryCount).toBe(0);

        const v3Full = await catalog.getById(sid("session-v3"));
        expect(v3Full?.entriesVersion).toBe(catalog.entriesVersion);
        expect(v3Full?.baseEntryCount).toBe(0);
        expect(v3Full?.entries).toHaveLength(3);

        // Header-only anchor (afterCount = 1, afterEntryId = sessionId) slices messages after header.
        const fromHeader = await catalog.getById(sid("session-v3"), {
            entriesVersion: catalog.entriesVersion,
            afterCount: 1,
            afterEntryId: "session-v3",
        });
        expect(fromHeader?.baseEntryCount).toBe(1);
        expect(fromHeader?.entries).toHaveLength(2);

        // Entry-level anchor slices trailing entry only.
        const fromEntry0 = await catalog.getById(sid("session-v3"), {
            entriesVersion: catalog.entriesVersion,
            afterCount: 2,
            afterEntryId: "entry-0",
        });
        expect(fromEntry0?.baseEntryCount).toBe(2);
        expect(fromEntry0?.entries).toHaveLength(1);

        // Mismatched anchor falls back to full entries gracefully.
        const mismatched = await catalog.getById(sid("session-v3"), {
            entriesVersion: catalog.entriesVersion,
            afterCount: 2,
            afterEntryId: "wrong-id",
        });
        expect(mismatched?.baseEntryCount).toBe(0);
        expect(mismatched?.entries).toHaveLength(3);
    });
});
