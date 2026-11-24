/** Path prefix shared by all HTTP API routes. */
export const API_PATH_PREFIX = "/api/" as const;

/** Path prefix shared by all WebSocket routes. */
export const WS_PATH_PREFIX = "/ws/" as const;

/** HTTP methods used by API endpoint descriptors. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Base contract shared by every HTTP and WebSocket endpoint descriptor. */
export interface BaseEndpoint<TPattern extends string> {
    /** Fastify-compatible route pattern (e.g. `"/api/sessions/:id"`). */
    readonly pattern: TPattern;
}

/** Endpoint with no path parameters and no query parameters. */
export interface StaticEndpoint<TPattern extends string> extends BaseEndpoint<TPattern> {
    buildPath(): TPattern;
}

/** Endpoint with no path parameters and optional query parameters. */
export interface QueryEndpoint<TPattern extends string, TQuery, TParsedQuery = TQuery> extends BaseEndpoint<TPattern> {
    buildPath(query?: TQuery): string;
    encodeQuery(query?: TQuery): URLSearchParams;
    parseQuery(raw: unknown): TParsedQuery;
}

/** Endpoint with typed path parameters and no query parameters. */
export interface ParamsEndpoint<TPattern extends string, TParams> extends BaseEndpoint<TPattern> {
    buildPath(params: TParams): string;
    parseParams(raw: unknown): TParams | null;
}

/** Endpoint with both typed path parameters and optional query parameters. */
export interface ParamsQueryEndpoint<
    TPattern extends string,
    TParams,
    TQuery,
    TParsedQuery = TQuery,
> extends BaseEndpoint<TPattern> {
    buildPath(params: TParams, query?: TQuery): string;
    parseParams(raw: unknown): TParams | null;
    encodeQuery(query?: TQuery): URLSearchParams;
    parseQuery(raw: unknown): TParsedQuery;
}

/** HTTP-specific metadata carried by every HTTP endpoint descriptor. */
export interface HttpEndpointMeta<TMethod extends HttpMethod, TPublic extends boolean> {
    readonly method: TMethod;
    /** True when the endpoint is reachable without authentication (for example login and health checks). */
    readonly public: TPublic;
}

/** Static HTTP endpoint descriptor. */
export type HttpStaticEndpoint<
    TPattern extends string,
    TMethod extends HttpMethod,
    TPublic extends boolean,
> = StaticEndpoint<TPattern> & HttpEndpointMeta<TMethod, TPublic>;

/** Query-bearing HTTP endpoint descriptor. */
export type HttpQueryEndpoint<
    TPattern extends string,
    TMethod extends HttpMethod,
    TPublic extends boolean,
    TQuery,
    TParsedQuery = TQuery,
> = QueryEndpoint<TPattern, TQuery, TParsedQuery> & HttpEndpointMeta<TMethod, TPublic>;

/** Path-parameterized HTTP endpoint descriptor. */
export type HttpParamsEndpoint<
    TPattern extends string,
    TMethod extends HttpMethod,
    TPublic extends boolean,
    TParams,
> = ParamsEndpoint<TPattern, TParams> & HttpEndpointMeta<TMethod, TPublic>;

/** Path- and query-parameterized HTTP endpoint descriptor. */
export type HttpParamsQueryEndpoint<
    TPattern extends string,
    TMethod extends HttpMethod,
    TPublic extends boolean,
    TParams,
    TQuery,
    TParsedQuery = TQuery,
> = ParamsQueryEndpoint<TPattern, TParams, TQuery, TParsedQuery> & HttpEndpointMeta<TMethod, TPublic>;

/** Query-bearing WebSocket endpoint descriptor. */
export type WsQueryEndpoint<TPattern extends string, TQuery, TParsedQuery = TQuery> = QueryEndpoint<
    TPattern,
    TQuery,
    TParsedQuery
>;

/** Path- and query-parameterized WebSocket endpoint descriptor. */
export type WsParamsQueryEndpoint<
    TPattern extends string,
    TParams,
    TQuery,
    TParsedQuery = TQuery,
> = ParamsQueryEndpoint<TPattern, TParams, TQuery, TParsedQuery>;

/** Append serialized query parameters to a pathname when non-empty. */
export function appendQuery(pathname: string, params: URLSearchParams): string {
    const query = params.toString();
    return query === "" ? pathname : `${pathname}?${query}`;
}
