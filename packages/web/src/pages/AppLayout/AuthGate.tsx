import { Button, Field, Form, Input } from "@components";
import { useFontRole } from "@/hooks";

import styles from "./AuthGate.module.css";

/** Props of the single-host password gate. */
export interface AuthGateProps {
    /** The message from a failed sign-in, or `null`. */
    readonly error: string | null;
    /** True while the login request runs. */
    readonly submitting: boolean;
    /** Receives the password after the form validates. */
    readonly onSubmit: (password: string) => void;
}

/** Reads the password from the values Base UI Form collected. */
function passwordFrom(values: Record<string, unknown>): string | null {
    const password = values["password"];
    return typeof password === "string" && password !== "" ? password : null;
}

/**
 * The password gate of the single host.
 *
 * The gate is presentational: the caller owns the auth phase, the submitting flag and the error.
 * It renders a real form, so Enter submits and the browser keeps the password field's autofill
 * contract. A successful login replaces the gate with the workspace outlet in `AppLayout`.
 */
export function AuthGate({ error, submitting, onSubmit }: AuthGateProps) {
    useFontRole("serif");
    return (
        <div className={styles.auth}>
            <section className={styles.panel} aria-labelledby="auth-gate-title">
                <h1 id="auth-gate-title" className={styles.title}>
                    Sign in to your workspace
                </h1>
                <p className={styles.lead}>
                    Enter the password configured for this host. Your sessions stay on this machine.
                </p>
                <Form
                    aria-busy={submitting ? true : undefined}
                    onFormSubmit={(values) => {
                        const password = passwordFrom(values);
                        if (password !== null) {
                            onSubmit(password);
                        }
                    }}
                >
                    <Field
                        label="Password"
                        name="password"
                        description="The server checks this password before it opens the API."
                        {...(error === null ? {} : { error })}
                    >
                        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- The gate opens with focus in its only field. */}
                        <Input type="password" autoComplete="current-password" autoFocus required />
                    </Field>
                    <Button type="submit" className={styles.submit} disabled={submitting}>
                        {submitting ? "Signing in..." : "Sign in"}
                    </Button>
                </Form>
            </section>
        </div>
    );
}
