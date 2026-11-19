import type {
    CloseSessionResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    SessionDetailResponse,
    SessionListResponse,
} from "@pivia/protocol";
import type { FastifyInstance, FastifyReply } from "fastify";

import { sendApiError, sendRegistryError } from "../http/errors.ts";
import { isValidSessionId } from "./catalog.ts";
import { type SessionRegistry, SessionRegistryError } from "./runtime.ts";

const CREATE_SESSION_BODY_SCHEMA = {
    type: "object",
    required: ["cwd"],
    additionalProperties: false,
    properties: {
        cwd: { type: "string", minLength: 1 },
    },
} as const;

/** Register `/api/sessions*` HTTP endpoints backed by {@link SessionRegistry}. */
export function registerSessionRoutes(app: FastifyInstance, sessionRegistry: SessionRegistry): void {
    app.get("/api/sessions", async (): Promise<SessionListResponse> => {
        return sessionRegistry.list();
    });

    app.post<{ Body: CreateSessionRequest }>(
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

    app.get<{ Params: { id: string } }>(
        "/api/sessions/:id",
        async (request, reply): Promise<SessionDetailResponse | FastifyReply> => {
            const { id } = request.params;
            if (!isValidSessionId(id)) {
                return sendApiError(reply, 400, "invalid_request", "Invalid session id.");
            }
            const detail = await sessionRegistry.getById(id);
            if (detail === null) {
                return sendApiError(reply, 404, "not_found", "Session not found.");
            }
            return detail;
        },
    );

    app.post<{ Params: { id: string } }>(
        "/api/sessions/:id/close",
        async (request, reply): Promise<CloseSessionResponse | FastifyReply> => {
            const { id } = request.params;
            if (!isValidSessionId(id)) {
                return sendApiError(reply, 400, "invalid_request", "Invalid session id.");
            }
            const closed = await sessionRegistry.closeSession(id);
            return { closed };
        },
    );
}
