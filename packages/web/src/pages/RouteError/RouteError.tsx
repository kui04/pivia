import { isRouteErrorResponse, Link, useRouteError } from "react-router";

import styles from "./RouteError.module.css";

/**
 * Turns whatever the router caught into one line of text. A router response keeps its status, an
 * exception keeps its message, and anything else is named as unknown instead of being swallowed.
 */
function describeError(error: unknown): string {
    if (isRouteErrorResponse(error)) {
        const statusText = error.statusText.trim();
        return statusText === "" ? String(error.status) : `${String(error.status)} ${statusText}`;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return "Unknown error";
}

/**
 * Root error boundary. A render error, a rejected route import and a URL that matches no route all
 * render this page, so the browser never falls back to a blank root.
 */
export function RouteError() {
    const error = useRouteError();
    const title = isRouteErrorResponse(error) && error.status === 404 ? "Page not found" : "Something went wrong";

    return (
        <main className={styles.page}>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.message}>{describeError(error)}</p>
            <Link className={styles.link} to="/workspace">
                Back to the workspace
            </Link>
        </main>
    );
}
