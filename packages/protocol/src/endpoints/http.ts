import {
    encodeSessionPrefixAnchorQuery,
    parseSessionPathParams,
    parseSessionPrefixAnchor,
    type SessionPathParams,
    type SessionPrefixAnchor,
} from "../sessions/ids.ts";
import {
    appendQuery,
    type HttpParamsEndpoint,
    type HttpParamsQueryEndpoint,
    type HttpQueryEndpoint,
    type HttpStaticEndpoint,
} from "../shared/endpoint.ts";
import { encodeDirectoryListQuery, parseDirectoryListQuery } from "../system/codec.ts";
import type { DirectoryListQuery } from "../system/types.ts";

/** Single source of truth for every HTTP endpoint path, method, auth visibility, and param/query codec. */
export const HTTP_ENDPOINTS = {
    health: {
        method: "GET",
        pattern: "/api/health",
        public: true,
        buildPath: () => "/api/health",
    } satisfies HttpStaticEndpoint<"/api/health", "GET", true>,

    authStatus: {
        method: "GET",
        pattern: "/api/auth/status",
        public: true,
        buildPath: () => "/api/auth/status",
    } satisfies HttpStaticEndpoint<"/api/auth/status", "GET", true>,

    authLogin: {
        method: "POST",
        pattern: "/api/auth",
        public: true,
        buildPath: () => "/api/auth",
    } satisfies HttpStaticEndpoint<"/api/auth", "POST", true>,

    authLogout: {
        method: "POST",
        pattern: "/api/auth/logout",
        public: true,
        buildPath: () => "/api/auth/logout",
    } satisfies HttpStaticEndpoint<"/api/auth/logout", "POST", true>,

    listDirectories: {
        method: "GET",
        pattern: "/api/fs/directories",
        public: false,
        buildPath: (query?: DirectoryListQuery) => appendQuery("/api/fs/directories", encodeDirectoryListQuery(query)),
        encodeQuery: encodeDirectoryListQuery,
        parseQuery: parseDirectoryListQuery,
    } satisfies HttpQueryEndpoint<"/api/fs/directories", "GET", false, DirectoryListQuery>,

    listSessions: {
        method: "GET",
        pattern: "/api/sessions",
        public: false,
        buildPath: () => "/api/sessions",
    } satisfies HttpStaticEndpoint<"/api/sessions", "GET", false>,

    createSession: {
        method: "POST",
        pattern: "/api/sessions",
        public: false,
        buildPath: () => "/api/sessions",
    } satisfies HttpStaticEndpoint<"/api/sessions", "POST", false>,

    sessionDetail: {
        method: "GET",
        pattern: "/api/sessions/:id",
        public: false,
        buildPath: (params: SessionPathParams, query?: SessionPrefixAnchor) =>
            appendQuery(`/api/sessions/${encodeURIComponent(params.id)}`, encodeSessionPrefixAnchorQuery(query)),
        parseParams: parseSessionPathParams,
        encodeQuery: encodeSessionPrefixAnchorQuery,
        parseQuery: parseSessionPrefixAnchor,
    } satisfies HttpParamsQueryEndpoint<
        "/api/sessions/:id",
        "GET",
        false,
        SessionPathParams,
        SessionPrefixAnchor,
        SessionPrefixAnchor | undefined
    >,

    closeSession: {
        method: "POST",
        pattern: "/api/sessions/:id/close",
        public: false,
        buildPath: (params: SessionPathParams) => `/api/sessions/${encodeURIComponent(params.id)}/close`,
        parseParams: parseSessionPathParams,
    } satisfies HttpParamsEndpoint<"/api/sessions/:id/close", "POST", false, SessionPathParams>,
} as const;

/** Key union of all registered HTTP endpoints. */
export type HttpEndpointKey = keyof typeof HTTP_ENDPOINTS;

/** Union of all registered HTTP endpoint descriptors. */
export type HttpEndpoint = (typeof HTTP_ENDPOINTS)[HttpEndpointKey];

/** Literal union of HTTP endpoint patterns that stay public so the login gate can be reached. */
export type PublicApiPath = Extract<HttpEndpoint, { readonly public: true }>["pattern"];

/** API endpoints that stay public so the login gate can be reached, derived from {@link HTTP_ENDPOINTS}. */
export const PUBLIC_API_PATHS: readonly PublicApiPath[] = Object.values(HTTP_ENDPOINTS)
    .filter((endpoint): endpoint is Extract<HttpEndpoint, { readonly public: true }> => endpoint.public)
    .map((endpoint) => endpoint.pattern);
