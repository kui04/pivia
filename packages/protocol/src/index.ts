/** Health status payload returned by `GET /api/health`. */
export interface HealthResponse {
    readonly status: "ok";
    readonly version: string;
}

/** Standard JSON error envelope returned by HTTP endpoints. */
export interface ApiErrorResponse {
    readonly error: string;
    readonly message: string;
}
