import type { DirectoryListResponse, SessionSummary } from "@pivia/protocol";
import { ArrowUp, Clock, Folder } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from "react";

import {
    AlertDialog,
    Button,
    Dialog,
    DialogActions,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Drawer,
    Field,
    Form,
    Icon,
    Input,
    ScrollArea,
} from "@components";

import styles from "./CreateSessionDialog.module.css";

const MAX_RECENT_CWDS = 3;

/** Options forwarded when creating a session on the server. */
export interface CreateSessionSubmitOptions {
    readonly createDirectory?: boolean | undefined;
}

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
    const [confirmCreatePath, setConfirmCreatePath] = useState<string | null>(null);

    const recentLabelId = useId();
    const browseLabelId = useId();
    const requestSeqRef = useRef(0);
    const userEditedRef = useRef(false);
    const submitting = submission.kind === "submitting";

    useEffect(() => {
        onBusyChange(submitting || confirmCreatePath !== null);
    }, [confirmCreatePath, onBusyChange, submitting]);

    const fetchDirectory = useCallback(
        (targetPath: string | undefined, seedEmptyInput: boolean): void => {
            const seq = requestSeqRef.current + 1;
            requestSeqRef.current = seq;

            void onListDirectories(targetPath)
                .then((listing) => {
                    if (requestSeqRef.current !== seq) {
                        return;
                    }
                    setBrowse({ kind: "loaded", listing });
                    if (seedEmptyInput && !userEditedRef.current) {
                        setCwd((current) => (current.trim() === "" ? listing.path : current));
                    }
                })
                .catch((error: unknown) => {
                    if (requestSeqRef.current !== seq) {
                        return;
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    setBrowse({ kind: "error", path: targetPath, message });
                });
        },
        [onListDirectories],
    );

    useEffect(() => {
        const startPath = initialCwdRef.current === "" ? undefined : initialCwdRef.current;
        fetchDirectory(startPath, true);
        return () => {
            requestSeqRef.current += 1;
        };
    }, [fetchDirectory]);

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

    const selectDirectory = (nextPath: string): void => {
        userEditedRef.current = true;
        setCwd(nextPath);
        if (submission.kind === "failed") {
            setSubmission({ kind: "idle" });
        }
        setBrowse({ kind: "loading", path: nextPath });
        fetchDirectory(nextPath, false);
    };

    const currentBrowsePath =
        browse.kind === "loaded" ? browse.listing.path : browse.path !== undefined ? browse.path : "Server root";

    const actionButtons = (
        <>
            <Button type="button" variant="secondary" disabled={submitting} onClick={onRequestClose}>
                Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
                {submitting ? "Creating..." : "Create session"}
            </Button>
        </>
    );

    return (
        <>
            <Form
                aria-busy={submitting ? true : undefined}
                className={narrow ? styles.formScroll : undefined}
                onSubmit={(event) => {
                    handleSubmit(event);
                }}
            >
                <Field
                    label="Working directory"
                    name="cwd"
                    description="Absolute path on the server. The entered path is used directly."
                    {...(submission.kind === "failed" ? { error: submission.message } : {})}
                >
                    <Input
                        autoFocus={!narrow}
                        value={cwd}
                        disabled={submitting}
                        placeholder="/path/to/project"
                        autoComplete="off"
                        onChange={(event) => {
                            userEditedRef.current = true;
                            setCwd(event.currentTarget.value);
                            if (submission.kind === "failed") {
                                setSubmission({ kind: "idle" });
                            }
                        }}
                    />
                </Field>

                {recentCwds.length > 0 ? (
                    <section className={styles.section} aria-labelledby={recentLabelId}>
                        <p id={recentLabelId} className={styles.sectionLabel}>
                            Recent
                        </p>
                        <div className={styles.recentList}>
                            {recentCwds.map((dir) => (
                                <button
                                    key={dir}
                                    type="button"
                                    className={styles.rowButton}
                                    disabled={submitting}
                                    aria-pressed={cwd === dir}
                                    onClick={() => {
                                        selectDirectory(dir);
                                    }}
                                >
                                    <Icon className={styles.rowIcon} size="sm">
                                        <Clock />
                                    </Icon>
                                    <span className={styles.rowLabel}>{dir}</span>
                                </button>
                            ))}
                        </div>
                    </section>
                ) : null}

                <section className={styles.section} aria-labelledby={browseLabelId}>
                    <div className={styles.sectionHeader}>
                        <p id={browseLabelId} className={styles.sectionLabel}>
                            Browse
                        </p>
                        <code className={styles.currentPath} title={currentBrowsePath}>
                            {currentBrowsePath}
                        </code>
                    </div>
                    <div className={styles.browserBox}>
                        <ScrollArea
                            label="Directories on server"
                            landmark
                            className={styles.browserScroll}
                            contentClassName={styles.browserContent}
                        >
                            {browse.kind === "loading" ? (
                                <p className={styles.browserStatus} role="status">
                                    Loading directories…
                                </p>
                            ) : browse.kind === "error" ? (
                                <p className={styles.browserError} role="status">
                                    {browse.message}
                                </p>
                            ) : (
                                <>
                                    {browse.listing.parent !== null ? (
                                        <button
                                            type="button"
                                            className={styles.rowButton}
                                            disabled={submitting}
                                            title="Go to parent directory"
                                            onClick={() => {
                                                if (browse.listing.parent !== null) {
                                                    selectDirectory(browse.listing.parent);
                                                }
                                            }}
                                        >
                                            <Icon className={styles.rowIcon} size="sm">
                                                <ArrowUp />
                                            </Icon>
                                            <span className={styles.rowLabel}>..</span>
                                        </button>
                                    ) : null}
                                    {browse.listing.directories.map((entry) => {
                                        const childPath = joinDirectoryPath(browse.listing.path, entry);
                                        return (
                                            <button
                                                key={entry}
                                                type="button"
                                                className={styles.rowButton}
                                                disabled={submitting}
                                                aria-pressed={cwd === childPath}
                                                onClick={() => {
                                                    selectDirectory(childPath);
                                                }}
                                            >
                                                <Icon className={styles.rowIcon} size="sm">
                                                    <Folder />
                                                </Icon>
                                                <span className={styles.rowLabel}>{entry}</span>
                                            </button>
                                        );
                                    })}
                                    {browse.listing.directories.length === 0 ? (
                                        <p className={styles.browserEmpty}>No subdirectories</p>
                                    ) : null}
                                    {browse.listing.truncated ? (
                                        <p className={styles.browserStatus}>
                                            This folder has more directories than the browser shows. Narrow the path to
                                            find the rest.
                                        </p>
                                    ) : null}
                                </>
                            )}
                        </ScrollArea>
                    </div>
                </section>

                {narrow ? (
                    <div className={styles.actions}>{actionButtons}</div>
                ) : (
                    <DialogActions>{actionButtons}</DialogActions>
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
 * combining direct path entry, up to three recent directories, and live host directory browsing.
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
                <div className={styles.sheetHeader}>
                    <h2 className={styles.sheetTitle}>New session</h2>
                    <p className={styles.sheetDescription}>Choose or enter a server working directory.</p>
                </div>
                {body}
            </Drawer>
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange} className={styles.dialog}>
            <DialogHeader>
                <DialogTitle>New session</DialogTitle>
                <DialogDescription>Choose or enter a server working directory.</DialogDescription>
            </DialogHeader>
            {body}
        </Dialog>
    );
}
