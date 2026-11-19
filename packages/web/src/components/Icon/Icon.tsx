import type { ComponentProps, CSSProperties } from "react";

import { cn } from "../../lib/cn";

import styles from "./Icon.module.css";

/** Presets pair the glyph with the padding that keeps the box on the 4px grid. */
const presets = {
    sm: styles.sm,
    md: styles.md,
    lg: styles.lg,
    xl: styles.xl,
    "no-container": styles.noContainer,
} as const;

export type IconSize = keyof typeof presets;

type FrameProps =
    | {
          /** Fixed box edge in px. The glyph stays centred and the padding is dropped. */
          boxSize: number;
          padding?: never;
      }
    | {
          /** Padding around the glyph in px. The box grows to glyph + 2 x padding. */
          padding?: number;
          boxSize?: never;
      };

export type IconProps = ComponentProps<"span"> &
    FrameProps & {
        /** Preset for glyph and padding. Defaults to "md": a 16px glyph in a 24px box. */
        size?: IconSize;
        /** Glyph edge in px. Overrides the preset. */
        glyphSize?: number;
    };

type IconStyle = CSSProperties & {
    "--icon-glyph-size"?: string;
    "--icon-padding"?: string;
    "--icon-box-size"?: string;
};

/**
 * The box every icon stands in: a 16px glyph centred in a 24px box by default, so
 * icons line up across a row whatever their source. A call site can move the glyph
 * with `glyphSize`, grow the box with `padding`, or fix the box with `boxSize`.
 *
 * The box is decorative: it is aria-hidden unless the caller overrides it, so give
 * the accessible name to the control that owns the icon.
 */
export function Icon({ size = "md", glyphSize, padding, boxSize, className, style, ...props }: IconProps) {
    const sizing: IconStyle = {};

    if (glyphSize !== undefined) {
        sizing["--icon-glyph-size"] = `${glyphSize}px`;
    }

    if (boxSize !== undefined) {
        // A fixed box centres the glyph itself, so padding would only squeeze it.
        sizing["--icon-box-size"] = `${boxSize}px`;
        sizing["--icon-padding"] = "0";
    } else if (padding !== undefined) {
        sizing["--icon-padding"] = `${padding}px`;
    }

    return (
        <span
            aria-hidden="true"
            className={cn(styles.icon, presets[size], className)}
            style={{ ...sizing, ...style }}
            {...props}
        />
    );
}
