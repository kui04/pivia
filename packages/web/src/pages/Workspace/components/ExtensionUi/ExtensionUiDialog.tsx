import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { assertNever, type ExtensionDialogRequest } from "@pivia/protocol";
import { Minus } from "lucide-react";
import { useRef, useState, type ReactElement, type ReactNode } from "react";

import {
    Button,
    Dialog,
    DialogActions,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Field,
    Form,
    IconButton,
    Input,
    RadioGroup,
    RadioGroupItem,
} from "@components";
import { isImeComposition } from "@/lib";

import styles from "./ExtensionUiDialog.module.css";

/** Props of the modal that renders one pending extension dialog. */
export interface ExtensionUiDialogProps {
    /** Whether the modal portal is open; defaults to `true`. */
    readonly open?: boolean | undefined;
    /** Oldest pending dialog of this session. */
    readonly request: ExtensionDialogRequest;
    /** True after this client sent an answer or while the connection is not open. */
    readonly pending: boolean;
    /** Sending failure to show without closing the dialog. */
    readonly error: string | null;
    /** Whole seconds left before the extension's own timeout, or `null` when it set none. */
    readonly remainingSeconds: number | null;
    /**
     * Reply for the request, built inside the branch that owns the method.
     *
     * Each dialog branch constructs the payload its method expects, so a `confirmed` reply can
     * never answer a `select` and the page only forwards the envelope.
     */
    readonly onReply: (reply: RpcExtensionUIResponse) => void;
    /** Close the modal; the composer keeps the prompt button while the request stays pending. */
    readonly onMinimize: () => void;
}

interface DialogFormProps {
    readonly pending: boolean;
    readonly confirmDisabled?: boolean | undefined;
    readonly onSubmit: () => void;
    readonly onCancel: () => void;
    readonly children?: ReactNode | undefined;
}

function DialogForm({ pending, confirmDisabled = false, onSubmit, onCancel, children }: DialogFormProps): ReactElement {
    return (
        <Form onFormSubmit={onSubmit}>
            {children}
            <DialogActions>
                <Button type="button" variant="secondary" disabled={pending} onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="submit" disabled={pending || confirmDisabled}>
                    Confirm
                </Button>
            </DialogActions>
        </Form>
    );
}

/**
 * Modal that renders one pending extension dialog.
 *
 * `select` uses a radio group with an explicit confirm action, `confirm` shows the message with
 * Confirm and Cancel, `input` uses a single-line field, and `editor` uses a multiline textarea
 * where Enter submits and Shift+Enter adds a line. Every branch builds the reply its method
 * expects, so the page only forwards the envelope.
 *
 * Mount with `key={request.id}` so per-request draft state resets when the next dialog opens.
 */
export function ExtensionUiDialog({
    open = true,
    request,
    pending,
    error,
    remainingSeconds,
    onReply,
    onMinimize,
}: ExtensionUiDialogProps): ReactElement {
    const [selected, setSelected] = useState<string | null>(null);
    const [value, setValue] = useState("");
    const [text, setText] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
    const inputRef = useRef<HTMLInputElement>(null);
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const initialFocus = request.method === "input" ? inputRef : request.method === "editor" ? editorRef : undefined;

    const cancel = (): void => {
        onReply({ type: "extension_ui_response", id: request.id, cancelled: true });
    };
    const countdown = remainingSeconds === null ? null : `Closes in ${String(remainingSeconds)}s.`;
    const description =
        request.method === "confirm"
            ? [request.message, countdown].filter((part) => part !== null).join(" ")
            : countdown;

    const renderBody = (): ReactElement => {
        switch (request.method) {
            case "select":
                return (
                    <DialogForm
                        pending={pending}
                        confirmDisabled={selected === null}
                        onSubmit={() => {
                            if (selected !== null) {
                                onReply({ type: "extension_ui_response", id: request.id, value: selected });
                            }
                        }}
                        onCancel={cancel}
                    >
                        {request.options.length === 0 ? (
                            <p className={styles.note}>This extension provided no options.</p>
                        ) : (
                            <RadioGroup
                                ariaLabel={request.title}
                                value={selected}
                                onValueChange={setSelected}
                                disabled={pending}
                            >
                                {request.options.map((option, index) => (
                                    <RadioGroupItem key={`${String(index)}-${option}`} value={option}>
                                        {option}
                                    </RadioGroupItem>
                                ))}
                            </RadioGroup>
                        )}
                    </DialogForm>
                );
            case "confirm":
                return (
                    <DialogForm
                        pending={pending}
                        onSubmit={() => {
                            onReply({ type: "extension_ui_response", id: request.id, confirmed: true });
                        }}
                        onCancel={cancel}
                    />
                );
            case "input":
                return (
                    <DialogForm
                        pending={pending}
                        onSubmit={() => {
                            onReply({ type: "extension_ui_response", id: request.id, value });
                        }}
                        onCancel={cancel}
                    >
                        <Field name="extensionInput" label="Your answer">
                            <Input
                                ref={inputRef}
                                value={value}
                                disabled={pending}
                                placeholder={request.placeholder}
                                onChange={(event) => {
                                    setValue(event.target.value);
                                }}
                            />
                        </Field>
                    </DialogForm>
                );
            case "editor":
                return (
                    <DialogForm
                        pending={pending}
                        onSubmit={() => {
                            onReply({ type: "extension_ui_response", id: request.id, value: text });
                        }}
                        onCancel={cancel}
                    >
                        <textarea
                            ref={editorRef}
                            aria-label="Editor content"
                            className={styles.editor}
                            rows={6}
                            value={text}
                            disabled={pending}
                            onChange={(event) => {
                                setText(event.target.value);
                            }}
                            onKeyDown={(event) => {
                                if (pending || isImeComposition(event.nativeEvent)) {
                                    return;
                                }
                                if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    onReply({ type: "extension_ui_response", id: request.id, value: text });
                                }
                            }}
                        />
                    </DialogForm>
                );
            default:
                return assertNever(request);
        }
    };

    return (
        <Dialog
            open={open}
            initialFocus={initialFocus}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && !pending) {
                    cancel();
                }
            }}
        >
            <div className={styles.headerRow}>
                <DialogHeader>
                    <DialogTitle>{request.title}</DialogTitle>
                    {description !== null && description !== "" ? (
                        <DialogDescription>{description}</DialogDescription>
                    ) : null}
                </DialogHeader>
                <IconButton type="button" label="Minimize prompt" radius="full" onClick={onMinimize}>
                    <Minus />
                </IconButton>
            </div>
            {renderBody()}
            {error !== null ? (
                <p role="alert" className={styles.error}>
                    {error}
                </p>
            ) : null}
        </Dialog>
    );
}
