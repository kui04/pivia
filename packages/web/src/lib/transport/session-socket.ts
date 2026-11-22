import {
    assertNever,
    classifySessionClose,
    parseSessionWsServerMessage,
    SESSION_CLOSE_CODE,
    type RpcExtensionUIResponse,
    type SessionCloseReason,
    type SessionCursor,
    type SessionId,
    type SessionPrefixAnchor,
    type SessionRpcCommand,
    type SessionRpcServerMessage,
    type SessionSyncFrame,
    type SessionWsClientMessage,
    type SessionWsServerMessage,
} from "@pivia/protocol";

import { Log } from "@/lib/log";

/** A control command. UI answers travel through {@link SessionSocket.sendUiResponse}. */
export type SessionCommand = SessionRpcCommand;

/** RPC response envelope returned by {@link SessionSocket.sendCommand}. */
export type SessionRpcResponseMessage = Extract<SessionRpcServerMessage, { readonly type: "rpc:response" }>;

/** RPC protocol error envelope delivered over `/ws/sessions/:id`. */
export type SessionRpcErrorMessage = Extract<SessionRpcServerMessage, { readonly type: "rpc:error" }>;

/** Why a session socket closed, from the browser client's point of view. */
export type SessionSocketCloseReason = SessionCloseReason;

/** One close event with the classification the store uses to decide about a reconnect. */
export interface SessionSocketClose {
    readonly code: number;
    readonly reason: string;
    readonly classification: SessionSocketCloseReason;
    readonly wasClean: boolean;
}

/** The subset of the browser WebSocket that the client uses. */
export interface SessionSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: (() => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onclose: ((event: CloseEvent) => void) | null;
    onerror: (() => void) | null;
}

/** Constructor for an injectable WebSocket implementation. */
export type SessionSocketConstructor = new (url: string) => SessionSocketLike;

/** Handshake parameters sent on `/ws/sessions/:id` connect and reconnect. */
export interface SessionSocketHandshakeParams {
    readonly cursor?: SessionCursor | undefined;
    readonly prefixAnchor?: SessionPrefixAnchor | undefined;
}

/** Options for {@link SessionSocket}. */
export interface SessionSocketOptions {
    readonly sessionId: SessionId;
    /** Optional Tier 1/2 handshake anchors (`cursor`, `prefixAnchor`). */
    readonly handshake?: SessionSocketHandshakeParams | undefined;
    /** Absolute `ws://` or `wss://` URL. Defaults to the current origin and `/ws/sessions/:id`. */
    readonly url?: string | undefined;
    /** WebSocket constructor. Defaults to `globalThis.WebSocket`. */
    readonly WebSocket?: SessionSocketConstructor | undefined;
    readonly onOpen?: (() => void) | undefined;
    /** Receives decoded Sync lane frames (`sync:*`). */
    readonly onSyncFrame?: ((frame: SessionSyncFrame) => void) | undefined;
    /** Receives non-command server messages (Sync lane frames and unmatched RPC errors). */
    readonly onMessage?: ((message: SessionWsServerMessage) => void) | undefined;
    readonly onClose?: ((close: SessionSocketClose) => void) | undefined;
    /** Receives transport errors. A close event normally follows. */
    readonly onError?: ((message: string) => void) | undefined;
}

/** A command that never received its response because the socket closed. */
export class SessionSocketClosedError extends Error {
    readonly classification: SessionSocketCloseReason;

    constructor(classification: SessionSocketCloseReason) {
        super(`The session socket closed (${classification}).`);
        this.name = "SessionSocketClosedError";
        this.classification = classification;
    }
}

/** A correlated command response that reported failure or a protocol error. */
export class SessionCommandError extends Error {
    readonly command: string;
    readonly code: string | undefined;

    constructor(command: string, message: string, code?: string) {
        super(message);
        this.name = "SessionCommandError";
        this.command = command;
        this.code = code;
    }
}

interface PendingCommand {
    readonly command: string;
    readonly resolve: (message: SessionRpcResponseMessage) => void;
    readonly reject: (error: Error) => void;
}

const WS_READY_STATE_OPEN = 1;

/** Builds the default endpoint from a page URL and optional Tier 1/2 handshake anchors. */
export function buildSessionSocketUrl(
    sessionId: SessionId,
    handshake?: SessionSocketHandshakeParams,
    pageUrl?: string,
): string {
    const source = pageUrl ?? globalThis.location?.href;
    if (source === undefined) {
        throw new Error("A WebSocket URL is required outside the browser.");
    }
    const url = new URL(source);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = `/ws/sessions/${encodeURIComponent(sessionId)}`;
    url.search = "";
    url.hash = "";
    const params = handshake ?? {};
    if (params.cursor !== undefined) {
        url.searchParams.set("epoch", params.cursor.epoch);
        url.searchParams.set("afterSeq", String(params.cursor.seq));
    }
    if (params.prefixAnchor !== undefined) {
        url.searchParams.set("entriesVersion", params.prefixAnchor.entriesVersion);
        url.searchParams.set("afterCount", String(params.prefixAnchor.afterCount));
        url.searchParams.set("afterEntryId", params.prefixAnchor.afterEntryId);
    }
    return url.toString();
}

let fallbackCommandId = 0;

function createCommandId(): string {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }
    fallbackCommandId += 1;
    return `command-${String(fallbackCommandId)}`;
}

function defaultSocketConstructor(): SessionSocketConstructor {
    const constructor = globalThis.WebSocket;
    if (constructor === undefined) {
        throw new Error("WebSocket is not available in this environment.");
    }
    // The browser WebSocket has the same members; the cast only narrows the event parameters.
    return constructor as unknown as SessionSocketConstructor;
}

/**
 * WebSocket client for one session runtime.
 *
 * Control commands are correlated by `id`: the promise settles on the matching `response` or
 * protocol `error`. `extension_ui_response` bypasses that table because the server handles UI
 * answers out of band. Every pending command is rejected when the socket closes, so a reconnect
 * cannot leave a caller waiting forever.
 */
export class SessionSocket {
    private readonly sessionId: SessionId;
    private readonly handshake: SessionSocketHandshakeParams;
    private readonly url: string | undefined;
    private readonly socketConstructor: SessionSocketConstructor | undefined;
    private readonly onOpen: (() => void) | undefined;
    private readonly onSyncFrame: ((frame: SessionSyncFrame) => void) | undefined;
    private readonly onMessage: ((message: SessionWsServerMessage) => void) | undefined;
    private readonly onClose: ((close: SessionSocketClose) => void) | undefined;
    private readonly onError: ((message: string) => void) | undefined;

    private socket: SessionSocketLike | null = null;
    private closed = false;
    private closeReason: SessionSocketCloseReason | null = null;
    private readonly outbox: string[] = [];
    private readonly pending = new Map<string, PendingCommand>();

    constructor(options: SessionSocketOptions) {
        this.sessionId = options.sessionId;
        this.handshake = options.handshake ?? {};
        this.url = options.url;
        this.socketConstructor = options.WebSocket;
        this.onOpen = options.onOpen;
        this.onSyncFrame = options.onSyncFrame;
        this.onMessage = options.onMessage;
        this.onClose = options.onClose;
        this.onError = options.onError;
    }

    /** True after {@link close} or a server-side close. */
    get isClosed(): boolean {
        return this.closed;
    }

    /** Opens the socket. Calling it again after a successful open does nothing. */
    connect(): void {
        if (this.socket !== null || this.closed) {
            return;
        }

        const constructor = this.socketConstructor ?? defaultSocketConstructor();
        const url = this.url ?? buildSessionSocketUrl(this.sessionId, this.handshake);
        const socket = new constructor(url);
        this.socket = socket;

        socket.onopen = () => {
            if (this.closed) {
                return;
            }
            this.flushOutbox();
            this.onOpen?.();
        };
        socket.onmessage = (event) => {
            this.receive(event.data);
        };
        socket.onclose = (event) => {
            this.handleServerClose(event);
        };
        socket.onerror = () => {
            this.onError?.("The session connection failed.");
        };
    }

    /**
     * Sends one control command and resolves with its matching response.
     *
     * A command without an `id` gets one; a supplied `id` is reused so a caller can correlate a
     * command with its own state. Commands sent before the socket opens are queued in order.
     */
    sendCommand(command: SessionCommand): Promise<SessionRpcResponseMessage> {
        if (this.closed) {
            return Promise.reject(new SessionSocketClosedError(this.closeReason ?? "client"));
        }
        const id = command.id ?? createCommandId();
        if (this.pending.has(id)) {
            return Promise.reject(
                new SessionCommandError(command.type, "A command with this id is still pending.", id),
            );
        }

        const payload = { ...command, id } satisfies SessionCommand;
        const envelope = { type: "rpc:command", command: payload } satisfies SessionWsClientMessage;
        const promise = new Promise<SessionRpcResponseMessage>((resolve, reject) => {
            this.pending.set(id, { command: command.type, resolve, reject });
        });

        try {
            this.sendRaw(JSON.stringify(envelope));
        } catch (error) {
            this.pending.delete(id);
            const message = error instanceof Error ? error.message : String(error);
            return Promise.reject(new SessionCommandError(command.type, message, id));
        }
        return promise;
    }

    /**
     * Sends one extension UI answer without adding it to the command table.
     *
     * The server dispatches these out of band, so a long prompt or compaction on the same socket
     * must not delay the answer that unblocks it.
     */
    sendUiResponse(response: RpcExtensionUIResponse): void {
        if (this.closed) {
            throw new SessionSocketClosedError(this.closeReason ?? "client");
        }
        const envelope = { type: "rpc:ui_response", response } satisfies SessionWsClientMessage;
        this.sendRaw(JSON.stringify(envelope));
    }

    /** Closes the socket from this client and rejects every pending command. */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.closeReason = "client";
        this.outbox.length = 0;

        const socket = this.socket;
        this.socket = null;
        if (socket !== null) {
            // Drop the handlers so the close handshake cannot report a second close event.
            socket.onopen = null;
            socket.onmessage = null;
            socket.onclose = null;
            socket.onerror = null;
            try {
                socket.close(SESSION_CLOSE_CODE.normal, "Client closed");
            } catch (error) {
                Log.warn("Failed to close the session socket", error);
            }
        }

        this.rejectPending(new SessionSocketClosedError("client"));
        this.onClose?.({
            code: SESSION_CLOSE_CODE.normal,
            reason: "Client closed",
            classification: "client",
            wasClean: true,
        });
    }

    private sendRaw(data: string): void {
        const socket = this.socket;
        if (socket === null || socket.readyState !== WS_READY_STATE_OPEN) {
            this.outbox.push(data);
            return;
        }
        socket.send(data);
    }

    private flushOutbox(): void {
        const socket = this.socket;
        if (socket === null) {
            return;
        }
        while (this.outbox.length > 0 && socket.readyState === WS_READY_STATE_OPEN) {
            const data = this.outbox.shift();
            if (data !== undefined) {
                socket.send(data);
            }
        }
    }

    private receive(data: unknown): void {
        if (this.closed || typeof data !== "string") {
            return;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(data) as unknown;
        } catch {
            Log.warn("Ignored a malformed session WebSocket message");
            return;
        }
        const message = parseSessionWsServerMessage(parsed);
        if (message === null) {
            Log.warn("Ignored an invalid session WebSocket message");
            return;
        }
        switch (message.type) {
            case "rpc:response":
                this.settleResponse(message);
                return;
            case "rpc:error":
                this.settleError(message);
                return;
            case "sync:snapshot":
            case "sync:replay":
            case "sync:delta":
            case "sync:resync":
                this.onSyncFrame?.(message);
                this.onMessage?.(message);
                return;
            default:
                return assertNever(message);
        }
    }

    private settleResponse(message: SessionRpcResponseMessage): void {
        const id = message.id;
        if (id === undefined) {
            Log.debug("Ignored a session response without a command id", message.command);
            return;
        }
        const pending = this.pending.get(id);
        if (pending === undefined) {
            Log.debug("Ignored a session response for an unknown command", message.command);
            return;
        }
        this.pending.delete(id);
        if (message.success) {
            pending.resolve(message);
            return;
        }
        pending.reject(new SessionCommandError(pending.command, message.error));
    }

    private settleError(message: SessionRpcErrorMessage): void {
        const id = message.id;
        if (id !== undefined) {
            const pending = this.pending.get(id);
            if (pending !== undefined) {
                this.pending.delete(id);
                pending.reject(new SessionCommandError(pending.command, message.message, message.code));
                return;
            }
        }
        // A UI answer carries the request id, not a command id, and the server reports a rejected
        // one as a protocol error. Deliver it so the caller can surface the failure.
        this.onMessage?.(message);
    }

    private handleServerClose(event: CloseEvent): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const socket = this.socket;
        this.socket = null;
        if (socket !== null) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onclose = null;
            socket.onerror = null;
        }
        this.outbox.length = 0;

        const classification = classifySessionClose(event.code);
        this.closeReason = classification;
        this.rejectPending(new SessionSocketClosedError(classification));
        this.onClose?.({
            code: event.code,
            reason: event.reason,
            classification,
            wasClean: event.wasClean,
        });
    }

    private rejectPending(error: SessionSocketClosedError): void {
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const command of pending) {
            command.reject(error);
        }
    }
}
