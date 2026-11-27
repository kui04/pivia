import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactElement } from "react";
import { expect, fireEvent, within } from "storybook/test";

import { SplitPane } from "./SplitPane";
import { getDragData, hasDragType, setCustomDragPreview, setDragData, type DropDockZone } from "./dnd";
import styles from "./SplitPane.stories.module.css";
import {
    DEFAULT_SPLIT_RATIO,
    parsePaneId,
    parseSplitId,
    resizeTreeSplit,
    splitTreeNode,
    type PaneId,
    type SplitId,
    type SplitTreeNode,
} from "./tree";

const STORY_MIME = "application/x-story-item";

function mustPaneId(raw: string): PaneId {
    const id = parsePaneId(raw);
    if (id === null) {
        throw new Error(`Invalid story pane id: ${raw}`);
    }
    return id;
}

function mustSplitId(raw: string): SplitId {
    const id = parseSplitId(raw);
    if (id === null) {
        throw new Error(`Invalid story split id: ${raw}`);
    }
    return id;
}

function SplitHarness({
    initialTree,
    minPaneWidthPx = 200,
    minPaneHeightPx = 150,
}: {
    readonly initialTree: SplitTreeNode<string>;
    readonly minPaneWidthPx?: number | undefined;
    readonly minPaneHeightPx?: number | undefined;
}): ReactElement {
    const [tree, setTree] = useState(initialTree);
    const [focusedId, setFocusedId] = useState<PaneId>(mustPaneId("pane-1"));

    return (
        <div className={styles.frame}>
            <div className={styles.bar}>
                <button
                    type="button"
                    draggable
                    className={styles.chip}
                    onDragStart={(event) => {
                        setDragData(event.dataTransfer, STORY_MIME, "Gamma");
                        setCustomDragPreview(event.dataTransfer, "Gamma");
                    }}
                >
                    Drag Gamma
                </button>
            </div>
            <SplitPane
                node={tree}
                minPaneWidthPx={minPaneWidthPx}
                minPaneHeightPx={minPaneHeightPx}
                focusedPaneId={focusedId}
                onResizeSplit={(splitId, ratio) => {
                    setTree((prev) => resizeTreeSplit(prev, splitId, ratio));
                }}
                dropConfig={{
                    canDrop: (dt) => hasDragType(dt, STORY_MIME),
                    onDrop: (dt, targetLeaf, zone: DropDockZone) => {
                        const label = getDragData(dt, STORY_MIME);
                        if (label === null) {
                            return;
                        }
                        if (zone === "center") {
                            setTree((prev) =>
                                prev.kind === "leaf" && prev.id === targetLeaf.id ? { ...prev, data: label } : prev,
                            );
                            return;
                        }
                        const axis = zone === "left" || zone === "right" ? "row" : "column";
                        const placement = zone === "left" || zone === "top" ? "first" : "second";
                        setTree((prev) =>
                            splitTreeNode(
                                prev,
                                targetLeaf.id,
                                axis,
                                { kind: "leaf", id: mustPaneId(`pane-dropped-${Date.now()}`), data: label },
                                placement,
                            ),
                        );
                    },
                }}
                renderLeaf={(leaf, { isFocused }) => (
                    <section className={styles.card} aria-label={leaf.data}>
                        <span className={styles.cardTitle}>{leaf.data}</span>
                        <button
                            type="button"
                            onClick={() => {
                                setFocusedId(leaf.id);
                            }}
                        >
                            {isFocused ? "Focused" : `Focus ${leaf.data}`}
                        </button>
                    </section>
                )}
            />
        </div>
    );
}

const initialSideBySide: SplitTreeNode<string> = {
    kind: "split",
    id: mustSplitId("split-root"),
    axis: "row",
    ratio: DEFAULT_SPLIT_RATIO,
    first: { kind: "leaf", id: mustPaneId("pane-1"), data: "Alpha" },
    second: { kind: "leaf", id: mustPaneId("pane-2"), data: "Beta" },
};

const meta = {
    title: "Components/SplitPane",
    component: SplitPane,
    parameters: {
        layout: "fullscreen",
    },
} satisfies Meta<typeof SplitPane>;

export default meta;

type Story = StoryObj<typeof SplitPane>;

export const SideBySideResizeAndDrop: Story = {
    render: () => <SplitHarness initialTree={initialSideBySide} minPaneWidthPx={120} minPaneHeightPx={120} />,
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);
        const slider = await canvas.findByRole("slider", { name: "Resize horizontal split" });
        await expect(slider).toHaveAttribute("aria-valuenow", "50");

        // Divider clicking focuses the slider for immediate keyboard adjustment, and Home/End
        // clamp to real container-derived pixel bounds (e.g. >15% when constrained).
        await fireEvent.pointerDown(slider, { button: 0, pointerId: 1, clientX: 300, clientY: 100 });
        await fireEvent.pointerUp(slider, { button: 0, pointerId: 1, clientX: 300, clientY: 100 });
        await expect(slider).toHaveFocus();
        await userEvent.keyboard("{Home}");
        const minNow = Number(slider.getAttribute("aria-valuenow"));
        const minAttr = Number(slider.getAttribute("aria-valuemin"));
        await expect(minNow).toBe(minAttr);
        await userEvent.keyboard("{Enter}");
        await expect(slider).toHaveAttribute("aria-valuenow", "50");

        await userEvent.keyboard("{ArrowRight}");
        await expect(slider).toHaveAttribute("aria-valuenow", "55");

        const alphaRegion = canvas.getByRole("region", { name: "Alpha" });
        const alphaRect = alphaRegion.getBoundingClientRect();
        const betaRegion = canvas.getByRole("region", { name: "Beta" });
        const betaRect = betaRegion.getBoundingClientRect();
        const dataTransfer = new DataTransfer();
        dataTransfer.setData(STORY_MIME, "Gamma");

        // Hover Alpha first, then cross the boundary into Beta without firing dragleave on Alpha:
        // only Beta's preview overlay must stay visible.
        await fireEvent(
            alphaRegion,
            new DragEvent("dragenter", {
                bubbles: true,
                cancelable: true,
                dataTransfer,
                clientX: alphaRect.left + 10,
                clientY: alphaRect.top + alphaRect.height / 2,
            }),
        );
        await expect(await canvas.findByText("Dock left")).toBeVisible();

        const betaDropCoords = {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: betaRect.left + betaRect.width - 10,
            clientY: betaRect.top + betaRect.height / 2,
        };
        await fireEvent(betaRegion, new DragEvent("dragenter", betaDropCoords));
        await fireEvent(betaRegion, new DragEvent("dragover", betaDropCoords));
        await expect(await canvas.findByText("Dock right")).toBeVisible();
        await expect(canvas.queryByText("Dock left")).not.toBeInTheDocument();

        await fireEvent(betaRegion, new DragEvent("drop", betaDropCoords));
        await expect(await canvas.findByRole("region", { name: "Gamma" })).toBeVisible();
    },
};
