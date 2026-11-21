import { describe, expect, it } from "vitest";

import { AuthService, type AuthToken, generateStartupSecret, isLoopbackHost } from "./service.ts";

describe("isLoopbackHost", () => {
    it("accepts bindable loopback addresses and rejects bracketed, wildcard, or external addresses", () => {
        expect(isLoopbackHost("127.0.0.1")).toBe(true);
        expect(isLoopbackHost("127.0.1.1")).toBe(true);
        expect(isLoopbackHost("::1")).toBe(true);
        expect(isLoopbackHost("localhost")).toBe(true);

        expect(isLoopbackHost("[::1]")).toBe(false);
        expect(isLoopbackHost("0.0.0.0")).toBe(false);
        expect(isLoopbackHost("::")).toBe(false);
        expect(isLoopbackHost("192.168.1.10")).toBe(false);
        expect(isLoopbackHost("127.999.0.1")).toBe(false);
        expect(isLoopbackHost("")).toBe(false);
    });
});

describe("AuthService", () => {
    it("rejects invalid constructor options", () => {
        // @ts-expect-error -- verify runtime guard for untyped callers
        expect(() => new AuthService({})).toThrow();
        expect(() => new AuthService({ password: "" })).toThrow();
        // @ts-expect-error -- verify runtime guard for untyped callers
        expect(() => new AuthService({ disabled: true, password: "secret" })).toThrow();
        expect(() => new AuthService({ password: "secret", sessionTtlMs: 0 })).toThrow();
        expect(() => new AuthService({ password: "secret", sessionTtlMs: 999 })).toThrow();
        expect(() => new AuthService({ password: "secret", sessionTtlMs: Number.NaN })).toThrow();
        expect(() => new AuthService({ password: "secret", maxFailures: 0 })).toThrow();
        expect(() => new AuthService({ password: "secret", maxFailures: 1.5 })).toThrow();
        expect(() => new AuthService({ password: "secret", rateWindowMs: 0 })).toThrow();
        expect(() => new AuthService({ password: "secret", rateWindowMs: -100 })).toThrow();
    });

    it("creates, validates, expires, and revokes sessions", () => {
        let now = 1_000;
        const auth = new AuthService({
            password: "secret-password",
            sessionTtlMs: 5_000,
            nowMs: () => now,
        });

        const login = auth.login("secret-password", "10.0.0.1");
        expect(login.ok).toBe(true);
        if (!login.ok) {
            throw new Error("expected login to succeed");
        }

        expect(auth.isSessionValid(login.token)).toBe(true);
        expect(auth.isSessionValid("nonexistent")).toBe(false);

        now = 5_999;
        expect(auth.isSessionValid(login.token)).toBe(true);

        now = 6_000;
        expect(auth.isSessionValid(login.token)).toBe(false);

        const second = auth.login("secret-password", "10.0.0.1");
        expect(second.ok).toBe(true);
        if (second.ok) {
            auth.logout(second.token);
            expect(auth.isSessionValid(second.token)).toBe(false);
        }
    });

    it("evicts the oldest active session when the session cap is reached", () => {
        const auth = new AuthService({ password: "secret" });
        const issued: AuthToken[] = [];

        for (let i = 0; i < 257; i += 1) {
            const res = auth.login("secret", "127.0.0.1");
            expect(res.ok).toBe(true);
            if (res.ok) {
                issued.push(res.token);
            }
        }

        expect(auth.isSessionValid(issued[0])).toBe(false);
        expect(auth.isSessionValid(issued[1])).toBe(true);
        expect(auth.isSessionValid(issued[256])).toBe(true);
    });

    it("rate-limits repeated failures per client and clears accumulated failures on success", () => {
        let now = 0;
        const auth = new AuthService({
            password: "secret",
            maxFailures: 3,
            rateWindowMs: 30_000,
            nowMs: () => now,
        });

        expect(auth.login("bad", "client-a")).toEqual({ ok: false, reason: "invalid_credentials" });
        expect(auth.login("bad", "client-a")).toEqual({ ok: false, reason: "invalid_credentials" });

        // Succeeding before reaching the limit must clear the accumulated failures in client-a's bucket.
        expect(auth.login("secret", "client-a").ok).toBe(true);
        expect(auth.login("bad", "client-a")).toEqual({ ok: false, reason: "invalid_credentials" });
        expect(auth.login("bad", "client-a")).toEqual({ ok: false, reason: "invalid_credentials" });
        expect(auth.login("bad", "client-a")).toEqual({ ok: false, reason: "invalid_credentials" });

        const blocked = auth.login("secret", "client-a");
        expect(blocked).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: 30 });

        // Another client is unaffected.
        expect(auth.login("secret", "client-b").ok).toBe(true);

        // Window expires after 30s.
        now = 30_000;
        expect(auth.login("secret", "client-a").ok).toBe(true);
    });

    it("bounds stored failure buckets across many distinct clients", () => {
        let now = 0;
        const auth = new AuthService({
            password: "secret",
            maxFailures: 1,
            rateWindowMs: 60_000,
            nowMs: () => now,
        });

        for (let i = 0; i < 1030; i += 1) {
            expect(auth.login("bad", `client-${i}`)).toEqual({ ok: false, reason: "invalid_credentials" });
        }

        // The earliest buckets were evicted when the 1024-bucket cap was exceeded,
        // while recent buckets remain rate-limited.
        expect(auth.login("secret", "client-0").ok).toBe(true);
        expect(auth.login("secret", "client-1029")).toEqual({
            ok: false,
            reason: "rate_limited",
            retryAfterSeconds: 60,
        });

        // Expired buckets are swept when a new failure arrives after the window.
        now = 60_000;
        expect(auth.login("bad", "fresh-client")).toEqual({ ok: false, reason: "invalid_credentials" });
    });

    it("generates distinct high-entropy startup secrets", () => {
        const a = generateStartupSecret();
        const b = generateStartupSecret();
        expect(a.length).toBeGreaterThanOrEqual(32);
        expect(a).not.toBe(b);
    });
});
