import type { CreateSessionOptions, DirectoryListResponse, SessionSummary } from "@pivia/protocol";
import { Check, ChevronRight, Clock, CornerLeftUp, Folder, X } from "lucide-react";
import {
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
    type FormEvent,
    type KeyboardEvent,
    type ReactElement,
    type RefObject,
} from "react";

import {
    AlertDialog,
    Button,
    Dialog,
    DialogActions,
    DialogHeader,
    DialogTitle,
    Drawer,
    Field,
    Form,
    Icon,
    IconButton,
    Input,
    LoadingIndicator,
    ScrollArea,
} from "@components";

import styles from "./CreateSessionDialog.module.css";

const MAX_RECENT_CWDS = 3;

/** Options forwarded when creating a session on the server. */
export type CreateSessionSubmitOptions = CreateSessionOptions;

/** Outcome returned by the caller creating a session on the server. */
export type CreateSessionResult =
    | { readonly ok: true; readonly session: SessionSummary }
    | { readonly ok: false; readonly code: "directory_not_found"; readonly message: string }
    | { readonly ok: false; readonly code: "error"; readonly message: string };

/** Submission state machine preventing duplicate requests and mid-flight dismissal. */
export type CreateSessionSubmission =
    | { readonly kind: "idle" }
    | { readonly kind: "submitting"; readonly cwd: string }
    | { readonly kind: "failed"; readonly message: string };

/** Directory picker state inside the new-session modal. */
type BrowsePhase =
    | { readonly kind: "loading"; readonly path: string | undefined }
    | { readonly kind: "loaded"; readonly listing: DirectoryListResponse }
    | { readonly kind: "error"; readonly path: string | undefined; readonly message: string };

export interface CreateSessionDialogProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly knownCwds: readonly string[];
    readonly narrow: boolean;
    readonly onListDirectories: (path?: string) => Promise<DirectoryListResponse>;
    readonly onCreate: (cwd: string, options?: CreateSessionSubmitOptions) => Promise<CreateSessionResult>;
}

function joinDirectoryPath(parentPath: string, childName: string): string {
    if (parentPath.endsWith("/") || parentPath.endsWith("\\")) {
        return `${parentPath}${childName}`;
    }
    const separator = parentPath.includes("\\") ? "\\" : "/";
    return `${parentPath}${separator}${childName}`;
}

function runDirectoryFetch(
    listDirectories: (path?: string) => Promise<DirectoryListResponse>,
    targetPath: string | undefined,
    requestSeqRef: RefObject<number>,
    onLoaded: (listing: DirectoryListResponse) => void,
    onError: (message: string) => void,
): void {
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;

    void listDirectories(targetPath)
        .then((listing) => {
            if (requestSeqRef.current !== seq) {
                return;
            }
            onLoaded(listing);
        })
        .catch((error: unknown) => {
            if (requestSeqRef.current !== seq) {
                return;
            }
            onError(error instanceof Error ? error.message : String(error));
        });
}

interface CreateSessionBodyProps {
    readonly knownCwds: readonly string[];
    readonly narrow: boolean;
    readonly onListDirectories: (path?: string) => Promise<DirectoryListResponse>;
    readonly onCreate: (cwd: string, options?: CreateSessionSubmitOptions) => Promise<CreateSessionResult>;
    readonly onRequestClose: () => void;
    readonly onBusyChange: (busy: boolean) => void;
}

/**
 * Mounted only while the dialog or sheet is open so every open seeds the working directory from the
 * catalog at that moment and starts one server directory listing. Later catalog changes must not
 * replace the browser while the user picks a path.
 */
function CreateSessionBody({
    knownCwds,
    narrow,
    onListDirectories,
    onCreate,
    onRequestClose,
    onBusyChange,
}: CreateSessionBodyProps): ReactElement {
    const recentCwds = knownCwds.slice(0, MAX_RECENT_CWDS);
    const initialCwd = recentCwds[0] ?? "";

    const [cwd, setCwd] = useState(initialCwd);
    const initialCwdRef = useRef(initialCwd);
    const [submission, setSubmission] = useState<CreateSessionSubmission>({ kind: "idle" });
    const [browse, setBrowse] = useState<BrowsePhase>(() => ({
        kind: "loading",
        path: initialCwd === "" ? undefined : initialCwd,
    }));
    const [lastListing, setLastListing] = useState<DirectoryListResponse | null>(null);
    const [confirmCreatePath, setConfirmCreatePath] = useState<string | null>(null);

    const recentLabelId = useId();
    const browseLabelId = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const browseSectionRef = useRef<HTMLElement>(null);
    const requestSeqRef = useRef(0);
    const userEditedRef = useRef(false);
    const submitting = submission.kind === "submitting";

    useEffect(() => {
        onBusyChange(submitting || confirmCreatePath !== null);
    }, [confirmCreatePath, onBusyChange, submitting]);

    const requestDirectory = (targetPath: string | undefined): void => {
        runDirectoryFetch(
            onListDirectories,
            targetPath,
            requestSeqRef,
            (listing) => {
                setLastListing(listing);
                setBrowse({ kind: "loaded", listing });
            },
            (message) => {
                setBrowse({ kind: "error", path: targetPath, message });
            },
        );
    };

    useEffect(() => {
        const startPath = initialCwdRef.current === "" ? undefined : initialCwdRef.current;
        runDirectoryFetch(
            onListDirectories,
            startPath,
            requestSeqRef,
            (listing) => {
                setLastListing(listing);
                setBrowse({ kind: "loaded", listing });
                if (!userEditedRef.current) {
                    setCwd((current) => (current.trim() === "" ? listing.path : current));
                }
            },
            (message) => {
                setBrowse({ kind: "error", path: startPath, message });
            },
        );
        return () => {
            requestSeqRef.current += 1;
        };
    }, [onListDirectories]);

    const submitPath = async (targetPath: string, createDirectory: boolean): Promise<void> => {
        setSubmission({ kind: "submitting", cwd: targetPath });
        try {
            const result = await onCreate(targetPath, createDirectory ? { createDirectory: true } : undefined);
            if (result.ok) {
                setSubmission({ kind: "idle" });
                onRequestClose();
                return;
            }
            if (result.code === "directory_not_found" && !createDirectory) {
                setSubmission({ kind: "idle" });
                setConfirmCreatePath(targetPath);
                return;
            }
            setSubmission({ kind: "failed", message: result.message });
        } catch (error) {
            setSubmission({
                kind: "failed",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };

    const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
        event.preventDefault();
        if (submitting) {
            return;
        }
        const trimmed = cwd.trim();
        if (trimmed === "") {
            setSubmission({ kind: "failed", message: "Enter a working directory path." });
            return;
        }
        void submitPath(trimmed, false);
    };

    const selectRecent = (recentPath: string): void => {
        userEditedRef.current = true;
        setCwd(recentPath);
        if (submission.kind === "failed") {
            setSubmission({ kind: "idle" });
        }
    };

    const browseInto = (nextPath: string): void => {
        userEditedRef.current = true;
        setCwd(nextPath);
        if (submission.kind === "failed") {
            setSubmission({ kind: "idle" });
        }
        setBrowse({ kind: "loading", path: nextPath });
        const viewport = viewportRef.current;
        const browseSection = browseSectionRef.current;
        if (viewport !== null && browseSection !== null && viewport.scrollTop > browseSection.offsetTop) {
            viewport.scrollTop = browseSection.offsetTop;
        }
        requestDirectory(nextPath);
    };

    const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        const composing = event.nativeEvent.isComposing || event.keyCode === 229;
        if (!composing) {
            return;
        }
        // Let the active IME dismiss its candidate bar or confirm text without closing or submitting the modal.
        if (event.key === "Escape") {
            event.stopPropagation();
            event.nativeEvent.stopPropagation();
        } else if (event.key === "Enter") {
            event.preventDefault();
        }
    };

    const activeListing = browse.kind === "loaded" ? browse.listing : browse.kind === "loading" ? lastListing : null;
    const isRefreshing = browse.kind === "loading" && lastListing !== null;

    const actionButtons = (
        <>
            <Button
                type="button"
                variant="secondary"
                disabled={submitting}
                className={narrow ? styles.sheetAction : styles.dialogAction}
                onClick={onRequestClose}
            >
                Cancel
            </Button>
            <Button type="submit" disabled={submitting} className={narrow ? styles.sheetAction : styles.dialogAction}>
                {submitting ? "Creating..." : "Create session"}
            </Button>
        </>
    );

    return (
        <>
            <Form
                aria-busy={submitting ? true : undefined}
                className={styles.form}
                onSubmit={(event) => {
                    handleSubmit(event);
                }}
            >
                <div className={styles.inputBand}>
                    <Field
                        label="Working directory"
                        name="cwd"
                        {...(submission.kind === "failed" ? { error: submission.message } : {})}
                    >
                        <div className={styles.inputShell}>
                            <Icon className={styles.inputIcon} size="no-container">
                                <Folder />
                            </Icon>
                            <Input
                                ref={inputRef}
                                autoFocus={!narrow}
                                value={cwd}
                                disabled={submitting}
                                placeholder="/path/to/project"
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                enterKeyHint="go"
                                className={styles.pathInput}
                                onKeyDown={handleInputKeyDown}
                                onChange={(event) => {
                                    userEditedRef.current = true;
                                    setCwd(event.currentTarget.value);
                                    if (submission.kind === "failed") {
                                        setSubmission({ kind: "idle" });
                                    }
                                }}
                            />
                            {cwd !== "" ? (
                                <IconButton
                                    type="button"
                                    label="Clear path"
                                    size="sm"
                                    radius="small"
                                    disabled={submitting}
                                    className={styles.clearButton}
                                    onClick={() => {
                                        userEditedRef.current = true;
                                        setCwd("");
                                        if (submission.kind === "failed") {
                                            setSubmission({ kind: "idle" });
                                        }
                                        inputRef.current?.focus();
                                    }}
                                >
                                    <X />
                                </IconButton>
                            ) : null}
                        </div>
                    </Field>
                </div>

                <div className={styles.directoryArea}>
                    <ScrollArea
                        label="Directories on server"
                        landmark
                        viewportRef={viewportRef}
                        className={styles.directoryScroll}
                        viewportClassName={styles.directoryViewport}
                        contentClassName={styles.directoryContent}
                    >
                        {recentCwds.length > 0 ? (
                            <section className={styles.section} aria-labelledby={recentLabelId}>
                                <div className={styles.sectionHeader}>
                                    <p id={recentLabelId} className={styles.sectionLabel}>
                                        Recent
                                    </p>
                                </div>
                                <div className={styles.rowList}>
                                    {recentCwds.map((dir) => {
                                        const selected = cwd === dir;
                                        return (
                                            <button
                                                key={dir}
                                                type="button"
                                                className={styles.rowButton}
                                                disabled={submitting}
                                                aria-pressed={selected}
                                                onClick={() => {
                                                    selectRecent(dir);
                                                }}
                                            >
                                                <Icon className={styles.rowIcon} size="no-container">
                                                    <Clock />
                                                </Icon>
                                                <span className={styles.rowLabel}>{dir}</span>
                                                {selected ? (
                                                    <Icon className={styles.rowCheck} size="sm">
                                                        <Check />
                                                    </Icon>
                                                ) : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        ) : null}

                        <section ref={browseSectionRef} className={styles.section} aria-labelledby={browseLabelId}>
                            <div className={styles.sectionHeader}>
                                <p id={browseLabelId} className={styles.sectionLabel}>
                                    Browse
                                </p>
                                {isRefreshing ? <LoadingIndicator size="sm" label="Loading directories" /> : null}
                            </div>

                            {browse.kind === "error" ? (
                                <div className={styles.browserErrorRow} role="status">
                                    <p className={styles.browserError}>{browse.message}</p>
                                    <div className={styles.browserErrorActions}>
                                        {lastListing !== null ? (
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                disabled={submitting}
                                                onClick={() => {
                                                    setBrowse({ kind: "loaded", listing: lastListing });
                                                    setCwd(lastListing.path);
                                                }}
                                            >
                                                Back
                                            </Button>
                                        ) : null}
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            disabled={submitting}
                                            onClick={() => {
                                                setBrowse({ kind: "loading", path: browse.path });
                                                requestDirectory(browse.path);
                                            }}
                                        >
                                            Retry
                                        </Button>
                                    </div>
                                </div>
                            ) : activeListing === null ? (
                                <p className={styles.browserStatus} role="status">
                                    Loading directories…
                                </p>
                            ) : (
                                <div className={styles.rowList} data-loading={isRefreshing ? "true" : undefined}>
                                    {activeListing.parent !== null ? (
                                        <button
                                            type="button"
                                            className={styles.rowButton}
                                            disabled={submitting}
                                            title="Go to parent directory"
                                            onClick={() => {
                                                if (activeListing.parent !== null) {
                                                    browseInto(activeListing.parent);
                                                }
                                            }}
                                        >
                                            <Icon className={styles.rowIcon} size="no-container">
                                                <CornerLeftUp />
                                            </Icon>
                                            <span className={styles.rowLabel}>..</span>
                                        </button>
                                    ) : null}
                                    {activeListing.directories.map((entry) => {
                                        const childPath = joinDirectoryPath(activeListing.path, entry);
                                        return (
                                            <button
                                                key={entry}
                                                type="button"
                                                className={styles.rowButton}
                                                disabled={submitting}
                                                onClick={() => {
                                                    browseInto(childPath);
                                                }}
                                            >
                                                <Icon className={styles.rowIcon} size="no-container">
                                                    <Folder />
                                                </Icon>
                                                <span className={styles.rowLabel}>{entry}</span>
                                                <Icon className={styles.rowChevron} size="sm">
                                                    <ChevronRight />
                                                </Icon>
                                            </button>
                                        );
                                    })}
                                    {activeListing.directories.length === 0 ? (
                                        <p className={styles.browserEmpty}>No subdirectories</p>
                                    ) : null}
                                    {activeListing.truncated ? (
                                        <p className={styles.browserStatus}>
                                            List truncated — enter a deeper path to narrow.
                                        </p>
                                    ) : null}
                                </div>
                            )}
                        </section>
                    </ScrollArea>
                </div>

                {narrow ? (
                    <div className={styles.footer}>{actionButtons}</div>
                ) : (
                    <DialogActions className={styles.footer}>{actionButtons}</DialogActions>
                )}
            </Form>

            <AlertDialog
                open={confirmCreatePath !== null}
                onOpenChange={(nextOpen) => {
                    if (!nextOpen) {
                        setConfirmCreatePath(null);
                    }
                }}
                title="Create directory?"
                description="This directory does not exist on the server yet. Create it and start the session there?"
                cancelLabel="Cancel"
                confirmLabel="Create & start"
                confirmDisabled={submitting}
                onConfirm={() => {
                    if (confirmCreatePath !== null) {
                        const target = confirmCreatePath;
                        setConfirmCreatePath(null);
                        void submitPath(target, true);
                    }
                }}
            >
                {confirmCreatePath === null ? null : <code className={styles.confirmPath}>{confirmCreatePath}</code>}
            </AlertDialog>
        </>
    );
}

/**
 * Responsive new-session modal: centered Dialog on desktop and bottom-sheet Drawer on narrow screens,
 * keeping the header, working-directory input, and submit actions pinned while the directory list scrolls.
 */
export function CreateSessionDialog({
    open,
    onOpenChange,
    knownCwds,
    narrow,
    onListDirectories,
    onCreate,
}: CreateSessionDialogProps): ReactElement {
    const busyRef = useRef(false);

    const handleBusyChange = useCallback((busy: boolean): void => {
        busyRef.current = busy;
    }, []);

    const handleOpenChange = useCallback(
        (nextOpen: boolean): void => {
            if (!nextOpen && busyRef.current) {
                return;
            }
            onOpenChange(nextOpen);
        },
        [onOpenChange],
    );

    const closeModal = useCallback((): void => {
        busyRef.current = false;
        onOpenChange(false);
    }, [onOpenChange]);

    const body = open ? (
        <CreateSessionBody
            knownCwds={knownCwds}
            narrow={narrow}
            onListDirectories={onListDirectories}
            onCreate={onCreate}
            onRequestClose={closeModal}
            onBusyChange={handleBusyChange}
        />
    ) : null;

    if (narrow) {
        return (
            <Drawer
                open={open}
                onOpenChange={handleOpenChange}
                side="bottom"
                label="New session"
                className={styles.sheet}
            >
                {/* Keep the static header outside CreateSessionBody so exit animations never flash a blank sheet. */}
                <div className={styles.sheetHeader}>
                    <div className={styles.grabber} aria-hidden="true" />
                    <h2 className={styles.sheetTitle}>New session</h2>
                </div>
                {body}
            </Drawer>
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange} className={styles.dialog}>
            <DialogHeader className={styles.dialogHeader}>
                <DialogTitle>New session</DialogTitle>
            </DialogHeader>
            {body}
        </Dialog>
    );
}
