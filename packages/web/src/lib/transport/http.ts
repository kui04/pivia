import {
    isRecord,
    parseAuthLoginResponse,
    parseAuthLogoutResponse,
    parseAuthStatusResponse,
    parseCloseSessionResponse,
    parseCreateSessionResponse,
    parseHealthResponse,
    parseSessionDetailResponse,
    parseSessionListResponse,
    PUBLIC_API_PATHS,
} from "@pivia/protocol";
import type {
    ApiErrorCode,
    ApiErrorResponse,
    AuthLoginResponse,
    AuthLogoutResponse,
    AuthStatusResponse,
    CloseSessionResponse,
    CreateSessionResponse,
    HealthResponse,
    JsonDecoder,
    SessionDetailResponse,
    SessionId,
    SessionListResponse,
    SessionPrefixAnchor,
} from "@pivia/protocol";

import { Log } from "@/lib/log";

/** A `fetch` implementation; injectable so unit tests do not open a network. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Options for {@link createApiClient}. */
export interface ApiClientOptions {
    /** Origin or prefix before every API path. Defaults to the current origin. */
    readonly baseUrl?: string | undefined;
    /** Request implementation. Defaults to the global `fetch`. */
    readonly fetch?: FetchLike | undefined;
    /**
     * Called when a protected endpoint answers `401`, so the auth store can drop to the
     * unauthenticated phase without every caller inspecting the error.
     */
    readonly onUnauthorized?: (() => void) | undefined;
}

/** Initial values for {@link ApiClientError}. */
export interface ApiClientErrorInit {
    /** HTTP status, or `0` when no response arrived. */
    readonly status: number;
    readonly code: ApiErrorCode;
    readonly message: string;
    /** Seconds from a `429` response `Retry-After` header. */
    readonly retryAfterSeconds?: number | undefined;
    /** Original network failure, when the request never reached the server. */
    readonly cause?: unknown;
}

/**
 * One failed API request.
 *
 * The `code` always uses the wire `ApiErrorCode` union. A response without a valid envelope
 * gets a fallback code from its status, so callers never have to parse the body themselves.
 */
export class ApiClientError extends Error {
    readonly status: number;
    readonly code: ApiErrorCode;
    readonly retryAfterSeconds: number | undefined;

    constructor(init: ApiClientErrorInit) {
        super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
        this.name = "ApiClientError";
        this.status = init.status;
        this.code = init.code;
        this.retryAfterSeconds = init.retryAfterSeconds;
    }
}

/** Optional incremental slice anchor and cancellation signal for {@link ApiClient.getSession}. */
export interface GetSessionOptions {
    readonly anchor?: SessionPrefixAnchor | undefined;
    readonly signal?: AbortSignal | undefined;
}

/** HTTP operations used by the auth and workspace stores. */
export interface ApiClient {
    getHealth(): Promise<HealthResponse>;
    getAuthStatus(): Promise<AuthStatusResponse>;
    login(password: string): Promise<AuthLoginResponse>;
    logout(): Promise<AuthLogoutResponse>;
    listSessions(): Promise<SessionListResponse>;
    createSession(cwd: string): Promise<CreateSessionResponse>;
    getSession(id: SessionId, options?: GetSessionOptions): Promise<SessionDetailResponse>;
    closeSession(id: SessionId): Promise<CloseSessionResponse>;
    /** Registers or clears the callback for `401` responses from protected endpoints and returns a disposer. */
    setUnauthorizedHandler(handler: (() => void) | null): () => void;
}

/** Endpoints that answer `401` as a normal result rather than an expired session. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(PUBLIC_API_PATHS);

const API_ERROR_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
    "invalid_request",
    "unauthorized",
    "invalid_credentials",
    "rate_limited",
    "not_found",
    "internal_error",
]);

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
    return (
        isRecord(value) &&
        typeof value.error === "string" &&
        API_ERROR_CODES.has(value.error) &&
        typeof value.message === "string"
    );
}

function fallbackCode(status: number): ApiErrorCode {
    switch (status) {
        case 400:
            return "invalid_request";
        case 401:
            return "unauthorized";
        case 404:
            return "not_found";
        case 429:
            return "rate_limited";
        default:
            return "internal_error";
    }
}

function fallbackMessage(response: Response): string {
    const statusText = response.statusText.trim();
    return statusText === ""
        ? `Request failed with status ${String(response.status)}.`
        : `${String(response.status)} ${statusText}`;
}

/** Reads a JSON body without letting a malformed or empty body hide the HTTP status. */
async function readBody(response: Response): Promise<unknown> {
    let text: string;
    try {
        text = await response.text();
    } catch {
        return undefined;
    }
    if (text.trim() === "") {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

/** Parses `Retry-After` seconds; a missing or non-numeric header yields `undefined`. */
function retryAfterSeconds(response: Response): number | undefined {
    const header = response.headers.get("Retry-After");
    if (header === null) {
        return undefined;
    }
    const trimmed = header.trim();
    if (!/^\d+$/.test(trimmed)) {
        return undefined;
    }
    const value = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(value) ? value : undefined;
}

function joinUrl(baseUrl: string, path: string): string {
    return baseUrl === "" ? path : `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

function pathnameOf(path: string): string {
    const queryIndex = path.indexOf("?");
    return queryIndex === -1 ? path : path.slice(0, queryIndex);
}

const ACCEPT_HEADERS: Readonly<Record<string, string>> = {
    Accept: "application/json",
};

const JSON_HEADERS: Readonly<Record<string, string>> = {
    ...ACCEPT_HEADERS,
    "Content-Type": "application/json",
};

/**
 * Creates the typed HTTP client for `/api/*`.
 *
 * Every request uses `credentials: "same-origin"` so the server's opaque session cookie travels
 * with it. A network failure becomes an {@link ApiClientError} with status `0`, because callers
 * should handle one error shape whether the server answered or could not be reached.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
    const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const baseUrl = options.baseUrl ?? "";
    let unauthorizedHandler = options.onUnauthorized;

    const notifyUnauthorized = (): void => {
        if (unauthorizedHandler === undefined) {
            return;
        }
        try {
            unauthorizedHandler();
        } catch (error) {
            // A broken listener must not replace the request error the caller is about to see.
            Log.warn("The unauthorized handler failed", error);
        }
    };

    const request = async <T>(path: string, init: RequestInit, decode: JsonDecoder<T>): Promise<T> => {
        let response: Response;
        try {
            response = await fetchImpl(joinUrl(baseUrl, path), {
                ...init,
                credentials: "same-origin",
            });
        } catch (cause) {
            throw new ApiClientError({
                status: 0,
                code: "internal_error",
                message: "Cannot reach the server.",
                cause,
            });
        }

        const publicPath = PUBLIC_PATHS.has(pathnameOf(path));
        if (response.status === 401 && !publicPath) {
            notifyUnauthorized();
        }

        if (!response.ok) {
            const body = await readBody(response);
            const retry = retryAfterSeconds(response);
            if (isApiErrorResponse(body)) {
                throw new ApiClientError({
                    status: response.status,
                    code: body.error,
                    message: body.message,
                    retryAfterSeconds: retry,
                });
            }
            throw new ApiClientError({
                status: response.status,
                code: fallbackCode(response.status),
                message: fallbackMessage(response),
                retryAfterSeconds: retry,
            });
        }

        const body = await readBody(response);
        if (body === undefined) {
            throw new ApiClientError({
                status: response.status,
                code: "internal_error",
                message: "The server returned an empty response.",
            });
        }
        const parsed = decode(body);
        if (parsed === null) {
            throw new ApiClientError({
                status: response.status,
                code: "internal_error",
                message: `The server returned an invalid response payload for ${pathnameOf(path)}.`,
            });
        }
        return parsed;
    };

    return {
        getHealth: () =>
            request<HealthResponse>("/api/health", { method: "GET", headers: ACCEPT_HEADERS }, parseHealthResponse),
        getAuthStatus: () =>
            request<AuthStatusResponse>(
                "/api/auth/status",
                { method: "GET", headers: ACCEPT_HEADERS },
                parseAuthStatusResponse,
            ),
        login: (password) =>
            request<AuthLoginResponse>(
                "/api/auth",
                {
                    method: "POST",
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ password }),
                },
                parseAuthLoginResponse,
            ),
        logout: () =>
            request<AuthLogoutResponse>(
                "/api/auth/logout",
                { method: "POST", headers: ACCEPT_HEADERS },
                parseAuthLogoutResponse,
            ),
        listSessions: () =>
            request<SessionListResponse>(
                "/api/sessions",
                { method: "GET", headers: ACCEPT_HEADERS },
                parseSessionListResponse,
            ),
        createSession: (cwd) =>
            request<CreateSessionResponse>(
                "/api/sessions",
                {
                    method: "POST",
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ cwd }),
                },
                parseCreateSessionResponse,
            ),
        getSession: (id, sessionOptions) => {
            const params = new URLSearchParams();
            const anchor = sessionOptions?.anchor;
            if (anchor !== undefined) {
                params.set("entriesVersion", anchor.entriesVersion);
                params.set("afterCount", String(anchor.afterCount));
                params.set("afterEntryId", anchor.afterEntryId);
            }
            const query = params.toString();
            const path =
                query === ""
                    ? `/api/sessions/${encodeURIComponent(id)}`
                    : `/api/sessions/${encodeURIComponent(id)}?${query}`;
            const init: RequestInit = { method: "GET", headers: ACCEPT_HEADERS };
            if (sessionOptions?.signal !== undefined) {
                init.signal = sessionOptions.signal;
            }
            return request<SessionDetailResponse>(path, init, parseSessionDetailResponse);
        },
        closeSession: (id) =>
            request<CloseSessionResponse>(
                `/api/sessions/${encodeURIComponent(id)}/close`,
                {
                    method: "POST",
                    headers: ACCEPT_HEADERS,
                },
                parseCloseSessionResponse,
            ),
        setUnauthorizedHandler: (handler) => {
            const next = handler ?? undefined;
            unauthorizedHandler = next;
            return () => {
                if (next !== undefined && unauthorizedHandler === next) {
                    unauthorizedHandler = undefined;
                }
            };
        },
    };
}

/** The app-wide client. Tests build their own with {@link createApiClient}. */
export const apiClient: ApiClient = createApiClient();
