import { assertNever, type SessionId, type SessionStateSnapshot } from "@pivia/protocol";
import { ArrowUp, MessageCircleQuestion, Paperclip, Square } from "lucide-react";
import {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    type ClipboardEvent,
    type KeyboardEvent,
    type ReactElement,
    type SubmitEvent,
} from "react";

import { IconButton, Popover, ScrollArea, Tabular, VisuallyHidden } from "@components";
import { Clipboard, cn, isImeComposition } from "@/lib";
import type { EditorTextRequest } from "@/stores/session";

import {
    AttachmentStrip,
    CommandList,
    commandRows,
    formatAttachmentError,
    ModelPicker,
    parseComposerSubmission,
    readClipboardImages,
    readImageFiles,
    slashName,
    ThinkingLevelPicker,
} from "./components";
import styles from "./Composer.module.css";
import {
    toComposerRuntimePhase,
    type AttachmentId,
    type ComposerCommandSender,
    type ComposerPanel,
    type ComposerRuntimePhase,
    type LocalSlashCommandName,
    type SlashCommandRow,
    type StagedImageAttachment,
} from "./types";

export interface ComposerProps {
    /** Active session id used to scope lazy picker catalog caches. */
    readonly sessionId?: SessionId | null | undefined;
    /** Session runtime state snapshot; `null` before initial snapshot hydration. */
    readonly state: SessionStateSnapshot | null;
    /** Whether the active session WebSocket is open and ready to accept runtime commands. */
    readonly connected: boolean;
    /** Optional remote slash commands when the server exposes `get_commands`. */
    readonly remoteCommands?:
        readonly { readonly name: string; readonly description?: string | undefined }[] | undefined;
    /**
     * Pending extension dialogs of this session; blocks the composer and replaces the primary
     * send action with the prompt button while the runtime waits for an answer.
     */
    readonly extensionPrompt?:
        { readonly count: number; readonly reason: string; readonly onOpen: () => void } | undefined;
    /** Extension text that replaces the draft; the sequence keeps each command applied once. */
    readonly editorTextRequest?: EditorTextRequest | undefined;
    /** Called with the applied sequence so the store can clear the command. */
    readonly onEditorTextApplied?: ((sequence: number) => void) | undefined;
    /** RPC dispatcher wired to `useSessionStore().sendCommand`. */
    readonly onSendCommand: ComposerCommandSender;
    /** Notifies the user of validation hints, attachment errors, or command outcomes. */
    readonly onNotify?:
        ((notice: { readonly tone: "info" | "warning" | "error"; readonly message: string }) => void) | undefined;
    /** Optional class name merged onto the outer composer card. */
    readonly className?: string | undefined;
}

/**
 * Interactive session message composer card with staged image attachments, model and thinking
 * pickers, local slash commands, and streaming steer/follow-up/abort controls.
 */
export function Composer({
    sessionId,
    state,
    connected,
    remoteCommands,
    extensionPrompt,
    editorTextRequest,
    onEditorTextApplied,
    onSendCommand,
    onNotify,
    className,
}: ComposerProps): ReactElement {
    const inputId = useId();
    const cardRef = useRef<HTMLFormElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const [value, setValue] = useState("");
    const [staged, setStaged] = useState<readonly StagedImageAttachment[]>([]);
    const [panel, setPanel] = useState<ComposerPanel>("none");
    const [dismissedSlash, setDismissedSlash] = useState(false);
    const [highlightedId, setHighlightedId] = useState<string | null>(null);
    const [pointedId, setPointedId] = useState<string | null>(null);
    const [appliedEditorTextSequence, setAppliedEditorTextSequence] = useState<number | null>(null);

    // An extension command replaces the draft once; the sequence makes a re-render a no-op.
    if (editorTextRequest === undefined) {
        if (appliedEditorTextSequence !== null) {
            setAppliedEditorTextSequence(null);
        }
    } else if (appliedEditorTextSequence !== editorTextRequest.sequence) {
        setAppliedEditorTextSequence(editorTextRequest.sequence);
        setValue(editorTextRequest.text);
    }

    useEffect(() => {
        if (editorTextRequest === undefined || appliedEditorTextSequence !== editorTextRequest.sequence) {
            return;
        }
        textareaRef.current?.focus();
        onEditorTextApplied?.(editorTextRequest.sequence);
    }, [appliedEditorTextSequence, editorTextRequest, onEditorTextApplied]);

    const hasPendingExtension = extensionPrompt !== undefined && extensionPrompt.count > 0;
    const phase: ComposerRuntimePhase = hasPendingExtension
        ? { kind: "unavailable", reason: extensionPrompt.reason }
        : toComposerRuntimePhase(connected, state, connected ? "Connecting session..." : "Session unavailable.");
    const ready = phase.kind === "ready";
    const streaming = phase.kind === "ready" && phase.isStreaming;
    const [prevReady, setPrevReady] = useState(ready);
    if (prevReady !== ready) {
        setPrevReady(ready);
        if (!ready && panel !== "none") {
            setPanel("none");
        }
    }

    const remoteRows = useMemo<readonly SlashCommandRow[]>(
        () =>
            (remoteCommands ?? []).map((command) => ({
                id: `remote-${command.name}`,
                name: command.name,
                description: command.description ?? null,
            })),
        [remoteCommands],
    );
    const remoteNames = useMemo(() => (remoteCommands ?? []).map((command) => command.name), [remoteCommands]);

    const currentSlash = slashName(value);
    const commandListOpen =
        ready && currentSlash !== null && !/\s/.test(value.trimStart()) && !dismissedSlash && panel === "none";
    const rows = useMemo(
        () => (commandListOpen ? commandRows(currentSlash, remoteRows) : []),
        [commandListOpen, currentSlash, remoteRows],
    );
    const highlightedRow = rows.find((row) => row.id === highlightedId) ?? rows[0] ?? null;
    const litRow = rows.find((row) => row.id === pointedId) ?? highlightedRow;

    const notify = useCallback(
        (tone: "info" | "warning" | "error", message: string) => {
            onNotify?.({ tone, message });
        },
        [onNotify],
    );

    const appendStagedImages = useCallback(
        (result: Awaited<ReturnType<typeof readImageFiles>>) => {
            if (result.attachments.length > 0) {
                setStaged((prev) => [...prev, ...result.attachments]);
            }
            for (const error of result.errors) {
                notify("error", formatAttachmentError(error));
            }
        },
        [notify],
    );

    const restoreDraft = useCallback((restoreText: string, restoreImages: readonly StagedImageAttachment[]) => {
        setValue((current) => (current.length === 0 ? restoreText : current));
        if (restoreImages.length > 0) {
            setStaged((prev) => (prev.length === 0 ? restoreImages : prev));
        }
    }, []);

    const runLocalCommand = useCallback(
        (
            command: LocalSlashCommandName,
            args: string,
            restoreText: string,
            restoreImages: readonly StagedImageAttachment[],
        ) => {
            const restore = (message: string): void => {
                notify("error", message);
                restoreDraft(restoreText, restoreImages);
            };

            switch (command) {
                case "compact": {
                    void onSendCommand(
                        args.length > 0 ? { type: "compact", customInstructions: args } : { type: "compact" },
                    )
                        .then((response) => {
                            if (!response.success) {
                                restore(response.error);
                            }
                        })
                        .catch((cause: unknown) => {
                            restore(cause instanceof Error ? cause.message : String(cause));
                        });
                    return;
                }
                case "name": {
                    if (args.length === 0) {
                        notify("warning", "Type a name after /name.");
                        restoreDraft(restoreText, restoreImages);
                        return;
                    }
                    void onSendCommand({ type: "set_session_name", name: args })
                        .then((response) => {
                            if (!response.success) {
                                restore(response.error);
                            }
                        })
                        .catch((cause: unknown) => {
                            restore(cause instanceof Error ? cause.message : String(cause));
                        });
                    return;
                }
                case "clear-queue": {
                    void onSendCommand({ type: "clear_queue" })
                        .then((response) => {
                            if (!response.success) {
                                notify("error", response.error);
                                return;
                            }
                            notify("info", "Cleared queued messages.");
                        })
                        .catch((cause: unknown) => {
                            notify("error", cause instanceof Error ? cause.message : String(cause));
                        });
                    return;
                }
                default:
                    assertNever(command);
            }
        },
        [notify, onSendCommand, restoreDraft],
    );

    const submit = useCallback(
        (withFollowUp: boolean) => {
            if (!ready) {
                return;
            }
            const behavior = streaming ? (withFollowUp ? "followUp" : "steer") : "prompt";
            const submission = parseComposerSubmission(
                value,
                staged.map((item) => item.image),
                behavior,
                remoteNames,
            );

            switch (submission.kind) {
                case "empty":
                    return;
                case "blocked_command":
                    setValue("");
                    setDismissedSlash(false);
                    notify("warning", submission.hint);
                    return;
                case "local_command": {
                    const restoreText = value;
                    const restoreImages = staged;
                    setValue("");
                    setStaged([]);
                    setDismissedSlash(false);
                    runLocalCommand(submission.command, submission.args, restoreText, restoreImages);
                    return;
                }
                case "prompt": {
                    const restoreText = value;
                    const restoreImages = staged;
                    setValue("");
                    setStaged([]);
                    setDismissedSlash(false);
                    void onSendCommand({
                        type: "prompt",
                        message: submission.message,
                        ...(submission.images.length > 0 ? { images: [...submission.images] } : {}),
                        ...(submission.behavior === "prompt" ? {} : { streamingBehavior: submission.behavior }),
                    })
                        .then((response) => {
                            if (!response.success) {
                                notify("error", response.error);
                                restoreDraft(restoreText, restoreImages);
                            }
                        })
                        .catch((cause: unknown) => {
                            notify("error", cause instanceof Error ? cause.message : String(cause));
                            restoreDraft(restoreText, restoreImages);
                        });
                    return;
                }
                default:
                    assertNever(submission);
            }
        },
        [notify, onSendCommand, ready, remoteNames, restoreDraft, runLocalCommand, staged, streaming, value],
    );

    const chooseCommand = useCallback((row: SlashCommandRow) => {
        setDismissedSlash(false);
        setValue(`/${row.name} `);
        textareaRef.current?.focus();
    }, []);

    const moveCommandSelection = (step: number): void => {
        if (rows.length === 0) {
            return;
        }
        setPointedId(null);
        const currentIndex = rows.findIndex((row) => row.id === highlightedRow?.id);
        const nextIndex = (currentIndex + step + rows.length) % rows.length;
        setHighlightedId(rows[nextIndex]?.id ?? null);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (isImeComposition(event.nativeEvent)) {
            return;
        }
        if (event.key === "Escape" && commandListOpen) {
            event.preventDefault();
            setDismissedSlash(true);
            return;
        }
        if (event.key === "Tab" && commandListOpen && litRow !== null) {
            event.preventDefault();
            chooseCommand(litRow);
            return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (commandListOpen && !event.altKey && litRow !== null) {
                chooseCommand(litRow);
                return;
            }
            submit(event.altKey);
            return;
        }
        if (commandListOpen && event.key === "ArrowDown") {
            event.preventDefault();
            moveCommandSelection(1);
            return;
        }
        if (commandListOpen && event.key === "ArrowUp") {
            event.preventDefault();
            moveCommandSelection(-1);
        }
    };

    const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        const transfer = event.clipboardData;
        if (!Clipboard.hasFiles(transfer)) {
            return;
        }
        event.preventDefault();
        void readClipboardImages(transfer)
            .then(appendStagedImages)
            .catch(() => {
                notify("error", "Could not read pasted image.");
            });
    };

    const handleAbort = (): void => {
        void onSendCommand({ type: "abort" })
            .then((response) => {
                if (!response.success) {
                    notify("error", response.error);
                }
            })
            .catch((cause: unknown) => {
                notify("error", cause instanceof Error ? cause.message : String(cause));
            });
    };

    const hasDraft = value.trim().length > 0 || staged.length > 0;
    const canSend = ready && hasDraft;
    const showSendButton = !streaming || hasDraft;

    return (
        <Popover
            open={commandListOpen && highlightedRow !== null}
            onOpenChange={(open, details) => {
                if (!open && details.reason !== "trigger-press") {
                    setDismissedSlash(true);
                }
            }}
        >
            <form
                ref={cardRef}
                className={cn(styles.card, className)}
                onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    submit(false);
                }}
            >
                <AttachmentStrip
                    items={staged}
                    onRemove={(id: AttachmentId) => {
                        setStaged((prev) => prev.filter((item) => item.id !== id));
                    }}
                />
                <VisuallyHidden>
                    <label htmlFor={inputId}>Message</label>
                </VisuallyHidden>
                <ScrollArea
                    label="Message editor"
                    className={styles.inputScroll}
                    viewportClassName={styles.inputViewport}
                    viewportTabIndex={-1}
                >
                    <textarea
                        id={inputId}
                        ref={textareaRef}
                        rows={2}
                        value={value}
                        disabled={!ready}
                        placeholder={ready ? "Message Pi, or type / for commands" : phase.reason}
                        enterKeyHint="send"
                        className={styles.textarea}
                        onChange={(event) => {
                            setValue(event.target.value);
                            setDismissedSlash(false);
                            setHighlightedId(null);
                            setPointedId(null);
                        }}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                    />
                </ScrollArea>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    tabIndex={-1}
                    aria-hidden="true"
                    className={styles.fileInput}
                    onChange={(event) => {
                        const selected = event.target.files;
                        if (selected !== null && selected.length > 0) {
                            void readImageFiles(Array.from(selected)).then(appendStagedImages);
                        }
                        event.target.value = "";
                    }}
                />
                <div className={styles.controls}>
                    <div className={styles.pickers}>
                        <ModelPicker
                            cacheKey={sessionId ?? "default"}
                            current={phase.kind === "ready" ? phase.model : null}
                            disabled={!ready}
                            open={panel === "model"}
                            onOpenChange={(open) => {
                                setPanel((prev) => (open ? "model" : prev === "model" ? "none" : prev));
                            }}
                            onSendCommand={onSendCommand}
                            onError={(message) => {
                                notify("error", message);
                            }}
                        />
                        <ThinkingLevelPicker
                            cacheKey={sessionId ?? "default"}
                            current={phase.kind === "ready" ? phase.thinkingLevel : null}
                            disabled={!ready}
                            open={panel === "thinking"}
                            onOpenChange={(open) => {
                                setPanel((prev) => (open ? "thinking" : prev === "thinking" ? "none" : prev));
                            }}
                            onSendCommand={onSendCommand}
                            onError={(message) => {
                                notify("error", message);
                            }}
                        />
                    </div>
                    <div className={styles.actions}>
                        <IconButton
                            type="button"
                            label="Attach images"
                            radius="full"
                            disabled={!ready}
                            className={styles.attachButton}
                            onClick={() => {
                                fileInputRef.current?.click();
                            }}
                        >
                            <Paperclip />
                        </IconButton>
                        {hasPendingExtension ? (
                            <span data-slot="extension-prompt-slot" className={styles.extensionSlot}>
                                <IconButton
                                    type="button"
                                    label={`Show extension prompt, ${String(extensionPrompt.count)} waiting`}
                                    radius="full"
                                    className={styles.extensionButton}
                                    onClick={() => {
                                        extensionPrompt.onOpen();
                                    }}
                                >
                                    <MessageCircleQuestion />
                                </IconButton>
                                <span
                                    data-slot="extension-prompt-badge"
                                    className={styles.extensionBadge}
                                    aria-hidden="true"
                                >
                                    <Tabular>{extensionPrompt.count}</Tabular>
                                </span>
                            </span>
                        ) : showSendButton ? (
                            <IconButton
                                type="submit"
                                label={streaming ? "Steer run" : "Send message"}
                                radius="full"
                                disabled={!canSend}
                                className={styles.sendButton}
                            >
                                <ArrowUp />
                            </IconButton>
                        ) : null}
                        {!hasPendingExtension && streaming ? (
                            <IconButton
                                type="button"
                                label="Stop response"
                                radius="full"
                                className={styles.stopButton}
                                onClick={handleAbort}
                            >
                                <Square />
                            </IconButton>
                        ) : null}
                    </div>
                </div>
            </form>
            {litRow !== null && highlightedRow !== null ? (
                <CommandList
                    anchor={cardRef}
                    rows={rows}
                    highlightedId={highlightedRow.id}
                    litId={litRow.id}
                    onPoint={setPointedId}
                    onChoose={chooseCommand}
                />
            ) : null}
        </Popover>
    );
}
