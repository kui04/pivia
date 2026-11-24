import {
    parseEntriesVersion,
    parseSessionId,
    type EntriesVersion,
    type SessionId,
    type SessionSummary,
} from "@pivia/protocol";
import { describe, expect, it, vi } from "vitest";

import { ApiClientError, createApiClient, type FetchLike } from "./http";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

function ev(raw: string): EntriesVersion {
    const parsed = parseEntriesVersion(raw);
    if (parsed === null) {
        throw new Error(`Invalid test entries version: ${raw}`);
    }
    return parsed;
}

function summary(id = "s1"): SessionSummary {
    return {
        id: sid(id),
        cwd: "/home/u/project",
        name: null,
        firstMessage: "hi",
        messageCount: 1,
        createdAtMs: 1_000,
        modifiedAtMs: 2_000,
        hasParent: false,
        runtimeState: "idle",
        attachedClients: 0,
    };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    });
}

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}

/** Reads the URL the client passed, without stringifying a Request object. */
function urlString(input: RequestInfo | URL): string {
    if (typeof input === "string") {
        return input;
    }
    return input instanceof URL ? input.href : input.url;
}

function recordingFetch(response: Response): { fetch: FetchLike; calls: RequestInit[] } {
    const calls: RequestInit[] = [];
    const fetchImpl: FetchLike = (input, init) => {
        void input;
        calls.push(init ?? {});
        return Promise.resolve(response);
    };
    return { fetch: fetchImpl, calls };
}

describe("createApiClient", () => {
    it("sends same-origin requests and returns the typed health response", async () => {
        const seen: { url: string; init: RequestInit | undefined }[] = [];
        const fetchImpl: FetchLike = (url, init) => {
            seen.push({ url: urlString(url), init });
            return Promise.resolve(jsonResponse({ status: "ok", version: "0.1.0" }));
        };
        const client = createApiClient({ fetch: fetchImpl });

        const health = await client.getHealth();

        expect(health).toEqual({ status: "ok", version: "0.1.0" });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.url).toBe("/api/health");
        expect(seen[0]?.init).toMatchObject({ method: "GET", credentials: "same-origin" });
    });

    it("prefixes the paths with a configured base URL and encodes session ids", async () => {
        const urls: string[] = [];
        const fetchImpl: FetchLike = (url) => {
            urls.push(urlString(url));
            return Promise.resolve(
                jsonResponse({ sessions: [], updatedAtMs: 0, cursor: { epoch: "epoch-1", seq: 0 } }),
            );
        };
        const client = createApiClient({ baseUrl: "https://example.test/", fetch: fetchImpl });

        await client.listSessions();

        expect(urls[0]).toBe("https://example.test/api/sessions");

        const detailFetch: FetchLike = (url) => {
            urls.push(urlString(url));
            if (urlString(url).endsWith("/close")) {
                return Promise.resolve(jsonResponse({ closed: true }));
            }
            return Promise.resolve(
                jsonResponse({
                    session: summary("session.1_a-b"),
                    entriesVersion: "3:1.5.2",
                    baseEntryCount: 0,
                    entries: [],
                }),
            );
        };
        const detailClient = createApiClient({ fetch: detailFetch });
        await detailClient.getSession(sid("session.1_a-b"));
        await detailClient.closeSession(sid("session.1_a-b"));

        expect(urls[1]).toBe("/api/sessions/session.1_a-b");
        expect(urls[2]).toBe("/api/sessions/session.1_a-b/close");
    });

    it("posts the login body as JSON and resolves the login response", async () => {
        const seen: RequestInit[] = [];
        const fetchImpl: FetchLike = (_url, init) => {
            seen.push(init ?? {});
            return Promise.resolve(jsonResponse({ authenticated: true }));
        };
        const client = createApiClient({ fetch: fetchImpl });

        const response = await client.login("correct horse");

        expect(response).toEqual({ authenticated: true });
        expect(seen[0]).toMatchObject({ method: "POST", credentials: "same-origin" });
        expect(seen[0]?.headers).toEqual({ Accept: "application/json", "Content-Type": "application/json" });
        expect(seen[0]?.body).toBe(JSON.stringify({ password: "correct horse" }));
    });

    it("omits Content-Type on bodyless requests so Fastify does not reject them", async () => {
        const requests: RequestInit[] = [];
        const fetchImpl: FetchLike = (url, init) => {
            requests.push(init ?? {});
            const path = urlString(url);
            if (path === "/api/auth/logout") {
                return Promise.resolve(jsonResponse({ authenticated: false }));
            }
            if (path.endsWith("/close")) {
                return Promise.resolve(jsonResponse({ closed: true }));
            }
            return Promise.resolve(jsonResponse({ authRequired: true, authenticated: false }));
        };
        const client = createApiClient({ fetch: fetchImpl });

        await client.getAuthStatus();
        await client.logout();
        await client.closeSession(sid("s1"));

        expect(requests).toHaveLength(3);
        for (const init of requests) {
            expect(init.headers).toEqual({ Accept: "application/json" });
            expect(init.body).toBeUndefined();
        }
    });

    it("creates and closes sessions with the typed payloads", async () => {
        const createdSummary = summary("s1");
        const requests: { url: string; init: RequestInit | undefined }[] = [];
        const fetchImpl: FetchLike = (url, init) => {
            requests.push({ url: urlString(url), init });
            if (urlString(url).endsWith("/close")) {
                return Promise.resolve(jsonResponse({ closed: true }));
            }
            return Promise.resolve(jsonResponse({ session: createdSummary }));
        };
        const client = createApiClient({ fetch: fetchImpl });

        const created = await client.createSession("/home/u/project");
        const closed = await client.closeSession(sid("s1"));

        expect(created).toEqual({ session: createdSummary });
        expect(closed).toEqual({ closed: true });
        expect(requests[0]?.url).toBe("/api/sessions");
        expect(requests[0]?.init?.body).toBe(JSON.stringify({ cwd: "/home/u/project" }));
        expect(requests[1]?.url).toBe("/api/sessions/s1/close");
        expect(requests[1]?.init?.method).toBe("POST");
    });

    it("forwards createDirectory on createSession and decodes directory_not_found", async () => {
        const createdSummary = summary("s1");
        const requests: { url: string; init: RequestInit | undefined }[] = [];
        const fetchImpl: FetchLike = (url, init) => {
            requests.push({ url: urlString(url), init });
            if (requests.length === 1) {
                return Promise.resolve(
                    errorResponse(400, {
                        error: "directory_not_found",
                        message: "Working directory does not exist.",
                    }),
                );
            }
            return Promise.resolve(jsonResponse({ session: createdSummary }));
        };
        const client = createApiClient({ fetch: fetchImpl });

        await expect(client.createSession("/home/u/missing")).rejects.toMatchObject({
            status: 400,
            code: "directory_not_found",
            message: "Working directory does not exist.",
        });

        const created = await client.createSession("/home/u/missing", { createDirectory: true });
        expect(created).toEqual({ session: createdSummary });
        expect(requests[1]?.init?.body).toBe(JSON.stringify({ cwd: "/home/u/missing", createDirectory: true }));
    });

    it("lists host directories with optional path query encoding", async () => {
        const seenUrls: string[] = [];
        const fetchImpl: FetchLike = (url) => {
            seenUrls.push(urlString(url));
            return Promise.resolve(
                jsonResponse({
                    path: "/home/u/projects",
                    parent: "/home/u",
                    directories: [".git", "pivia"],
                    truncated: false,
                }),
            );
        };
        const client = createApiClient({ fetch: fetchImpl });

        const rootListing = await client.listDirectories();
        const nestedListing = await client.listDirectories("/home/u/my projects");

        expect(seenUrls).toEqual(["/api/fs/directories", "/api/fs/directories?path=%2Fhome%2Fu%2Fmy+projects"]);
        expect(rootListing).toEqual({
            path: "/home/u/projects",
            parent: "/home/u",
            directories: [".git", "pivia"],
            truncated: false,
        });
        expect(nestedListing.directories).toEqual([".git", "pivia"]);
    });

    it("turns a standard error envelope into ApiClientError", async () => {
        const { fetch } = recordingFetch(
            errorResponse(401, { error: "unauthorized", message: "Authentication required." }),
        );
        const client = createApiClient({ fetch });

        const failure = client.listSessions();

        await expect(failure).rejects.toBeInstanceOf(ApiClientError);
        await expect(failure).rejects.toMatchObject({
            status: 401,
            code: "unauthorized",
            message: "Authentication required.",
            retryAfterSeconds: undefined,
        });
    });

    it("reads Retry-After seconds from a 429 response", async () => {
        const { fetch } = recordingFetch(
            errorResponse(429, { error: "rate_limited", message: "Too many attempts." }, { "Retry-After": "30" }),
        );
        const client = createApiClient({ fetch });

        await expect(client.login("bad")).rejects.toMatchObject({
            status: 429,
            code: "rate_limited",
            retryAfterSeconds: 30,
        });
    });

    it("ignores a non-numeric or missing Retry-After header", async () => {
        const invalid = recordingFetch(
            errorResponse(429, { error: "rate_limited", message: "Too many attempts." }, { "Retry-After": "later" }),
        );
        await expect(createApiClient({ fetch: invalid.fetch }).login("bad")).rejects.toMatchObject({
            retryAfterSeconds: undefined,
        });

        const missing = recordingFetch(errorResponse(429, { error: "rate_limited", message: "Too many attempts." }));
        await expect(createApiClient({ fetch: missing.fetch }).login("bad")).rejects.toMatchObject({
            retryAfterSeconds: undefined,
        });
    });

    it("falls back to a canonical error for an unexpected body", async () => {
        const { fetch } = recordingFetch(errorResponse(502, "<html>bad gateway</html>"));
        const client = createApiClient({ fetch });

        await expect(client.listSessions()).rejects.toMatchObject({
            status: 502,
            code: "internal_error",
            message: "Request failed with status 502.",
        });
    });

    it("reports a network failure with status 0", async () => {
        const fetchImpl: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
        const client = createApiClient({ fetch: fetchImpl });

        await expect(client.getAuthStatus()).rejects.toMatchObject({
            status: 0,
            code: "internal_error",
            message: "Cannot reach the server.",
        });
    });

    it("rejects a successful response without a body", async () => {
        const fetchImpl: FetchLike = () => Promise.resolve(new Response(null, { status: 204 }));
        const client = createApiClient({ fetch: fetchImpl });

        await expect(client.logout()).rejects.toMatchObject({
            status: 204,
            code: "internal_error",
            message: "The server returned an empty response.",
        });
    });

    it("notifies the unauthorized handler only for protected endpoints", async () => {
        const onUnauthorized = vi.fn();
        const fetchImpl: FetchLike = (url) => {
            const path = urlString(url);
            if (path === "/api/sessions") {
                return Promise.resolve(
                    errorResponse(401, { error: "unauthorized", message: "Authentication required." }),
                );
            }
            return Promise.resolve(errorResponse(401, { error: "invalid_credentials", message: "Invalid password." }));
        };
        const client = createApiClient({ fetch: fetchImpl, onUnauthorized });

        await expect(client.listSessions()).rejects.toBeInstanceOf(ApiClientError);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);

        await expect(client.login("bad")).rejects.toBeInstanceOf(ApiClientError);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);

        client.setUnauthorizedHandler(null);
        await expect(client.listSessions()).rejects.toBeInstanceOf(ApiClientError);
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("keeps the request error when the unauthorized handler throws", async () => {
        const fetchImpl: FetchLike = () =>
            Promise.resolve(errorResponse(401, { error: "unauthorized", message: "Authentication required." }));
        const client = createApiClient({
            fetch: fetchImpl,
            onUnauthorized: () => {
                throw new Error("listener failed");
            },
        });

        await expect(client.listSessions()).rejects.toMatchObject({
            status: 401,
            code: "unauthorized",
        });
    });

    it("appends incremental slice query parameters and forwards AbortSignal on getSession", async () => {
        const seen: { url: string; signal: AbortSignal | null | undefined }[] = [];
        const fetchImpl: FetchLike = (url, init) => {
            seen.push({ url: urlString(url), signal: init?.signal });
            return Promise.resolve(
                jsonResponse({ session: summary("s1"), entriesVersion: "3:1.5.2", baseEntryCount: 2, entries: [] }),
            );
        };
        const client = createApiClient({ fetch: fetchImpl });
        const controller = new AbortController();

        await client.getSession(sid("s1"), {
            anchor: {
                entriesVersion: ev("3:1.5.2"),
                afterCount: 2,
                afterEntryId: "e1",
            },
            signal: controller.signal,
        });

        expect(seen[0]?.url).toBe("/api/sessions/s1?entriesVersion=3%3A1.5.2&afterCount=2&afterEntryId=e1");
        expect(seen[0]?.signal).toBe(controller.signal);
    });

    it("rejects a 200 response whose JSON shape fails boundary decoding", async () => {
        const { fetch } = recordingFetch(jsonResponse({ status: "wrong", version: 42 }));
        const client = createApiClient({ fetch });

        await expect(client.getHealth()).rejects.toMatchObject({
            status: 200,
            code: "internal_error",
            message: "The server returned an invalid response payload for /api/health.",
        });
    });
});
