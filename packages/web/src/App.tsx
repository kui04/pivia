import styles from "./App.module.css";

/**
 * The placeholder the first web build renders. The workspace shell, routes and
 * session views replace it in the next phase; it exists so the build produces a
 * usable page instead of an empty root.
 */
export function App() {
    return (
        <main className={styles.app}>
            <section className={styles.panel}>
                <p className={styles.eyebrow}>Pivia</p>
                <h1 className={styles.title}>Your pi workspace, in the browser.</h1>
                <p className={styles.lead}>
                    The design tokens, icons and form primitives are in place. Routes, sessions and chat arrive in the
                    next phase.
                </p>
            </section>
        </main>
    );
}
