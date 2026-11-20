import { Toast as BaseToast } from "@base-ui/react/toast";
import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import { useMemo } from "react";

/**
 * The types that stay until the user dismisses them. A warning and an error
 * usually need a decision or a remedy, so they must not vanish on a timer.
 */
const PERSISTENT_TYPES = new Set(["warning", "error"]);

/**
 * Applies the default timeout rule to one message.
 *
 * An explicit `timeout` always wins, so a caller can still time out a warning
 * or keep a success on screen. Without one, a sticky type gets `0`, which Base
 * UI reads as "no auto-dismiss", and every other type keeps the provider
 * default.
 */
function withDefaultTimeout<Data extends object>(options: ToastManagerAddOptions<Data>): ToastManagerAddOptions<Data> {
    if (options.timeout !== undefined || !PERSISTENT_TYPES.has(options.type ?? "")) {
        return options;
    }

    return { ...options, timeout: 0 };
}

/**
 * Adds and updates toasts inside the nearest `ToastProvider`. The semantic types
 * `info`, `success`, `warning` and `error` add a colored status icon; other
 * strings keep the neutral presentation.
 *
 * A `warning` or an `error` has no default timeout, so it stays until the user
 * dismisses it. Pass an explicit `timeout` to override that. The rule covers
 * `add` only: an `update` that turns a message into a warning or an error keeps
 * the timeout the message was added with.
 */
export function useToast() {
    const manager = BaseToast.useToastManager();

    return useMemo(
        () => ({
            ...manager,
            add: <T extends object = object>(options: ToastManagerAddOptions<T>) =>
                manager.add(withDefaultTimeout(options)),
        }),
        [manager],
    );
}

/**
 * Creates a toast manager for messages sent outside the React tree.
 * The same rule applies here, so a `warning` or an `error` sent through this
 * manager also stays until the user dismisses it.
 */
export function createToastManager() {
    const manager = BaseToast.createToastManager();

    return {
        ...manager,
        add: <T extends object = object>(options: ToastManagerAddOptions<T>) =>
            manager.add(withDefaultTimeout(options)),
    };
}
