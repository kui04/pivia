import { describe, expect, it } from "vitest";

import {
    parseAuthLoginResponse,
    parseAuthLogoutResponse,
    parseAuthStatusResponse,
    parseDirectoryListResponse,
    parseHealthResponse,
} from "./index.ts";

describe("system codecs", () => {
    it("parses health and auth HTTP responses and rejects malformed payloads", () => {
        expect(parseHealthResponse({ status: "ok", version: "0.1.0" })).toEqual({ status: "ok", version: "0.1.0" });
        expect(parseHealthResponse({ status: "down", version: "0.1.0" })).toBeNull();
        expect(parseAuthStatusResponse({ authRequired: true, authenticated: false })).toEqual({
            authRequired: true,
            authenticated: false,
        });
        expect(parseAuthLoginResponse({ authenticated: true })).toEqual({ authenticated: true });
        expect(parseAuthLoginResponse({ authenticated: false })).toBeNull();
        expect(parseAuthLogoutResponse({ authenticated: false })).toEqual({ authenticated: false });
    });

    it("parses directory list responses and rejects malformed payloads", () => {
        expect(
            parseDirectoryListResponse({
                path: "/home/u",
                parent: "/home",
                directories: ["repo", "docs"],
                truncated: false,
            }),
        ).toEqual({
            path: "/home/u",
            parent: "/home",
            directories: ["repo", "docs"],
            truncated: false,
        });
        expect(parseDirectoryListResponse({ path: "/", parent: null, directories: [], truncated: false })).toEqual({
            path: "/",
            parent: null,
            directories: [],
            truncated: false,
        });
        expect(parseDirectoryListResponse({ path: "", parent: null, directories: [], truncated: false })).toBeNull();
        expect(parseDirectoryListResponse({ path: "/", parent: 123, directories: [], truncated: false })).toBeNull();
        expect(
            parseDirectoryListResponse({ path: "/", parent: null, directories: [123], truncated: false }),
        ).toBeNull();
        expect(parseDirectoryListResponse({ path: "/", parent: null, directories: [] })).toBeNull();
    });
});
