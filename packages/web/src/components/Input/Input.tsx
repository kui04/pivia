import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";

import { cn } from "@/lib";

import styles from "./Input.module.css";

type BaseInputProps = Omit<ComponentProps<typeof BaseInput>, "className">;

export type InputProps = BaseInputProps & {
    /** Styles the input element. */
    className?: string | undefined;
};

/**
 * A text input built on Base UI Input. Wrap it in Field for a visible label,
 * description and validation message; Field also supplies `aria-invalid` and
 * the described-by relationship.
 */
export function Input({ className, ...props }: InputProps) {
    return <BaseInput {...props} data-slot="input" className={cn(styles.input, className)} />;
}
