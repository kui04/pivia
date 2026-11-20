import { useCallback, useEffect } from "react";
import { Outlet } from "react-router";

import { Button, LoadingIndicator } from "@components";
import { useAuthStore } from "@/stores/auth/store";

import { AuthGate } from "./AuthGate";
import styles from "./AppLayout.module.css";

/**
 * Root layout route.
 *
 * It checks the single-host auth state once on mount, holds the gate until the state is known, and
 * lets every authenticated page render through the outlet. The check keeps the phase `checking`
 * and records a message when it fails, so a network problem offers a retry instead of the password
 * form.
 */
export function AppLayout() {
    const phase = useAuthStore((state) => state.phase);
    const error = useAuthStore((state) => state.error);
    const submitting = useAuthStore((state) => state.submitting);
    const checkStatus = useAuthStore((state) => state.checkStatus);
    const login = useAuthStore((state) => state.login);

    useEffect(() => {
        void checkStatus();
    }, [checkStatus]);

    const handleLogin = useCallback(
        (password: string) => {
            void login(password);
        },
        [login],
    );

    if (phase === "checking") {
        return (
            <main className={styles.layout}>
                <div className={styles.centered}>
                    {error === null ? (
                        <LoadingIndicator label="Checking authentication" size="lg" />
                    ) : (
                        <section className={styles.errorPanel} role="alert">
                            <h1 className={styles.errorTitle}>Cannot check the sign-in state</h1>
                            <p className={styles.errorText}>{error}</p>
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => {
                                    void checkStatus();
                                }}
                            >
                                Retry
                            </Button>
                        </section>
                    )}
                </div>
            </main>
        );
    }

    if (phase === "unauthenticated") {
        return (
            <main className={styles.layout}>
                <AuthGate error={error} submitting={submitting} onSubmit={handleLogin} />
            </main>
        );
    }

    return (
        <main className={styles.layout}>
            <Outlet />
        </main>
    );
}
