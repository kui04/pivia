import type { ComponentProps } from "react";

import { cn } from "../../lib/cn";

import styles from "./Image.module.css";

type NativeImageProps = Omit<ComponentProps<"img">, "alt" | "className" | "src">;

export type ImageProps = NativeImageProps & {
    src: string;
    alt: string;
    /** Styles the trigger when `onOpen` is set; otherwise styles the image. */
    className?: string | undefined;
    /** Styles the image itself, so a caller can keep its own image CSS. */
    imgClassName?: string | undefined;
    /** Opens the caller-owned viewer. Without it, the image is not interactive. */
    onOpen?: (() => void) | undefined;
    /** Accessible name for the trigger. Defaults to a name built from `alt`. */
    openLabel?: string | undefined;
};

/**
 * A display image. Supplying `onOpen` turns it into a dialog trigger; the caller
 * owns the ImageViewer and its open state. `className` styles the trigger,
 * while `imgClassName` styles the image, so a caller can keep its own image
 * rules.
 */
export function Image({
    src,
    alt,
    className,
    imgClassName,
    onOpen,
    openLabel,
    loading = "lazy",
    decoding = "async",
    ...props
}: ImageProps) {
    const image = (
        <img
            src={src}
            alt={alt}
            loading={loading}
            decoding={decoding}
            className={cn(styles.image, onOpen === undefined ? className : undefined, imgClassName)}
            data-slot="image"
            {...props}
        />
    );

    if (onOpen === undefined) {
        return image;
    }

    const label =
        openLabel === undefined || openLabel === "" ? (alt === "" ? "View image" : `View image: ${alt}`) : openLabel;

    return (
        <button
            type="button"
            className={cn(styles.trigger, className)}
            aria-label={label}
            aria-haspopup="dialog"
            data-slot="image-trigger"
            onClick={onOpen}
        >
            {image}
        </button>
    );
}
