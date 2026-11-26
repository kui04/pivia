import { assertNever } from "@pivia/protocol";
import type { ReactElement } from "react";

import { Button, Dialog, DialogActions, DialogDescription, DialogHeader, DialogTitle } from "@components";
import type { CatalogSyncPhase } from "@/stores/workspace";

import styles from "./SettingsDialog.module.css";

/** Single-host auth action: `none` when `--no-auth` is enabled, avoiding impossible boolean combos. */
export type SettingsAuthAction =
    | { readonly kind: "none" }
    | { readonly kind: "sign-out"; readonly pending: boolean; readonly onSignOut: () => void };

export interface SettingsDialogProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly origin: string;
    readonly sessionCount: number;
    readonly updatedAtMs: number | null;
    readonly sync: CatalogSyncPhase;
    readonly onRefresh: () => void;
    readonly authAction: SettingsAuthAction;
}

function formatSyncStatus(sync: CatalogSyncPhase): string {
    switch (sync.kind) {
        case "idle":
            return "Idle";
        case "syncing":
            return "Refreshing…";
        case "live":
            return "Connected";
        case "reconnecting":
            return `Reconnecting (attempt ${String(sync.attempt)})…`;
        case "failed":
            return `Error: ${sync.message}`;
        default:
            return assertNever(sync, "Unknown workspace sync phase");
    }
}

/**
 * Single-host workspace status and actions (catalog refresh and optional sign-out).
 */
export function SettingsDialog({
    open,
    onOpenChange,
    origin,
    sessionCount,
    updatedAtMs,
    sync,
    onRefresh,
    authAction,
}: SettingsDialogProps): ReactElement {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogHeader>
                <DialogTitle>Workspace settings</DialogTitle>
                <DialogDescription>This Pivia server and its live session catalog.</DialogDescription>
            </DialogHeader>
            <dl className={styles.facts}>
                <dt className={styles.term}>Host</dt>
                <dd className={styles.value}>{origin}</dd>
                <dt className={styles.term}>Connection</dt>
                <dd className={styles.value}>{formatSyncStatus(sync)}</dd>
                <dt className={styles.term}>Sessions</dt>
                <dd className={styles.value}>{String(sessionCount)}</dd>
                <dt className={styles.term}>Last updated</dt>
                <dd className={styles.value}>
                    {updatedAtMs === null ? "Never" : new Date(updatedAtMs).toLocaleString()}
                </dd>
            </dl>
            <DialogActions>
                <Button type="button" variant="secondary" disabled={sync.kind === "syncing"} onClick={onRefresh}>
                    Refresh now
                </Button>
                {authAction.kind === "sign-out" ? (
                    <Button
                        type="button"
                        variant="secondary"
                        disabled={authAction.pending}
                        onClick={authAction.onSignOut}
                    >
                        {authAction.pending ? "Signing out…" : "Sign out"}
                    </Button>
                ) : null}
            </DialogActions>
        </Dialog>
    );
}
