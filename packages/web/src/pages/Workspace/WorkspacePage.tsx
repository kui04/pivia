import { useParams } from "react-router";

import styles from "./WorkspacePage.module.css";

/**
 * The routed workspace column.
 *
 * The no-selection state and the selected-session placeholder keep the final hierarchy: the
 * transcript stage and the composer slot arrive with the chat view.
 */
export function WorkspacePage() {
    const { sessionId } = useParams<{ sessionId?: string }>();

    return (
        <section className={styles.page} aria-label="Session">
            <div className={styles.stage}>
                {sessionId === undefined ? (
                    <div className={styles.empty}>
                        <h2 className={styles.title}>No session selected</h2>
                        <p className={styles.text}>
                            Choose a session from the workspace sidebar. Its transcript opens here.
                        </p>
                    </div>
                ) : (
                    <div className={styles.empty}>
                        <h2 className={styles.title}>Session</h2>
                        <p className={styles.text}>
                            The chat view for this session arrives with the next workspace update.
                        </p>
                        <code className={styles.id}>{sessionId}</code>
                    </div>
                )}
            </div>
            <div className={styles.composerArea}>
                <p className={styles.composerSlot}>The message composer arrives with the chat view.</p>
            </div>
        </section>
    );
}
