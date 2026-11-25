import type { AuthStatusResponse } from "@pivia/protocol";
import { describe, expect, it, vi } from "vitest";

import { Log } from "@/lib";
import { ApiClientError } from "@/lib/transport/http";

import { createAuthStore, formatRateLimitMessage, initialAuthState, type AuthClient } from "./store";

function authClient(overrides: Partial<AuthClient> = {}): AuthClient {
    return {
        getAuthStatus: vi.fn(() => Promise.resolve({ authRequired: true, authenticated: false })),
        login: vi.fn(() => Promise.resolve({ authenticated: true as const })),
        logout: vi.fn(() => Promise.resolve({ authenticated: false as const })),
        ...overrides,
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("formatRateLimitMessage", () => {
    it("names the wait and handles singular, zero and missing values", () => {
        expect(formatRateLimitMessage(1)).toBe("Too many attempts. Try again in 1 second.");
        expect(formatRateLimitMessage(30)).toBe("Too many attempts. Try again in 30 seconds.");
        expect(formatRateLimitMessage(0)).toBe("Too many attempts. Try again later.");
        expect(formatRateLimitMessage(undefined)).toBe("Too many attempts. Try again later.");
    });
});

describe("createAuthStore", () => {
    it("starts while the status is unknown", () => {
        const store = createAuthStore(authClient());
        expect(store.getState()).toMatchObject(initialAuthState);
    });

    it("moves to the password gate when the server requires auth", async () => {
        const getAuthStatus = vi.fn(() => Promise.resolve({ authRequired: true, authenticated: false }));
        const store = createAuthStore(authClient({ getAuthStatus }));

        await store.getState().checkStatus();

        expect(getAuthStatus).toHaveBeenCalledOnce();
        expect(store.getState()).toMatchObject({
            phase: "unauthenticated",
            authRequired: true,
            error: null,
            retryAfterSeconds: null,
        });
    });

    it("enters the workspace when auth is disabled or already authenticated", async () => {
        const store = createAuthStore(
            authClient({ getAuthStatus: vi.fn(() => Promise.resolve({ authRequired: false, authenticated: true })) }),
        );

        await store.getState().checkStatus();

        expect(store.getState().phase).toBe("authenticated");
        expect(store.getState().authRequired).toBe(false);
    });

    it("shares one in-flight status request", async () => {
        const status = deferred<AuthStatusResponse>();
        const getAuthStatus = vi.fn(() => status.promise);
        const store = createAuthStore(authClient({ getAuthStatus }));

        const first = store.getState().checkStatus();
        const second = store.getState().checkStatus();

        expect(getAuthStatus).toHaveBeenCalledOnce();

        status.resolve({ authRequired: true, authenticated: true });
        await Promise.all([first, second]);

        expect(store.getState().phase).toBe("authenticated");
    });

    it("keeps checking and exposes the error when the status request fails", async () => {
        const getAuthStatus = vi
            .fn<() => Promise<AuthStatusResponse>>()
            .mockRejectedValueOnce(
                new ApiClientError({ status: 0, code: "internal_error", message: "Cannot reach the server." }),
            )
            .mockResolvedValueOnce({ authRequired: true, authenticated: true });
        const store = createAuthStore(authClient({ getAuthStatus }));

        await store.getState().checkStatus();

        expect(store.getState()).toMatchObject({
            phase: "checking",
            error: "Cannot reach the server.",
            retryAfterSeconds: null,
        });

        await store.getState().checkStatus();

        expect(store.getState()).toMatchObject({ phase: "authenticated", error: null });
        expect(getAuthStatus).toHaveBeenCalledTimes(2);
    });

    it("shows submitting while login is in flight and then authenticates", async () => {
        const login = deferred<{ readonly authenticated: true }>();
        const store = createAuthStore(authClient({ login: vi.fn(() => login.promise) }));

        const request = store.getState().login("secret");

        expect(store.getState()).toMatchObject({ submitting: true, error: null });

        login.resolve({ authenticated: true });
        await request;

        expect(store.getState()).toMatchObject({
            phase: "authenticated",
            submitting: false,
            error: null,
        });
    });

    it("names an invalid password and keeps the gate", async () => {
        const store = createAuthStore(
            authClient({
                login: vi.fn(() =>
                    Promise.reject(
                        new ApiClientError({ status: 401, code: "invalid_credentials", message: "Invalid password." }),
                    ),
                ),
            }),
        );

        await store.getState().login("wrong");

        expect(store.getState()).toMatchObject({
            phase: "checking",
            submitting: false,
            error: "Invalid password.",
            retryAfterSeconds: null,
        });
    });

    it("records Retry-After seconds when login is rate limited", async () => {
        const store = createAuthStore(
            authClient({
                login: vi.fn(() =>
                    Promise.reject(
                        new ApiClientError({
                            status: 429,
                            code: "rate_limited",
                            message: "Too many failed login attempts. Try again later.",
                            retryAfterSeconds: 30,
                        }),
                    ),
                ),
            }),
        );

        await store.getState().login("wrong");

        const state = store.getState();
        expect(state.submitting).toBe(false);
        expect(state.retryAfterSeconds).toBe(30);
        expect(state.error).toBe("Too many attempts. Try again in 30 seconds.");
    });

    it("reports a network failure on login", async () => {
        const store = createAuthStore(
            authClient({
                login: vi.fn(() =>
                    Promise.reject(
                        new ApiClientError({ status: 0, code: "internal_error", message: "Cannot reach the server." }),
                    ),
                ),
            }),
        );

        await store.getState().login("secret");

        expect(store.getState()).toMatchObject({
            submitting: false,
            error: "Cannot reach the server.",
        });
    });

    it("returns to the gate after logout and keeps the session on a failure", async () => {
        const store = createAuthStore(authClient());
        await store.getState().checkStatus();
        await store.getState().login("secret");
        expect(store.getState().phase).toBe("authenticated");

        await store.getState().logout();

        expect(store.getState().phase).toBe("unauthenticated");
        expect(store.getState().error).toBeNull();

        const failing = createAuthStore(
            authClient({
                logout: vi.fn(() =>
                    Promise.reject(
                        new ApiClientError({ status: 0, code: "internal_error", message: "Cannot reach the server." }),
                    ),
                ),
            }),
        );
        await failing.getState().login("secret");
        await failing.getState().logout();

        expect(failing.getState()).toMatchObject({
            phase: "authenticated",
            submitting: false,
            error: "Cannot reach the server.",
        });
    });

    it("marks an expired session unauthorized and clears its error", async () => {
        const store = createAuthStore(authClient());
        await store.getState().login("secret");

        store.getState().markUnauthorized();

        expect(store.getState()).toMatchObject({
            phase: "unauthenticated",
            submitting: false,
            error: null,
            retryAfterSeconds: null,
        });

        store.setState({ error: "Invalid password.", retryAfterSeconds: 5 });
        store.getState().clearError();

        expect(store.getState()).toMatchObject({ error: null, retryAfterSeconds: null });
    });

    it("clears memory and persisted session caches on logout and markUnauthorized", async () => {
        const clearAll = vi.fn(() => Promise.resolve());
        const onClearSessionMemory = vi.fn();
        const store = createAuthStore(authClient(), {
            cache: { clearAll },
            onClearSessionMemory,
        });

        await store.getState().login("secret");
        await store.getState().logout();
        expect(onClearSessionMemory).toHaveBeenCalledTimes(1);
        expect(clearAll).toHaveBeenCalledTimes(1);

        await store.getState().login("secret");
        store.getState().markUnauthorized();
        expect(onClearSessionMemory).toHaveBeenCalledTimes(2);
        expect(clearAll).toHaveBeenCalledTimes(2);
    });

    it("still transitions to unauthenticated and logs warnings if cache clearing throws or rejects", async () => {
        const warnSpy = vi.spyOn(Log, "warn").mockImplementation(() => {});
        const store = createAuthStore(authClient(), {
            cache: {
                clearAll: vi.fn(() => Promise.reject(new Error("IDB failure"))),
            },
            onClearSessionMemory: () => {
                throw new Error("Memory clear failure");
            },
        });

        await store.getState().login("secret");
        await store.getState().logout();
        expect(store.getState().phase).toBe("unauthenticated");

        await store.getState().login("secret");
        store.getState().markUnauthorized();
        expect(store.getState().phase).toBe("unauthenticated");

        await vi.waitFor(() => {
            expect(warnSpy).toHaveBeenCalledTimes(4);
        });
        warnSpy.mockRestore();
    });
});
