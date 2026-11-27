import type { ComponentPropsWithoutRef, ReactElement } from "react";

import { cn } from "@/lib";

import styles from "./Tabular.module.css";

/** Element tag supported by {@link Tabular}. */
export type TabularTag = "span" | "time" | "data";

/** Props of {@link Tabular}. */
export type TabularProps =
    | ({ as?: "span" | undefined } & ComponentPropsWithoutRef<"span">)
    | ({ as: "time" } & ComponentPropsWithoutRef<"time">)
    | ({ as: "data" } & ComponentPropsWithoutRef<"data">);

/**
 * Renders numbers, live timers, counts, and timestamps with fixed-width tabular figures
 * in the active proportional sans font so changing digits never shift layout.
 */
export function Tabular(props: TabularProps): ReactElement {
    switch (props.as) {
        case "time": {
            const { as: tag, className, ...rest } = props;
            void tag;
            return <time {...rest} className={cn(styles.root, className)} />;
        }
        case "data": {
            const { as: tag, className, ...rest } = props;
            void tag;
            return <data {...rest} className={cn(styles.root, className)} />;
        }
        default: {
            const { as: tag, className, ...rest } = props;
            void tag;
            return <span {...rest} className={cn(styles.root, className)} />;
        }
    }
}
