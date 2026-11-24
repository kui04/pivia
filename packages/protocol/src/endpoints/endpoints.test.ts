import { describe, expect, it } from "vitest";

import {
    API_PATH_PREFIX,
    encodeDirectoryListQuery,
    encodeSessionPrefixAnchorQuery,
    encodeSessionWsHandshakeQuery,
    encodeSyncHandshakeQuery,
    HTTP_ENDPOINTS,
    parseDirectoryListQuery,
    parseEntriesVersion,
    parseSessionId,
    parseSessionPathParams,
    parseSyncEpoch,
    parseSyncSeq,
    PUBLIC_API_PATHS,
    WS_ENDPOINTS,
    WS_PATH_PREFIX,
    type EntriesVersion,
    type SessionId,
    type SessionPrefixAnchor,
    type SyncEpoch,
    type SyncSeq,
} from "../index.ts";

function mustSessionId(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

function mustEntriesVersion(raw: string): EntriesVersion {
    const parsed = parseEntriesVersion(raw);
    if (parsed === null) {
        throw new Error(`Invalid test entries version: ${raw}`);
    }
    return parsed;
}

function mustEpoch<D extends string>(raw: string): SyncEpoch<D> {
    const parsed = parseSyncEpoch<D>(raw);
    if (parsed === null) {
        throw new Error(`Invalid test epoch: ${raw}`);
    }
    return parsed;
}

function mustSeq<D extends string>(raw: number): SyncSeq<D> {
    const parsed = parseSyncSeq<D>(raw);
    if (parsed === null) {
        throw new Error(`Invalid test seq: ${raw}`);
    }
    return parsed;
}

function queryObjectFromPath(path: string): Record<string, string> {
    const url = new URL(path, "http://localhost");
    return Object.fromEntries(url.searchParams.entries());
}

describe("endpoint descriptors", () => {
    it("derives PUBLIC_API_PATHS from public HTTP_ENDPOINTS", () => {
        const expected = Object.values(HTTP_ENDPOINTS)
            .filter((endpoint) => endpoint.public)
            .map((endpoint) => endpoint.pattern);
        expect(PUBLIC_API_PATHS).toEqual(expected);
        expect(PUBLIC_API_PATHS).toEqual(["/api/health", "/api/auth/status", "/api/auth", "/api/auth/logout"]);
    });

    it("keeps all HTTP and WS endpoint patterns under their canonical prefixes", () => {
        for (const endpoint of Object.values(HTTP_ENDPOINTS)) {
            expect(endpoint.pattern.startsWith(API_PATH_PREFIX)).toBe(true);
        }
        for (const endpoint of Object.values(WS_ENDPOINTS)) {
            expect(endpoint.pattern.startsWith(WS_PATH_PREFIX)).toBe(true);
        }
    });

    it("builds static HTTP paths matching their patterns", () => {
        expect(HTTP_ENDPOINTS.health.buildPath()).toBe(HTTP_ENDPOINTS.health.pattern);
        expect(HTTP_ENDPOINTS.authStatus.buildPath()).toBe(HTTP_ENDPOINTS.authStatus.pattern);
        expect(HTTP_ENDPOINTS.authLogin.buildPath()).toBe(HTTP_ENDPOINTS.authLogin.pattern);
        expect(HTTP_ENDPOINTS.authLogout.buildPath()).toBe(HTTP_ENDPOINTS.authLogout.pattern);
        expect(HTTP_ENDPOINTS.listSessions.buildPath()).toBe(HTTP_ENDPOINTS.listSessions.pattern);
        expect(HTTP_ENDPOINTS.createSession.buildPath()).toBe(HTTP_ENDPOINTS.createSession.pattern);
    });

    it("round-trips listDirectories query parameters and omits blank paths", () => {
        expect(HTTP_ENDPOINTS.listDirectories.buildPath()).toBe("/api/fs/directories");
        expect(HTTP_ENDPOINTS.listDirectories.buildPath({})).toBe("/api/fs/directories");
        expect(HTTP_ENDPOINTS.listDirectories.buildPath({ path: "   " })).toBe("/api/fs/directories");

        const built = HTTP_ENDPOINTS.listDirectories.buildPath({ path: "  /home/u/my projects  " });
        expect(built).toBe("/api/fs/directories?path=%2Fhome%2Fu%2Fmy+projects");
        expect(HTTP_ENDPOINTS.listDirectories.parseQuery(queryObjectFromPath(built))).toEqual({
            path: "/home/u/my projects",
        });

        expect(parseDirectoryListQuery(null)).toEqual({});
        expect(parseDirectoryListQuery({ path: 123 })).toEqual({});
        expect(parseDirectoryListQuery({ path: "   " })).toEqual({});
        expect(encodeDirectoryListQuery(undefined).toString()).toBe("");
    });

    it("validates session path params and builds sessionDetail / closeSession paths", () => {
        const id = mustSessionId("session.1_a-b");
        expect(parseSessionPathParams({ id: "session.1_a-b" })).toEqual({ id });
        expect(parseSessionPathParams({ id: "../evil" })).toBeNull();
        expect(parseSessionPathParams({})).toBeNull();
        expect(parseSessionPathParams(null)).toBeNull();

        expect(HTTP_ENDPOINTS.closeSession.buildPath({ id })).toBe("/api/sessions/session.1_a-b/close");
        expect(HTTP_ENDPOINTS.sessionDetail.buildPath({ id })).toBe("/api/sessions/session.1_a-b");

        const anchor: SessionPrefixAnchor = {
            entriesVersion: mustEntriesVersion("3:1.5.2"),
            afterCount: 4,
            afterEntryId: "entry-4",
        };
        const detailPath = HTTP_ENDPOINTS.sessionDetail.buildPath({ id }, anchor);
        expect(detailPath).toBe(
            "/api/sessions/session.1_a-b?entriesVersion=3%3A1.5.2&afterCount=4&afterEntryId=entry-4",
        );
        expect(HTTP_ENDPOINTS.sessionDetail.parseQuery(queryObjectFromPath(detailPath))).toEqual(anchor);
        expect(encodeSessionPrefixAnchorQuery(undefined).toString()).toBe("");
    });

    it("round-trips workspace WS handshake query parameters", () => {
        expect(WS_ENDPOINTS.workspace.buildPath()).toBe("/ws/workspace");
        expect(WS_ENDPOINTS.workspace.buildPath({})).toBe("/ws/workspace");

        const handshake = {
            cursor: {
                epoch: mustEpoch<"catalog">("epoch-1"),
                seq: mustSeq<"catalog">(7),
            },
        };
        const path = WS_ENDPOINTS.workspace.buildPath(handshake);
        expect(path).toBe("/ws/workspace?epoch=epoch-1&afterSeq=7");
        expect(WS_ENDPOINTS.workspace.parseQuery(queryObjectFromPath(path))).toEqual(handshake);
        expect(encodeSyncHandshakeQuery(undefined).toString()).toBe("");
    });

    it("round-trips session WS path params and handshake query parameters", () => {
        const id = mustSessionId("session-1");
        expect(WS_ENDPOINTS.session.buildPath({ id })).toBe("/ws/sessions/session-1");

        const handshake = {
            cursor: {
                epoch: mustEpoch<"session">("runtime-1"),
                seq: mustSeq<"session">(12),
            },
            hint: {
                entriesVersion: mustEntriesVersion("3:1.5.2"),
                afterCount: 3,
                afterEntryId: "e3",
            },
        };
        const path = WS_ENDPOINTS.session.buildPath({ id }, handshake);
        expect(path).toBe(
            "/ws/sessions/session-1?epoch=runtime-1&afterSeq=12&entriesVersion=3%3A1.5.2&afterCount=3&afterEntryId=e3",
        );
        expect(WS_ENDPOINTS.session.parseQuery(queryObjectFromPath(path))).toEqual(handshake);
        expect(encodeSessionWsHandshakeQuery(undefined).toString()).toBe("");
    });
});
