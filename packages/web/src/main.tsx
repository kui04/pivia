import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";

import "@/styles/token.css";
import "@/styles/reset.css";
import "@/styles/global.css";

import { ToastProvider } from "@components/Toast";
import { Log, scheduleDefaultFonts } from "@/lib";
import { toastManager } from "@/lib/toast";
import { router } from "./router";

/** A keyboard inset below this size is usually browser chrome, not a virtual keyboard. */
const KEYBOARD_THRESHOLD = 80;

/**
 * Mirrors the visual viewport into root CSS variables. The write runs on an
 * animation frame, so a burst of resize and scroll events causes one style write
 * and React never re-renders for viewport changes.
 */
function installViewportMetrics(): void {
    const root = document.documentElement;
    let frame = 0;
    let keyboardOpen = false;

    const computeKeyboardInset = (offsetTop: number, height: number, scale: number): number => {
        if (scale !== 1) {
            return 0;
        }

        const inset = window.innerHeight - (offsetTop + height);
        if (!Number.isFinite(inset) || inset < KEYBOARD_THRESHOLD) {
            return 0;
        }

        return Math.round(inset);
    };

    const write = (): void => {
        frame = 0;
        const innerHeight = window.innerHeight;
        const viewport = window.visualViewport;

        if (viewport === null) {
            root.style.setProperty("--vv-height", `${innerHeight}px`);
            root.style.setProperty("--vv-offset-top", "0px");
            root.style.setProperty("--kb-inset", "0px");
            root.removeAttribute("data-keyboard-open");
            return;
        }

        const top = Math.round(viewport.offsetTop);
        const height = Math.round(viewport.height);
        const scale = viewport.scale;
        const inset = computeKeyboardInset(top, height, scale);

        root.style.setProperty("--vv-height", `${height}px`);
        root.style.setProperty("--vv-offset-top", `${top}px`);
        root.style.setProperty("--kb-inset", `${inset}px`);

        const nextKeyboardOpen = inset > 0;
        if (nextKeyboardOpen !== keyboardOpen) {
            keyboardOpen = nextKeyboardOpen;
            Log.debug("Keyboard open state changed", { open: nextKeyboardOpen, inset });
        }

        if (nextKeyboardOpen) {
            root.setAttribute("data-keyboard-open", "true");
        } else {
            root.removeAttribute("data-keyboard-open");
        }
    };

    const schedule = (): void => {
        if (frame !== 0) {
            return;
        }

        frame = window.requestAnimationFrame(write);
    };

    write();

    const viewport = window.visualViewport;
    if (viewport !== null) {
        viewport.addEventListener("resize", schedule);
        viewport.addEventListener("scroll", schedule);
    }
    window.addEventListener("resize", schedule);
    document.addEventListener("visibilitychange", schedule);

    Log.debug("Viewport metrics installed");
}

installViewportMetrics();
scheduleDefaultFonts();

const container = document.getElementById("root");
if (container === null) {
    const message = "The #root element is missing from index.html";
    Log.error(message);
    throw new Error(message);
}

createRoot(container).render(
    <StrictMode>
        <ToastProvider toastManager={toastManager} position="top-center">
            <RouterProvider router={router} />
        </ToastProvider>
    </StrictMode>,
);
