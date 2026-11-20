import { describe, expect, it, vi } from "vitest";

import { ApiClientError, createApiClient, type FetchLike } from "./http";

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
            return Promise.resolve(jsonResponse({ sessions: [], scannedAtMs: 0 }));
        };
        const client = createApiClient({ baseUrl: "https://example.test/", fetch: fetchImpl });

        await client.listSessions();

        expect(urls[0]).toBe("https://example.test/api/sessions");

        const detailFetch: FetchLike = (url) => {
            urls.push(urlString(url));
            return Promise.resolve(jsonResponse({ session: {}, entries: [] }));
        };
        const detailClient = createApiClient({ fetch: detailFetch });
        await detailClient.getSession("a/b ?c");
        await detailClient.closeSession("a/b ?c");

        expect(urls[1]).toBe("/api/sessions/a%2Fb%20%3Fc");
        expect(urls[2]).toBe("/api/sessions/a%2Fb%20%3Fc/close");
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
        await client.closeSession("s1");

        expect(requests).toHaveLength(3);
        for (const init of requests) {
            expect(init.headers).toEqual({ Accept: "application/json" });
            expect(init.body).toBeUndefined();
        }
    });

    it("creates and closes sessions with the typed payloads", async () => {
        const requests: { url: string; init: RequestInit | undefined }[] = [];
        const fetchImpl: FetchLike = (url, init) => {
            requests.push({ url: urlString(url), init });
            return Promise.resolve(jsonResponse({ session: { id: "s1" }, closed: true }));
        };
        const client = createApiClient({ fetch: fetchImpl });

        const created = await client.createSession("/home/u/project");
        const closed = await client.closeSession("s1");

        expect(created).toEqual({ session: { id: "s1" }, closed: true });
        expect(closed).toEqual({ session: { id: "s1" }, closed: true });
        expect(requests[0]?.url).toBe("/api/sessions");
        expect(requests[0]?.init?.body).toBe(JSON.stringify({ cwd: "/home/u/project" }));
        expect(requests[1]?.url).toBe("/api/sessions/s1/close");
        expect(requests[1]?.init?.method).toBe("POST");
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
});
