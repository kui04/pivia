import type { RpcExtensionUIResponse, WsResponseMessage, WsServerMessage } from "@pivia/protocol";
import { create } from "zustand";

import { Log } from "@/lib/log";
import {
    SessionSocket,
    SessionSocketClosedError,
    type SessionCommand,
    type SessionSocketClose,
    type SessionSocketConstructor,
} from "@/lib/transport/session-socket";

import { initialSessionState, reduceSessionState, type SessionState } from "./reducer";

/** Dependencies that let a test replace the socket and shorten the reconnect delay. */
export interface SessionStoreOptions {
    readonly WebSocket?: SessionSocketConstructor | undefined;
    readonly reconnectDelayMs?: number | undefined;
    readonly maxReconnectAttempts?: number | undefined;
}

/** What a caller may do with the active session. */
export interface SessionStoreActions {
    /** Opens one session, replacing any previous socket. */
    connect: (sessionId: string, options?: { readonly afterSeq?: number | undefined }) => void;
    /** Closes the socket and returns the store to its initial state. */
    disconnect: () => void;
    sendCommand: (command: SessionCommand) => Promise<WsResponseMessage>;
    sendUiResponse: (response: RpcExtensionUIResponse) => Promise<void>;
}

export type SessionStore = SessionState & SessionStoreActions;

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Creates the store of the active session runtime.
 *
 * The store owns the socket because the session view, the reconnect decision and the command
 * table all need the same connection. A deliberate close (`4400`) or a missing session (`4404`)
 * ends in `closed`; a slow consumer (`1013`), a server going-away close (`1001`) or an unexpected
 * disconnect reconnects with `afterSeq`, so the server can replay only what the client missed.
 */
export function createSessionStore(options: SessionStoreOptions = {}) {
    const reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;

    return create<SessionStore>()((set, get) => {
        let socket: SessionSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let reconnectAttempts = 0;
        let generation = 0;

        const clearReconnectTimer = (): void => {
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };

        const applyMessage = (message: WsServerMessage): void => {
            switch (message.type) {
                case "snapshot":
                    reconnectAttempts = 0;
                    set((state) => reduceSessionState(state, { type: "snapshot", message }));
                    return;
                case "replay":
                    reconnectAttempts = 0;
                    set((state) => reduceSessionState(state, { type: "replay", message }));
                    return;
                case "event":
                    reconnectAttempts = 0;
                    set((state) => reduceSessionState(state, { type: "event", message }));
                    return;
                case "extension_ui_request":
                    set((state) => reduceSessionState(state, { type: "extension_ui_request", message }));
                    return;
                case "extension_ui_resolved":
                    set((state) => reduceSessionState(state, { type: "extension_ui_resolved", message }));
                    return;
                case "extension_error":
                    Log.warn(
                        `Extension ${message.extensionPath} failed while handling ${message.event}`,
                        message.error,
                    );
                    return;
                case "error":
                    set((state) => reduceSessionState(state, { type: "server_error", message }));
                    return;
                case "response":
                    // The socket settles the matching command promise before this callback runs.
                    return;
            }
        };

        const open = (sessionId: string, afterSeq: number | undefined): void => {
            const currentGeneration = ++generation;
            const nextSocket = new SessionSocket({
                sessionId,
                ...(afterSeq === undefined ? {} : { afterSeq }),
                ...(options.WebSocket === undefined ? {} : { WebSocket: options.WebSocket }),
                onOpen: () => {
                    if (generation !== currentGeneration) {
                        return;
                    }
                    set((state) => reduceSessionState(state, { type: "open" }));
                },
                onMessage: (message: WsServerMessage) => {
                    if (generation !== currentGeneration) {
                        return;
                    }
                    applyMessage(message);
                },
                onClose: (close) => {
                    if (generation !== currentGeneration) {
                        return;
                    }
                    handleClose(close);
                },
                onError: (message) => {
                    if (generation === currentGeneration) {
                        Log.warn(`Session socket error: ${message}`);
                    }
                },
            });
            socket = nextSocket;
            try {
                nextSocket.connect();
            } catch (error) {
                socket = null;
                const message = error instanceof Error ? error.message : String(error);
                set((state) => reduceSessionState(state, { type: "failed", message }));
            }
        };

        const scheduleReconnect = (): void => {
            const state = get();
            if (state.sessionId === null || state.status === "closed") {
                set((current) => reduceSessionState(current, { type: "closed", reason: "client" }));
                return;
            }
            if (reconnectAttempts >= maxReconnectAttempts) {
                set((current) =>
                    reduceSessionState(current, {
                        type: "failed",
                        message: "Cannot reconnect to the session.",
                    }),
                );
                return;
            }
            reconnectAttempts += 1;
            set((current) => reduceSessionState(current, { type: "reconnecting" }));
            const scheduledGeneration = generation;
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                const next = get();
                if (generation !== scheduledGeneration || next.sessionId === null || next.status !== "reconnecting") {
                    return;
                }
                open(next.sessionId, next.seq > 0 ? next.seq : undefined);
            }, reconnectDelayMs);
        };

        const handleClose = (close: SessionSocketClose): void => {
            socket = null;
            clearReconnectTimer();
            if (close.classification === "client" || close.classification === "session") {
                set((state) =>
                    reduceSessionState(state, {
                        type: "closed",
                        reason: close.classification,
                        message: close.reason,
                    }),
                );
                return;
            }
            Log.warn(`The session connection closed (${close.classification}, code ${String(close.code)})`);
            scheduleReconnect();
        };

        return {
            ...initialSessionState,
            connect: (sessionId, connectOptions = {}) => {
                const current = get();
                if (
                    current.sessionId === sessionId &&
                    socket !== null &&
                    (current.status === "connecting" || current.status === "open" || current.status === "reconnecting")
                ) {
                    return;
                }
                generation += 1;
                clearReconnectTimer();
                reconnectAttempts = 0;
                const previous = socket;
                socket = null;
                previous?.close();
                set((state) => reduceSessionState(state, { type: "connect", sessionId }));
                open(sessionId, connectOptions.afterSeq);
            },
            disconnect: () => {
                generation += 1;
                clearReconnectTimer();
                reconnectAttempts = 0;
                const current = socket;
                socket = null;
                current?.close();
                set((state) => reduceSessionState(state, { type: "reset" }));
            },
            sendCommand: (command) => {
                const current = socket;
                if (current === null) {
                    return Promise.reject(new SessionSocketClosedError("client"));
                }
                return current.sendCommand(command);
            },
            sendUiResponse: (response) => {
                const current = socket;
                if (current === null) {
                    return Promise.reject(new SessionSocketClosedError("client"));
                }
                try {
                    current.sendUiResponse(response);
                    return Promise.resolve();
                } catch (error) {
                    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
                }
            },
        };
    });
}

/** The app-wide store for the active session. */
export const useSessionStore = createSessionStore();
