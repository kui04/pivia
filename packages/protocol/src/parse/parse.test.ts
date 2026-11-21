import { describe, expect, it } from "vitest";

import {
    assertNever,
    commandIdOf,
    isRecord,
    parseAfterSeq,
    parseEntriesVersion,
    parseExtensionUiResponse,
    parseSessionId,
    parseSessionPrefixAnchor,
    parseWsClientCommand,
    parseWsHandshakeQuery,
} from "./index.ts";

describe("protocol parse helpers", () => {
    it("isRecord accepts plain objects and rejects null, arrays, and primitives", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
        expect(isRecord(null)).toBe(false);
        expect(isRecord([])).toBe(false);
        expect(isRecord("text")).toBe(false);
        expect(isRecord(42)).toBe(false);
    });

    it("assertNever throws with the serialized value", () => {
        expect(() => assertNever("unexpected" as never, "Bad variant")).toThrow('Bad variant: "unexpected"');
    });

    it("parseSessionId accepts safe SDK session ids and rejects path traversal or invalid edges", () => {
        expect(parseSessionId("session-1")).toBe("session-1");
        expect(parseSessionId("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
        expect(parseSessionId("a.b_c-d")).toBe("a.b_c-d");

        expect(parseSessionId(null)).toBeNull();
        expect(parseSessionId("")).toBeNull();
        expect(parseSessionId("..")).toBeNull();
        expect(parseSessionId("../escape")).toBeNull();
        expect(parseSessionId("a/b")).toBeNull();
        expect(parseSessionId("a\\b")).toBeNull();
        expect(parseSessionId("-leading")).toBeNull();
        expect(parseSessionId("trailing-")).toBeNull();
        expect(parseSessionId("%2e%2e")).toBeNull();
    });

    it("parseEntriesVersion validates composite version strings", () => {
        expect(parseEntriesVersion("3:1.5.2")).toBe("3:1.5.2");
        expect(parseEntriesVersion("3:unknown")).toBe("3:unknown");
        expect(parseEntriesVersion("")).toBeNull();
        expect(parseEntriesVersion("3:")).toBeNull();
        expect(parseEntriesVersion("abc:1.0")).toBeNull();
        expect(parseEntriesVersion(123)).toBeNull();
    });

    it("parseSessionPrefixAnchor parses complete valid query anchors and drops incomplete ones", () => {
        expect(
            parseSessionPrefixAnchor({
                entriesVersion: "3:1.5.2",
                afterCount: "4",
                afterEntryId: "entry-4",
            }),
        ).toEqual({
            entriesVersion: "3:1.5.2",
            afterCount: 4,
            afterEntryId: "entry-4",
        });

        expect(
            parseSessionPrefixAnchor({ entriesVersion: "3:1.5.2", afterCount: "0", afterEntryId: "e" }),
        ).toBeUndefined();
        expect(parseSessionPrefixAnchor({ entriesVersion: "bad", afterCount: "2", afterEntryId: "e" })).toBeUndefined();
        expect(parseSessionPrefixAnchor({ entriesVersion: "3:1.5.2", afterCount: "2" })).toBeUndefined();
        expect(parseSessionPrefixAnchor(null)).toBeUndefined();
    });

    it("parseAfterSeq distinguishes absent, valid, and invalid values", () => {
        expect(parseAfterSeq(undefined)).toEqual({ ok: true, afterSeq: undefined });
        expect(parseAfterSeq("0")).toEqual({ ok: true, afterSeq: 0 });
        expect(parseAfterSeq("42")).toEqual({ ok: true, afterSeq: 42 });
        expect(parseAfterSeq("-1")).toEqual({ ok: false });
        expect(parseAfterSeq("abc")).toEqual({ ok: false });
        expect(parseAfterSeq(5)).toEqual({ ok: false });
    });

    it("parseWsHandshakeQuery parses afterSeq strictly and degrades invalid cache hints", () => {
        expect(
            parseWsHandshakeQuery({
                afterSeq: "10",
                runtimeId: "rt-1",
                entriesVersion: "3:1.5.2",
                afterCount: "3",
                afterEntryId: "e3",
            }),
        ).toEqual({
            ok: true,
            value: {
                afterSeq: 10,
                runtimeId: "rt-1",
                prefixAnchor: { entriesVersion: "3:1.5.2", afterCount: 3, afterEntryId: "e3" },
            },
        });

        expect(parseWsHandshakeQuery({ afterSeq: "nope" })).toEqual({
            ok: false,
            message: "Invalid afterSeq parameter.",
        });

        expect(parseWsHandshakeQuery({ afterSeq: "2", entriesVersion: "bad", afterCount: "0" })).toEqual({
            ok: true,
            value: { afterSeq: 2 },
        });

        expect(parseWsHandshakeQuery(undefined)).toEqual({ ok: true, value: {} });
    });

    it("parses valid WS client commands and extension UI responses", () => {
        expect(commandIdOf({ id: "cmd-1" })).toBe("cmd-1");
        expect(commandIdOf("not-a-record")).toBeUndefined();

        expect(parseExtensionUiResponse({ type: "extension_ui_response", id: "req-1", confirmed: true })).toEqual({
            type: "extension_ui_response",
            id: "req-1",
            confirmed: true,
        });

        expect(
            parseWsClientCommand({ type: "prompt", id: "p1", message: "hello", streamingBehavior: "steer" }),
        ).toEqual({
            type: "prompt",
            id: "p1",
            message: "hello",
            streamingBehavior: "steer",
        });

        expect(parseWsClientCommand({ type: "set_thinking_level", level: "invalid" })).toBeNull();
        expect(parseWsClientCommand({ type: "unknown_command" })).toBeNull();
    });
});
