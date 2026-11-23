import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

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

function requireElement<T extends Element>(element: T | null, name: string): T {
    if (element === null) {
        throw new Error(`The story did not render ${name}`);
    }

    return element;
}

function getViewport(canvasElement: HTMLElement): HTMLElement {
    return requireElement(
        canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']"),
        "the viewport",
    );
}

function queryScrollbar(element: HTMLElement, orientation: "vertical" | "horizontal"): HTMLElement | null {
    return element.querySelector<HTMLElement>(`[data-slot="scroll-area-scrollbar"][data-orientation="${orientation}"]`);
}

function queryCorner(element: HTMLElement): HTMLElement | null {
    return element.querySelector<HTMLElement>("[data-slot='scroll-area-corner']");
}

function getOpacity(element: Element): string {
    return getComputedStyle(element).opacity;
}

function parseRgb(color: string): [number, number, number] {
    const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);

    if (match === null) {
        throw new Error(`Expected an opaque rgb color, got ${color}`);
    }

    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
    const linear = (value: number) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
    const foregroundLuminance = relativeLuminance(foreground);
    const backgroundLuminance = relativeLuminance(background);

    return (
        (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
        (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
    );
}

async function expectThumbContrast(canvasElement: HTMLElement, thumb: HTMLElement): Promise<void> {
    const root = requireElement(
        canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area']"),
        "the scroll area",
    );
    const foreground = parseRgb(getComputedStyle(thumb).backgroundColor);
    const background = parseRgb(getComputedStyle(root).backgroundColor);
    const alpha = Number(getComputedStyle(thumb).opacity);
    const blended: [number, number, number] = [
        Math.round(alpha * foreground[0] + (1 - alpha) * background[0]),
        Math.round(alpha * foreground[1] + (1 - alpha) * background[1]),
        Math.round(alpha * foreground[2] + (1 - alpha) * background[2]),
    ];

    await expect(contrastRatio(blended, background)).toBeGreaterThanOrEqual(3);
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
        const viewport = getViewport(canvasElement);

        await userEvent.unhover(viewport);
        await waitFor(() => expect(queryScrollbar(canvasElement, "vertical")).not.toBeNull());
        await waitFor(() => expect(queryScrollbar(canvasElement, "horizontal")).not.toBeNull());

        const vertical = requireElement(queryScrollbar(canvasElement, "vertical"), "the vertical scrollbar");
        const horizontal = requireElement(queryScrollbar(canvasElement, "horizontal"), "the horizontal scrollbar");
        const horizontalThumb = requireElement(
            horizontal.querySelector<HTMLElement>("[data-slot='scroll-area-thumb']"),
            "the horizontal thumb",
        );
        const corner = requireElement(queryCorner(canvasElement), "the corner");

        await expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
        await expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
        await expect(viewport).toHaveAttribute("tabindex", "0");
        await expectThumbContrast(canvasElement, horizontalThumb);

        // Base UI hides the native scrollbars, so the viewport keeps its full
        // width and height instead of losing a gutter.
        await expect(viewport.clientWidth).toBe(viewport.offsetWidth);
        await expect(viewport.clientHeight).toBe(viewport.offsetHeight);

        // A thin, trackless bar with a pill thumb. The corner keeps the two
        // bars apart and must not block the content underneath.
        await expect(Math.round(Number.parseFloat(getComputedStyle(horizontal).height))).toBe(6);
        await expect(Math.round(Number.parseFloat(getComputedStyle(vertical).width))).toBe(6);
        await expect(getComputedStyle(horizontal).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        await expect(Math.round(Number.parseFloat(getComputedStyle(horizontalThumb).borderRadius))).toBe(999);
        await expect(Math.round(corner.getBoundingClientRect().width)).toBe(6);
        await expect(getComputedStyle(corner).pointerEvents).toBe("none");

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

        // A wheel gesture clears Base UI's programmatic-scroll guard, so the
        // scroll position change below starts its idle timer. A bare scrollTop
        // change would be treated as programmatic and ignored.
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true }));
        viewport.scrollTop += 100;
        await expect(viewport.scrollTop).toBeGreaterThan(0);
        await waitFor(() => expect(vertical).toHaveAttribute("data-scrolling"));
        await expect(getOpacity(vertical)).toBe("1");
        await waitFor(() => expect(vertical).not.toHaveAttribute("data-scrolling"), { timeout: 2000 });
        await waitFor(() => expect(getOpacity(vertical)).toBe("0"));
        await expect(getOpacity(horizontal)).toBe("1");
        await expect(viewport.clientWidth).toBe(width);

        // Base UI makes the scrollable viewport focusable, which is the
        // precondition for native keyboard scrolling. The actual PageDown
        // default is not asserted because user-event's synthetic key does not
        // reliably scroll a nested scroll container in this runner.
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
        const viewport = getViewport(canvasElement);

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
        const viewport = getViewport(canvasElement);

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
        const viewport = getViewport(canvasElement);
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
        const viewport = getViewport(canvasElement);

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
        const viewport = getViewport(canvasElement);

        await expect(viewport).toHaveAttribute("role", "region");
        await expect(viewport).toHaveAttribute("aria-label", "Landmark region");
    },
};

export const ViewportOverride: Story = {
    render: () => (
        <ScrollArea
            label="Viewport override"
            style={{ width: "20rem", height: "10rem" }}
            viewportClassName={styles.overrideViewport}
        >
            <p className={styles.paragraph}>A caller class can override the viewport width.</p>
        </ScrollArea>
    ),
    play: async ({ canvasElement }) => {
        const viewport = getViewport(canvasElement);
        const root = viewport.parentElement;

        if (root === null) {
            throw new Error("The scroll area root is missing");
        }

        await expect(Math.round(viewport.getBoundingClientRect().width)).toBe(
            Math.round(root.getBoundingClientRect().width * 0.8),
        );
    },
};

function DarkTheme({ children }: { children: ReactNode }) {
    useEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = "dark";

        return () => {
            delete root.dataset.theme;
        };
    }, []);

    return <>{children}</>;
}

export const Dark: Story = {
    decorators: [
        (Story) => (
            <DarkTheme>
                <Story />
            </DarkTheme>
        ),
    ],
    render: () => (
        <Demo label="Dark theme">
            <CellGrid />
        </Demo>
    ),
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));
        await waitFor(() => expect(queryScrollbar(canvasElement, "horizontal")).not.toBeNull());

        const viewport = getViewport(canvasElement);
        const horizontal = requireElement(queryScrollbar(canvasElement, "horizontal"), "the horizontal scrollbar");
        const thumb = requireElement(
            horizontal.querySelector<HTMLElement>("[data-slot='scroll-area-thumb']"),
            "the horizontal thumb",
        );

        await userEvent.unhover(viewport);
        await expectThumbContrast(canvasElement, thumb);
    },
};
