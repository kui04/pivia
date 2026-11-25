import { Form as BaseForm } from "@base-ui/react/form";
import type { ComponentProps } from "react";

import { cn } from "@/lib";

import styles from "./Form.module.css";

export type FormProps = Omit<ComponentProps<typeof BaseForm>, "className"> & {
    /** Styles the form element. */
    className?: string | undefined;
};

/**
 * A form built on Base UI Form. Base UI validates the registered Fields on
 * submit, focuses the first invalid control and blocks submission until the
 * fields are valid; `errors` and `onFormSubmit` expose server-side errors and
 * the submitted values. The wrapper only supplies the vertical layout.
 */
export function Form({ className, ...props }: FormProps) {
    return <BaseForm {...props} data-slot="form" className={cn(styles.form, className)} />;
}
