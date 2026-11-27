import type { Decorator } from "@storybook/react-vite";
import type { ReactNode } from "react";

import styles from "./frames.module.css";

/**
 * Sizes a story to the transcript column. A story that renders one transcript row uses it so the
 * row lays out as it does inside the chat pane.
 */
export const TranscriptFrame: Decorator = (Story) => (
    <div className={styles.frame}>
        <Story />
    </div>
);

/**
 * Lays out story children in a centered row.
 *
 * `gap` takes a spacing token value so a row keeps the rhythm of the component under test while
 * each story still chooses its own separation.
 */
export function StoryRow({ gap = "var(--space-16)", children }: { gap?: string | undefined; children: ReactNode }) {
    return <div style={{ display: "flex", alignItems: "center", gap }}>{children}</div>;
}
