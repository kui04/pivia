import { useCallback, useState } from "react";
import { Outlet, useParams } from "react-router";

import { Button } from "@components";
import { showError } from "@/lib/toast";
import { useAuthStore, useWorkspaceStore } from "@/stores";

import styles from "./WorkspaceLayout.module.css";

/**
 * The workspace shell.
 *
 * It owns the topbar and renders the routed column through its outlet, so the shell stays mounted
 * while the active session changes. The sidebar, session list and settings dialog arrive in the
 * next workspace step; this shell keeps their place and proves the logout path back to the gate.
 */
export function WorkspaceLayout() {
    const { sessionId } = useParams<{ sessionId?: string }>();
    const authRequired = useAuthStore((state) => state.authRequired);
    const clearError = useAuthStore((state) => state.clearError);
    const logout = useAuthStore((state) => state.logout);
    const [signingOut, setSigningOut] = useState(false);

    const handleSignOut = useCallback(async () => {
        if (signingOut) {
            return;
        }
        setSigningOut(true);
        clearError();
        await logout();

        const auth = useAuthStore.getState();
        if (auth.phase === "unauthenticated") {
            useWorkspaceStore.getState().reset();
            // AppLayout replaces this shell with the gate on the same state change.
            return;
        }

        setSigningOut(false);
        if (auth.error !== null) {
            showError({
                id: "auth-logout",
                title: "Cannot sign out",
                description: auth.error,
            });
        }
    }, [clearError, logout, signingOut]);

    return (
        <div className={styles.window}>
            <header className={styles.topbar}>
                <span className={styles.context}>
                    {sessionId === undefined ? "No session selected" : `Session ${sessionId}`}
                </span>
                {authRequired ? (
                    <Button
                        type="button"
                        variant="secondary"
                        disabled={signingOut}
                        onClick={() => {
                            void handleSignOut();
                        }}
                    >
                        {signingOut ? "Signing out..." : "Sign out"}
                    </Button>
                ) : null}
            </header>
            <div className={styles.body}>
                <Outlet />
            </div>
        </div>
    );
}
