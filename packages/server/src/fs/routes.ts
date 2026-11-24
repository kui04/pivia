import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { HTTP_ENDPOINTS, type DirectoryListResponse } from "@pivia/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendApiError } from "../http/errors.ts";

/** Options for {@link registerFsRoutes}. */
export interface FsRoutesOptions {
    /** Default starting directory when `GET /api/fs/directories` omits `path`. Defaults to `process.cwd()`. */
    readonly defaultDir?: string | undefined;
}

/** Maximum number of subdirectory names one listing returns. */
const MAX_LISTED_DIRECTORIES = 1000;

/** Maximum number of symlinks whose targets are checked at once. */
const SYMLINK_STAT_CONCURRENCY = 8;

function isEnoentError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function isDirectoryLink(realPath: string, name: string): Promise<boolean> {
    try {
        return (await stat(join(realPath, name))).isDirectory();
    } catch {
        // A broken or unreadable symlink is not a subdirectory the browser can enter.
        return false;
    }
}

async function collectSubdirectories(realPath: string): Promise<string[]> {
    const entries = await readdir(realPath, { withFileTypes: true });
    const directories: string[] = [];
    const symlinks: string[] = [];
    for (const entry of entries) {
        if (entry.isDirectory()) {
            directories.push(entry.name);
        } else if (entry.isSymbolicLink()) {
            symlinks.push(entry.name);
        }
    }

    // Check link targets in bounded batches so a directory full of links cannot open one request per link.
    for (let start = 0; start < symlinks.length; start += SYMLINK_STAT_CONCURRENCY) {
        const batch = symlinks.slice(start, start + SYMLINK_STAT_CONCURRENCY);
        const results = await Promise.all(batch.map((name) => isDirectoryLink(realPath, name)));
        for (let index = 0; index < batch.length; index += 1) {
            const name = batch[index];
            if (name !== undefined && results[index] === true) {
                directories.push(name);
            }
        }
    }

    directories.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
    return directories;
}

/**
 * Register `/api/fs/*` routes for browsing host directories when starting a new session.
 */
export function registerFsRoutes(app: FastifyInstance, options: FsRoutesOptions = {}): void {
    app.get(
        HTTP_ENDPOINTS.listDirectories.pattern,
        async (request, reply): Promise<DirectoryListResponse | FastifyReply> => {
            const query = HTTP_ENDPOINTS.listDirectories.parseQuery(request.query);
            const targetPath = query.path ?? options.defaultDir ?? process.cwd();

            if (!isAbsolute(targetPath)) {
                return sendApiError(reply, 400, "invalid_request", "Directory path must be absolute.");
            }

            let realPath: string;
            try {
                realPath = await realpath(targetPath);
            } catch (error) {
                if (isEnoentError(error)) {
                    return sendApiError(reply, 404, "directory_not_found", "Directory does not exist.");
                }
                request.log.warn({ err: error, path: targetPath }, "failed to resolve directory");
                return sendApiError(reply, 400, "invalid_request", "Directory is not accessible.");
            }

            try {
                const targetStats = await stat(realPath);
                if (!targetStats.isDirectory()) {
                    return sendApiError(reply, 400, "invalid_request", "Path is not a directory.");
                }
                const allDirectories = await collectSubdirectories(realPath);
                const parentDir = dirname(realPath);
                return {
                    path: realPath,
                    parent: parentDir === realPath ? null : parentDir,
                    directories: allDirectories.slice(0, MAX_LISTED_DIRECTORIES),
                    truncated: allDirectories.length > MAX_LISTED_DIRECTORIES,
                };
            } catch (error) {
                request.log.warn({ err: error, path: realPath }, "failed to list directories");
                return sendApiError(reply, 400, "invalid_request", "Directory is not accessible.");
            }
        },
    );
}
