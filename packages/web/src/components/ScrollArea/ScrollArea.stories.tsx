import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { ReactNode } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { requireElement, requireViewport } from "@/storybook/dom";
import { DarkTheme } from "@/storybook/theme";

import { ScrollArea } from "./ScrollArea";
import styles from "./ScrollArea.stories.module.css";

const paragraph =
    "Vernacular architecture is building done outside any academic tradition, and without professional guidance. It is not a particular movement or style, but a broad category with many construction methods around the world.";

const cells = Array.from({ length: 100 }, (_, index) => index + 1);
const cards = Array.from({ length: 8 }, (_, index) => `Card ${index + 1}`);

const meta = {
    title: "Components/ScrollArea",
    component: ScrollArea,
    parameters: { layout: "centered" },
    args: { children: null, label: "Scroll area" },
} satisfies Meta<typeof ScrollArea>;

export default meta;

type Story = StoryObj<typeof meta>;

function queryScrollbar(element: HTMLElement, orientation: "vertical" | "horizontal"): HTMLElement | null {
    return element.querySelector<HTMLElement>(`[data-slot="scroll-area-scrollbar"][data-orientation="${orientation}"]`);
}

function queryCorner(element: HTMLElement): HTMLElement | null {
    return element.querySelector<HTMLElement>("[data-slot='scroll-area-corner']");
}

function getOpacity(element: Element): string {
    return getComputedStyle(element).opacity;
}

function Demo({ label, children }: { label: string; children: ReactNode }) {
    return (
        <ScrollArea label={label} className={styles.frame} contentClassName={styles.content}>
            {children}
        </ScrollArea>
    );
}

function CellGrid() {
    return (
        <div className={styles.grid}>
            {cells.map((cell) => (
                <div key={cell} className={styles.cell}>
                    {cell}
                </div>
            ))}
        </div>
    );
}

export const BothAxes: Story = {
    render: () => (
        <Demo label="Both scrollbars">
            <CellGrid />
        </Demo>
    ),
    play: async ({ canvasElement }) => {
        const viewport = requireViewport(canvasElement, "the viewport");

        await userEvent.unhover(viewport);
        await waitFor(() => expect(queryScrollbar(canvasElement, "vertical")).not.toBeNull());
        await waitFor(() => expect(queryScrollbar(canvasElement, "horizontal")).not.toBeNull());

        const vertical = requireElement(queryScrollbar(canvasElement, "vertical"), "the vertical scrollbar");
        const horizontal = requireElement(queryScrollbar(canvasElement, "horizontal"), "the horizontal scrollbar");

        await expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
        await expect(viewport).toHaveAttribute("tabindex", "0");

        // Base UI hides the native scrollbars, so the viewport keeps its full
        // width and height instead of losing a gutter.
        await expect(viewport.clientWidth).toBe(viewport.offsetWidth);
        await expect(viewport.clientHeight).toBe(viewport.offsetHeight);

        // A thin, trackless bar with a pill thumb. The corner keeps the two
        // bars apart and must not block the content underneath.
        await expect(Math.round(Number.parseFloat(getComputedStyle(horizontal).height))).toBe(6);
        await expect(Math.round(Number.parseFloat(getComputedStyle(vertical).width))).toBe(6);

        // The horizontal cue is persistent; the vertical bar starts hidden.
        await expect(getOpacity(horizontal)).toBe("1");
        await waitFor(() => expect(getOpacity(vertical)).toBe("0"));

        const width = viewport.clientWidth;
        await userEvent.hover(viewport);
        await waitFor(() => expect(getOpacity(vertical)).toBe("1"));
        await expect(getOpacity(horizontal)).toBe("1");
        await expect(viewport.clientWidth).toBe(width);

        await userEvent.unhover(viewport);
        await waitFor(() => expect(getOpacity(vertical)).toBe("0"));

        viewport.scrollTop += 100;
        await expect(viewport.scrollTop).toBeGreaterThan(0);

        // Base UI makes the scrollable viewport focusable, which is the
        // precondition for native keyboard scrolling.
        viewport.focus();
        await expect(document.activeElement).toBe(viewport);

        // Leave the story at its starting position for the next viewer.
        viewport.scrollTop = 0;
        viewport.scrollLeft = 0;
    },
};

export const Vertical: Story = {
    render: () => (
        <Demo label="Vertical scroll">
            <div className={styles.stack}>
                {Array.from({ length: 6 }, (_, index) => (
                    <p key={index} className={styles.paragraph}>
                        {paragraph}
                    </p>
                ))}
            </div>
        </Demo>
    ),
    play: async ({ canvasElement }) => {
        const viewport = requireViewport(canvasElement, "the viewport");

        await userEvent.unhover(viewport);
        await waitFor(() => expect(queryScrollbar(canvasElement, "vertical")).not.toBeNull());

        const vertical = requireElement(queryScrollbar(canvasElement, "vertical"), "the vertical scrollbar");

        await expect(queryScrollbar(canvasElement, "horizontal")).toBeNull();
        await expect(queryCorner(canvasElement)).toBeNull();
        await expect(viewport.scrollWidth).toBe(viewport.clientWidth);
        await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
        await expect(viewport).toHaveAttribute("tabindex", "0");
        await waitFor(() => expect(getOpacity(vertical)).toBe("0"));

        await userEvent.hover(viewport);
        await waitFor(() => expect(getOpacity(vertical)).toBe("1"));

        await userEvent.unhover(viewport);
        await waitFor(() => expect(getOpacity(vertical)).toBe("0"));
    },
};

export const Horizontal: Story = {
    render: () => (
        <Demo label="Horizontal scroll">
            <div className={styles.row}>
                {cards.map((card) => (
                    <div key={card} className={styles.card}>
                        {card}
                    </div>
                ))}
            </div>
        </Demo>
    ),
    play: async ({ canvasElement }) => {
        const viewport = requireViewport(canvasElement, "the viewport");

        await userEvent.unhover(viewport);
        await waitFor(() => expect(queryScrollbar(canvasElement, "horizontal")).not.toBeNull());

        const horizontal = requireElement(queryScrollbar(canvasElement, "horizontal"), "the horizontal scrollbar");
        const thumb = requireElement(
            horizontal.querySelector<HTMLElement>("[data-slot='scroll-area-thumb']"),
            "the horizontal thumb",
        );

        await expect(queryScrollbar(canvasElement, "vertical")).toBeNull();
        await expect(queryCorner(canvasElement)).toBeNull();
        await expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        await expect(viewport.scrollHeight).toBe(viewport.clientHeight);
        await expect(viewport).toHaveAttribute("tabindex", "0");
        await expect(getOpacity(horizontal)).toBe("1");

        // The thumb starts at the inline start and reaches the inline end; a
        // centered flex item would be offset by half the leftover track.
        await expect(
            Math.abs(thumb.getBoundingClientRect().left - horizontal.getBoundingClientRect().left),
        ).toBeLessThanOrEqual(1);
        viewport.scrollLeft = viewport.scrollWidth - viewport.clientWidth;
        await waitFor(() => {
            const track = horizontal.getBoundingClientRect();
            const end = thumb.getBoundingClientRect();
            return expect(Math.abs(track.right - end.right)).toBeLessThanOrEqual(1);
        });

        await userEvent.hover(viewport);
        await userEvent.unhover(viewport);
        await expect(getOpacity(horizontal)).toBe("1");

        viewport.scrollLeft = 0;
    },
};

function DynamicScrollArea() {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className={styles.dynamic}>
            <button type="button" className={styles.toggle} onClick={() => setExpanded((value) => !value)}>
                Toggle content
            </button>
            <ScrollArea label="Dynamic content" className={styles.frame} contentClassName={styles.content}>
                {expanded ? <CellGrid /> : <p className={styles.paragraph}>This content fits.</p>}
            </ScrollArea>
        </div>
    );
}

export const Dynamic: Story = {
    render: () => <DynamicScrollArea />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const viewport = requireViewport(canvasElement, "the viewport");
        const toggle = canvas.getByRole("button", { name: "Toggle content" });
        const width = viewport.clientWidth;

        await expect(queryScrollbar(canvasElement, "horizontal")).toBeNull();
        await expect(viewport).toHaveAttribute("tabindex", "-1");

        await userEvent.click(toggle);
        await waitFor(() => expect(queryScrollbar(canvasElement, "horizontal")).not.toBeNull());
        await expect(viewport).toHaveAttribute("tabindex", "0");
        await expect(viewport.clientWidth).toBe(width);
        await expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
        await expect(queryCorner(canvasElement)).not.toBeNull();

        await userEvent.click(toggle);
        await waitFor(() => expect(queryScrollbar(canvasElement, "horizontal")).toBeNull());
        await expect(viewport).toHaveAttribute("tabindex", "-1");
        await expect(viewport.clientWidth).toBe(width);
    },
};

export const Fits: Story = {
    render: () => (
        <Demo label="Content that fits">
            <p className={styles.paragraph}>This content fits, so no scrollbar is rendered.</p>
        </Demo>
    ),
    play: async ({ canvasElement }) => {
        const viewport = requireViewport(canvasElement, "the viewport");

        await expect(viewport.scrollWidth).toBe(viewport.clientWidth);
        await expect(viewport.scrollHeight).toBe(viewport.clientHeight);
        await expect(queryScrollbar(canvasElement, "vertical")).toBeNull();
        await expect(queryScrollbar(canvasElement, "horizontal")).toBeNull();
        await expect(queryCorner(canvasElement)).toBeNull();
        await expect(viewport).toHaveAttribute("tabindex", "-1");
        await expect(viewport).toHaveAttribute("role", "group");
        await expect(viewport).toHaveAttribute("aria-label", "Content that fits");
    },
};

/**
 * A page-level scroller opts into a landmark; inner scrollers stay named groups so repeated
 * commands or notes never duplicate a landmark name.
 */
export const Landmark: Story = {
    render: () => (
        <ScrollArea landmark label="Landmark region" className={styles.frame} contentClassName={styles.content}>
            <p className={styles.paragraph}>A scroller a reader navigates by.</p>
        </ScrollArea>
    ),
    play: async ({ canvasElement }) => {
        const viewport = requireViewport(canvasElement, "the viewport");

        await expect(viewport).toHaveAttribute("role", "region");
        await expect(viewport).toHaveAttribute("aria-label", "Landmark region");
    },
};

export const Dark: Story = {
    decorators: [DarkTheme],
    render: () => (
        <Demo label="Dark theme">
            <CellGrid />
        </Demo>
    ),
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));
        await waitFor(() => expect(queryScrollbar(canvasElement, "horizontal")).not.toBeNull());

        const viewport = requireViewport(canvasElement, "the viewport");

        await userEvent.unhover(viewport);
    },
};
