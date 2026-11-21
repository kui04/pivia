import {
    parseSessionId,
    parseSessionPrefixAnchor,
    type CloseSessionResponse,
    type CreateSessionRequest,
    type CreateSessionResponse,
    type SessionDetailResponse,
    type SessionListResponse,
} from "@pivia/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendApiError, sendRegistryError } from "../http/errors.ts";
import { type SessionRegistry, SessionRegistryError } from "./runtime.ts";

const CREATE_SESSION_BODY_SCHEMA = {
    type: "object",
    required: ["cwd"],
    additionalProperties: false,
    properties: {
        cwd: { type: "string", minLength: 1 },
    },
} as const;

/**
 * Register `/api/sessions*` HTTP endpoints backed by {@link SessionRegistry}.
 *
 * Wrapped in `app.register` so `@fastify/compress`'s `onRoute` hook is installed before these
 * routes are registered.
 */
export function registerSessionRoutes(app: FastifyInstance, sessionRegistry: SessionRegistry): void {
    app.register((instance, _options, done) => {
        instance.get("/api/sessions", { compress: {} }, async (): Promise<SessionListResponse> => {
            return sessionRegistry.list();
        });

        instance.post<{ Body: CreateSessionRequest }>(
            "/api/sessions",
            {
                schema: {
                    body: CREATE_SESSION_BODY_SCHEMA,
                },
            },
            async (request, reply): Promise<CreateSessionResponse | FastifyReply> => {
                try {
                    const handle = await sessionRegistry.createSession(request.body.cwd);
                    return reply.code(201).send({ session: handle.summarize() });
                } catch (error) {
                    if (error instanceof SessionRegistryError) {
                        return sendRegistryError(reply, error);
                    }
                    request.log.error({ err: error }, "failed to create session");
                    return sendApiError(reply, 500, "internal_error", "Internal server error.");
                }
            },
        );

        instance.get<{ Params: { id: string } }>(
            "/api/sessions/:id",
            { compress: {} },
            async (request, reply): Promise<SessionDetailResponse | FastifyReply> => {
                const sessionId = parseSessionId(request.params.id);
                if (sessionId === null) {
                    return sendApiError(reply, 400, "invalid_request", "Invalid session id.");
                }
                const sliceAnchor = parseSessionPrefixAnchor(request.query);
                const detail = await sessionRegistry.getById(sessionId, sliceAnchor);
                if (detail === null) {
                    return sendApiError(reply, 404, "not_found", "Session not found.");
                }
                return detail;
            },
        );

        instance.post<{ Params: { id: string } }>(
            "/api/sessions/:id/close",
            async (request, reply): Promise<CloseSessionResponse | FastifyReply> => {
                const sessionId = parseSessionId(request.params.id);
                if (sessionId === null) {
                    return sendApiError(reply, 400, "invalid_request", "Invalid session id.");
                }
                const closed = await sessionRegistry.closeSession(sessionId);
                return { closed };
            },
        );

        done();
    });
}
