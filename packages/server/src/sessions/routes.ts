import {
    HTTP_ENDPOINTS,
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
        createDirectory: { type: "boolean" },
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
        instance.get(HTTP_ENDPOINTS.listSessions.pattern, { compress: {} }, async (): Promise<SessionListResponse> => {
            return sessionRegistry.list();
        });

        instance.post<{ Body: CreateSessionRequest }>(
            HTTP_ENDPOINTS.createSession.pattern,
            {
                schema: {
                    body: CREATE_SESSION_BODY_SCHEMA,
                },
            },
            async (request, reply): Promise<CreateSessionResponse | FastifyReply> => {
                try {
                    const handle = await sessionRegistry.createSession(
                        request.body.cwd,
                        request.body.createDirectory === undefined
                            ? undefined
                            : { createDirectory: request.body.createDirectory },
                    );
                    return await reply.code(201).send({ session: handle.summarize() });
                } catch (error) {
                    if (error instanceof SessionRegistryError) {
                        return sendRegistryError(reply, error);
                    }
                    request.log.error({ err: error }, "failed to create session");
                    return sendApiError(reply, 500, "internal_error", "Internal server error.");
                }
            },
        );

        instance.get(
            HTTP_ENDPOINTS.sessionDetail.pattern,
            { compress: {} },
            async (request, reply): Promise<SessionDetailResponse | FastifyReply> => {
                const params = HTTP_ENDPOINTS.sessionDetail.parseParams(request.params);
                if (params === null) {
                    return sendApiError(reply, 400, "invalid_request", "Invalid session id.");
                }
                const sliceAnchor = HTTP_ENDPOINTS.sessionDetail.parseQuery(request.query);
                const detail = await sessionRegistry.getById(params.id, sliceAnchor);
                if (detail === null) {
                    return sendApiError(reply, 404, "not_found", "Session not found.");
                }
                return detail;
            },
        );

        instance.post(
            HTTP_ENDPOINTS.closeSession.pattern,
            async (request, reply): Promise<CloseSessionResponse | FastifyReply> => {
                const params = HTTP_ENDPOINTS.closeSession.parseParams(request.params);
                if (params === null) {
                    return sendApiError(reply, 400, "invalid_request", "Invalid session id.");
                }
                const closed = await sessionRegistry.closeSession(params.id);
                return { closed };
            },
        );

        done();
    });
}
