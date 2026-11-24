/** Health status payload returned by `GET /api/health`. */
export interface HealthResponse {
    readonly status: "ok";
    readonly version: string;
}

/** Machine-readable error codes returned by HTTP endpoints. */
export type ApiErrorCode =
    | "invalid_request"
    | "unauthorized"
    | "invalid_credentials"
    | "rate_limited"
    | "not_found"
    | "directory_not_found"
    | "internal_error";

/** Standard JSON error envelope returned by HTTP endpoints. */
export interface ApiErrorResponse {
    readonly error: ApiErrorCode;
    readonly message: string;
}

/** Authentication state returned by `GET /api/auth/status`. */
export interface AuthStatusResponse {
    readonly authRequired: boolean;
    readonly authenticated: boolean;
}

/** Request payload accepted by `POST /api/auth`. */
export interface AuthLoginRequest {
    readonly password: string;
}

/** Response payload returned by `POST /api/auth` on success. */
export interface AuthLoginResponse {
    readonly authenticated: true;
}

/** Response payload returned by `POST /api/auth/logout`. */
export interface AuthLogoutResponse {
    readonly authenticated: false;
}

/** Query parameters accepted by `GET /api/fs/directories`. */
export interface DirectoryListQuery {
    /** Optional absolute directory path on the server; omitted or blank defaults to the server working directory. */
    readonly path?: string | undefined;
}

/** Response payload returned by `GET /api/fs/directories`. */
export interface DirectoryListResponse {
    /** Canonical resolved directory path on the server. */
    readonly path: string;
    /** Parent directory path, or `null` at the filesystem root. */
    readonly parent: string | null;
    /** Immediate subdirectory names inside `path`, sorted case-insensitively. */
    readonly directories: readonly string[];
    /** True when `path` holds more subdirectories than the server returns in `directories`. */
    readonly truncated: boolean;
}
