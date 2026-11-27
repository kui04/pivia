import { randomUUID } from "node:crypto";

import {
    type ExtensionUIContext,
    type ExtensionUIDialogOptions,
    type RpcExtensionUIRequest,
    type RpcExtensionUIResponse,
    type Theme,
} from "@earendil-works/pi-coding-agent";

import type { SessionDelta, SessionId } from "@pivia/protocol";

/**
 * Text-preserving theme for the headless bridge.
 *
 * The server never renders a terminal, so the public color methods return their input unchanged.
 * This avoids depending on the SDK's private global theme singleton while keeping
 * `ExtensionUIContext.theme` usable for extensions that only style text.
 */
// The proxy answers every property, so it needs no `Theme` instance state.
// eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment
const plainTextTheme = new Proxy({} as Theme, {
    get(_target, property) {
        if (typeof property === "symbol") {
            return undefined;
        }
        switch (property) {
            case "name":
                return "pivia-plain";
            case "appearance":
                return "dark";
            case "colors":
                return {};
            case "sourcePath":
            case "sourceInfo":
                return undefined;
            case "getColorMode":
                return () => "truecolor";
            case "getFgAnsi":
            case "getBgAnsi":
                return () => "";
            case "getThinkingBorderColor":
            case "getBashModeBorderColor":
                return () => (text: string) => text;
            case "style":
                return (text: string) => text;
            default:
                // fg/bg take a color then the text; text style methods take the text only.
                return (...args: unknown[]) => {
                    const text = args[args.length - 1];
                    return typeof text === "string" ? text : "";
                };
        }
    },
});

interface PendingDialog {
    readonly request: RpcExtensionUIRequest;
    readonly registeredAtMs: number;
    respond(response: RpcExtensionUIResponse): void;
    /** Resolve with the dialog default and notify clients that the dialog is gone. */
    cancel(): void;
    /** Resolve with the dialog default without notifying clients. */
    dispose(): void;
}

/** Result of applying one client response to the bridge. */
export type UiResponseResult =
    { readonly ok: true } | { readonly ok: false; readonly reason: "unknown" | "mismatched" };

/** Options for {@link SessionUiBridge}. */
export interface SessionUiBridgeOptions {
    /** Called after a pending dialog is added or settled; the registry uses it to restart idle timers. */
    readonly onPendingChange?: (() => void) | undefined;
    /** Clock used for the pending-dialog age; defaults to `Date.now`. */
    readonly nowMs?: (() => number) | undefined;
}

/** True when the response shape matches the dialog method it answers. */
function responseMatchesMethod(method: RpcExtensionUIRequest["method"], response: RpcExtensionUIResponse): boolean {
    if ("cancelled" in response) {
        return true;
    }
    if (method === "confirm") {
        return "confirmed" in response;
    }
    if (method === "select" || method === "input" || method === "editor") {
        return "value" in response;
    }
    return false;
}

/** True when the UI content is a plain line array or a clear operation. */
function isWidgetLines(content: unknown): content is string[] | undefined {
    return content === undefined || Array.isArray(content);
}

/** Delta variants emitted by {@link SessionUiBridge} onto the unified session sync clock. */
export type SessionUiDelta = Extract<SessionDelta, { readonly kind: "ui_request" | "ui_resolved" }>;

/**
 * Bridge between the SDK extension UI context and the WebSocket Sync lane.
 *
 * Dialog methods register a pending promise before announcing the request, so a fast client
 * response and a reconnect snapshot both observe the same request. Timeouts, aborts, and session
 * teardown resolve with the dialog default instead of leaving an extension blocked.
 */
export class SessionUiBridge {
    readonly context: ExtensionUIContext;
    private readonly publish: (delta: SessionUiDelta) => void;
    private readonly onPendingChange: (() => void) | undefined;
    private readonly nowMs: () => number;
    private readonly pending = new Map<string, PendingDialog>();
    private disposed = false;

    constructor(_sessionId: SessionId, publish: (delta: SessionUiDelta) => void, options: SessionUiBridgeOptions = {}) {
        this.publish = publish;
        this.onPendingChange = options.onPendingChange;
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.context = createExtensionUIContext(this);
    }

    /** True while at least one dialog still waits for a response. */
    hasPending(): boolean {
        return this.pending.size > 0;
    }

    /** Registration time of the newest pending dialog, or `undefined` when none are pending. */
    get lastPendingAtMs(): number | undefined {
        let latest: number | undefined;
        for (const dialog of this.pending.values()) {
            latest = Math.max(latest ?? 0, dialog.registeredAtMs);
        }
        return latest;
    }

    pendingRequests(): readonly RpcExtensionUIRequest[] {
        return [...this.pending.values()].map((dialog) => dialog.request);
    }

    /**
     * Apply one client response.
     *
     * Unknown ids are ignored so a client that lost the race against another client does not get
     * an error. A response whose payload does not match the dialog method leaves the dialog
     * pending and returns `mismatched`, so the caller can report the invalid input.
     */
    handleResponse(response: RpcExtensionUIResponse): UiResponseResult {
        if (this.disposed) {
            return { ok: false, reason: "unknown" };
        }
        const dialog = this.pending.get(response.id);
        if (dialog === undefined) {
            return { ok: false, reason: "unknown" };
        }
        if (!responseMatchesMethod(dialog.request.method, response)) {
            return { ok: false, reason: "mismatched" };
        }
        dialog.respond(response);
        this.publish({ kind: "ui_resolved", requestId: response.id });
        return { ok: true };
    }

    /**
     * Resolve every pending dialog with its default and tell clients to close them.
     * Used to unblock `session_start` before a closing runtime is disposed.
     */
    cancelPending(): void {
        for (const dialog of [...this.pending.values()]) {
            dialog.cancel();
        }
    }

    /**
     * Terminal bridge state. Later requests resolve with their default and emit nothing; later
     * responses are reported as unknown. Idempotent.
     */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const dialog of [...this.pending.values()]) {
            dialog.dispose();
        }
        this.pending.clear();
    }

    /** Emit a dialog or notification request onto the session sync stream. No-op after dispose. */
    emit(request: RpcExtensionUIRequest): void {
        if (this.disposed) {
            return;
        }
        this.publish({ kind: "ui_request", request });
    }

    requestDialog<T>(
        buildRequest: (id: string) => RpcExtensionUIRequest,
        defaultValue: T,
        parseResponse: (response: RpcExtensionUIResponse) => T,
        options?: ExtensionUIDialogOptions,
    ): Promise<T> {
        if (this.disposed || options?.signal?.aborted === true) {
            return Promise.resolve(defaultValue);
        }

        const id = randomUUID();
        return new Promise<T>((resolve) => {
            let settled = false;
            let timeoutId: NodeJS.Timeout | undefined;

            const onAbort = () => {
                settle(defaultValue, true);
            };
            const settle = (value: T, notifyClients: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timeoutId !== undefined) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
                options?.signal?.removeEventListener("abort", onAbort);
                this.pending.delete(id);
                resolve(value);
                if (notifyClients) {
                    this.publish({ kind: "ui_resolved", requestId: id });
                }
                this.onPendingChange?.();
            };

            options?.signal?.addEventListener("abort", onAbort, { once: true });
            if (options?.timeout !== undefined && options.timeout > 0) {
                timeoutId = setTimeout(() => settle(defaultValue, true), options.timeout);
                timeoutId.unref();
            }

            const request = buildRequest(id);
            this.pending.set(id, {
                request,
                registeredAtMs: this.nowMs(),
                respond: (response) => settle(parseResponse(response), false),
                cancel: () => settle(defaultValue, true),
                dispose: () => settle(defaultValue, false),
            });
            this.emit(request);
            this.onPendingChange?.();
        });
    }
}

/** Return the value of a select/input/editor response, or the default when cancelled. */
function parseValueResponse(response: RpcExtensionUIResponse): string | undefined {
    if ("cancelled" in response) {
        return undefined;
    }
    return "value" in response ? response.value : undefined;
}

/** Return the confirmation value, or `false` when cancelled. */
function parseConfirmResponse(response: RpcExtensionUIResponse): boolean {
    if ("cancelled" in response) {
        return false;
    }
    return "confirmed" in response ? response.confirmed : false;
}

function createExtensionUIContext(bridge: SessionUiBridge): ExtensionUIContext {
    const noop = (...args: unknown[]): void => {
        void args;
    };
    const setEditorText = (text: string): void => {
        bridge.emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
    };

    return {
        select(title, options, opts) {
            return bridge.requestDialog<string | undefined>(
                (id) => ({
                    type: "extension_ui_request",
                    id,
                    method: "select",
                    title,
                    options,
                    ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
                }),
                undefined,
                parseValueResponse,
                opts,
            );
        },
        confirm(title, message, opts) {
            return bridge.requestDialog<boolean>(
                (id) => ({
                    type: "extension_ui_request",
                    id,
                    method: "confirm",
                    title,
                    message,
                    ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
                }),
                false,
                parseConfirmResponse,
                opts,
            );
        },
        input(title, placeholder, opts) {
            return bridge.requestDialog<string | undefined>(
                (id) => ({
                    type: "extension_ui_request",
                    id,
                    method: "input",
                    title,
                    ...(placeholder === undefined ? {} : { placeholder }),
                    ...(opts?.timeout === undefined ? {} : { timeout: opts.timeout }),
                }),
                undefined,
                parseValueResponse,
                opts,
            );
        },
        editor(title, prefill) {
            return bridge.requestDialog<string | undefined>(
                (id) => ({
                    type: "extension_ui_request",
                    id,
                    method: "editor",
                    title,
                    ...(prefill === undefined ? {} : { prefill }),
                }),
                undefined,
                parseValueResponse,
            );
        },
        notify(message, type) {
            bridge.emit({
                type: "extension_ui_request",
                id: randomUUID(),
                method: "notify",
                message,
                ...(type === undefined ? {} : { notifyType: type }),
            });
        },
        onTerminalInput() {
            return () => {};
        },
        setStatus(key, text) {
            bridge.emit({
                type: "extension_ui_request",
                id: randomUUID(),
                method: "setStatus",
                statusKey: key,
                statusText: text,
            });
        },
        setWidget(key, content, options) {
            if (!isWidgetLines(content)) {
                return;
            }
            bridge.emit({
                type: "extension_ui_request",
                id: randomUUID(),
                method: "setWidget",
                widgetKey: key,
                widgetLines: content,
                ...(options?.placement === undefined ? {} : { widgetPlacement: options.placement }),
            });
        },
        setTitle(title) {
            bridge.emit({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
        },
        pasteToEditor: setEditorText,
        setEditorText,
        getEditorText() {
            return "";
        },
        getEditorComponent() {
            return undefined;
        },
        custom<T>(): Promise<T> {
            // Custom terminal components need the TUI; RPC mode deliberately has no implementation.
            return Promise.resolve(undefined as T);
        },
        theme: plainTextTheme,
        getAllThemes() {
            return [];
        },
        getTheme() {
            return undefined;
        },
        setTheme() {
            return { success: false, error: "Theme switching is not supported in RPC mode." };
        },
        getToolsExpanded() {
            return false;
        },
        setWorkingMessage: noop,
        setWorkingVisible: noop,
        setWorkingIndicator: noop,
        setHiddenThinkingLabel: noop,
        setFooter: noop,
        setHeader: noop,
        addAutocompleteProvider: noop,
        setEditorComponent: noop,
        setToolsExpanded: noop,
    };
}
