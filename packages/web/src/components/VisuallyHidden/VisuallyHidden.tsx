import type { HTMLAttributes, ReactElement } from "react";

import { cn } from "@/lib";

import styles from "./VisuallyHidden.module.css";

const ELEMENT_BY_TAG = {
    span: "span",
    div: "div",
    p: "p",
} as const;

/** Element the hidden text renders as; `span` keeps inline flow. */
export type VisuallyHiddenTag = keyof typeof ELEMENT_BY_TAG;

/** Props of {@link VisuallyHidden}. */
export type VisuallyHiddenProps = HTMLAttributes<HTMLElement> & {
    /** Element to render; defaults to `span`. */
    as?: VisuallyHiddenTag | undefined;
};

/**
 * Renders text that assistive technology reads while sighted readers never see it.
 *
 * Use it for live-region status text and for names that need extra context. Do not hide
 * content that must stay reachable by keyboard focus.
 *
 * @param props - Element type, attributes and the hidden text.
 */
export function VisuallyHidden({ as = "span", className, ...rest }: VisuallyHiddenProps): ReactElement {
    const Element = ELEMENT_BY_TAG[as];
    return <Element {...rest} className={cn(styles.root, className)} />;
}
