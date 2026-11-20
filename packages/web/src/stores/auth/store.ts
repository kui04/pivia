import type { AuthLoginResponse, AuthLogoutResponse, AuthStatusResponse } from "@pivia/protocol";
import { create } from "zustand";

import { Log } from "@/lib/log";
import { ApiClientError, apiClient } from "@/lib/transport/http";

/** Authentication states of the single host. */
export type AuthPhase = "checking" | "unauthenticated" | "authenticated";

/** The HTTP operations the auth store needs. */
export interface AuthClient {
    getAuthStatus(): Promise<AuthStatusResponse>;
    login(password: string): Promise<AuthLoginResponse>;
    logout(): Promise<AuthLogoutResponse>;
}

/** What the auth gate and the workspace chrome read. */
export interface AuthState {
    /** `checking` also means the state is not known yet, including after a failed initial check. */
    readonly phase: AuthPhase;
    /** Whether the server protects its API with a password. */
    readonly authRequired: boolean;
    readonly submitting: boolean;
    /** The message the gate shows, or `null`. */
    readonly error: string | null;
    /** Seconds a `429` answer asked the client to wait. */
    readonly retryAfterSeconds: number | null;
}

/** What a caller may change in the auth store. */
export interface AuthActions {
    /** Reads `/api/auth/status`; concurrent callers share one request. */
    checkStatus: () => Promise<void>;
    login: (password: string) => Promise<void>;
    logout: () => Promise<void>;
    /** Drops to the gate after a protected endpoint answered `401`. */
    markUnauthorized: () => void;
    clearError: () => void;
}

export type AuthStore = AuthState & AuthActions;

export const initialAuthState: AuthState = {
    phase: "checking",
    authRequired: true,
    submitting: false,
    error: null,
    retryAfterSeconds: null,
};

/** Builds the message a `429` answer shows. */
export function formatRateLimitMessage(seconds: number | undefined): string {
    if (seconds === undefined || seconds <= 0) {
        return "Too many attempts. Try again later.";
    }
    const unit = seconds === 1 ? "second" : "seconds";
    return `Too many attempts. Try again in ${String(seconds)} ${unit}.`;
}

function errorMessage(error: unknown, fallback: string): string {
    if (error instanceof ApiClientError) {
        if (error.code === "rate_limited") {
            return formatRateLimitMessage(error.retryAfterSeconds);
        }
        if (error.code === "invalid_credentials") {
            return "Invalid password.";
        }
        return error.message;
    }
    if (error instanceof Error && error.message !== "") {
        return error.message;
    }
    return fallback;
}

function retryAfterOf(error: unknown): number | null {
    return error instanceof ApiClientError ? (error.retryAfterSeconds ?? null) : null;
}

/**
 * Creates the single-host auth store.
 *
 * `checkStatus` shares one in-flight request, so React StrictMode and a mount plus a retry cannot
 * race two answers into the phase. A failed check keeps the phase `checking` and records the
 * message, which lets the layout offer a retry instead of showing the password gate for a network
 * failure.
 */
export function createAuthStore(client: AuthClient = apiClient) {
    let statusRequest: Promise<void> | null = null;

    return create<AuthStore>()((set, get) => {
        const check = async (): Promise<void> => {
            set({ error: null, retryAfterSeconds: null });
            try {
                const status = await client.getAuthStatus();
                set({
                    phase: status.authenticated ? "authenticated" : "unauthenticated",
                    authRequired: status.authRequired,
                    error: null,
                    retryAfterSeconds: null,
                });
            } catch (error) {
                set({
                    error: errorMessage(error, "Cannot check the sign-in state."),
                    retryAfterSeconds: retryAfterOf(error),
                });
                Log.warn("Cannot check the authentication status", error);
            }
        };

        const checkStatus = (): Promise<void> => {
            if (statusRequest !== null) {
                return statusRequest;
            }
            statusRequest = check().finally(() => {
                statusRequest = null;
            });
            return statusRequest;
        };

        return {
            ...initialAuthState,
            checkStatus,
            login: async (password) => {
                if (get().submitting) {
                    return;
                }
                set({ submitting: true, error: null, retryAfterSeconds: null });
                try {
                    await client.login(password);
                    set({
                        phase: "authenticated",
                        submitting: false,
                        error: null,
                        retryAfterSeconds: null,
                    });
                } catch (error) {
                    set({
                        submitting: false,
                        error: errorMessage(error, "Cannot sign in."),
                        retryAfterSeconds: retryAfterOf(error),
                    });
                    Log.warn("Sign-in failed", error);
                }
            },
            logout: async () => {
                if (get().submitting) {
                    return;
                }
                set({ submitting: true, error: null, retryAfterSeconds: null });
                try {
                    await client.logout();
                    set({
                        phase: "unauthenticated",
                        submitting: false,
                        error: null,
                        retryAfterSeconds: null,
                    });
                } catch (error) {
                    set({
                        submitting: false,
                        error: errorMessage(error, "Cannot sign out."),
                        retryAfterSeconds: retryAfterOf(error),
                    });
                    Log.warn("Sign-out failed", error);
                }
            },
            markUnauthorized: () =>
                set({
                    phase: "unauthenticated",
                    submitting: false,
                    error: null,
                    retryAfterSeconds: null,
                }),
            clearError: () => set({ error: null, retryAfterSeconds: null }),
        };
    });
}

/** The app-wide auth store. */
export const useAuthStore = createAuthStore(apiClient);

apiClient.setUnauthorizedHandler(() => {
    useAuthStore.getState().markUnauthorized();
});
