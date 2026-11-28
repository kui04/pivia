import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

/**
 * Structural view of one mdast node.
 *
 * Block planning reads only the node type and its source offsets, so it does not depend on the
 * full mdast typings of every node kind.
 */
type ScannedNode = {
    readonly type: string;
    readonly position?: { readonly start?: { readonly offset?: number | undefined } | undefined } | undefined;
    readonly children?: readonly ScannedNode[] | undefined;
};

/** One parsed region: its top-level nodes, and whether they couple blocks through references. */
type ScannedRegion = {
    readonly nodes: readonly ScannedNode[];
    readonly couplesBlocks: boolean;
};

/** State carried between tokens while the source only grows. */
type PlannerState = {
    /** Source seen on the previous call, used to recognise that the next call only appends. */
    readonly source: string;
    /** Plan returned for that source. */
    readonly plan: MarkdownBlockPlan;
    /** Offset where the still-growing last top-level node starts. */
    readonly tailStart: number;
};

/**
 * Markdown source divided into blocks that each render the same alone as they do in the whole
 * message.
 *
 * A block ends where a top-level mdast node starts, so a list, a blockquote, an indented code block
 * or a table is never cut in half. Only the last, still-growing node is parsed again on the next
 * token.
 */
export type MarkdownBlockPlan = {
    /** Completed blocks in order; joining them with `tail` reproduces the source exactly. */
    readonly blocks: readonly string[];
    /**
     * The final top-level node, still changing; parsed as its own document on every token. When
     * `requiresWholeDocument` is true this is the whole source instead.
     */
    readonly tail: string;
    /**
     * True when a link reference definition, a footnote or a reference use couples blocks, so their
     * text must render as one document; block-wise rendering would leave the reference unresolved.
     */
    readonly requiresWholeDocument: boolean;
};

/** Per-view planner that keeps finished blocks between streamed tokens. */
export type MarkdownBlockPlanner = {
    /**
     * Plans the blocks of `source`.
     *
     * When `source` extends the text seen on the previous call, the previous blocks are reused and
     * only the last node is parsed again. Any other source starts from scratch, so a planner may
     * survive a component that switches message. A repeated source returns the cached plan, which
     * keeps a double render free. Never throws: model output is untrusted and may end mid-construct.
     */
    plan(source: string): MarkdownBlockPlan;
};

/**
 * Node types that make blocks depend on each other.
 *
 * A reference definition or a footnote definition can appear after its use, and a use can appear
 * before its definition, so neither side can render on its own. The parser today resolves a
 * reference only when its definition is in the same text, which already yields a `definition`
 * node; the reference kinds stay listed so a parser change cannot silently drop the fallback.
 */
const COUPLING_TYPES: ReadonlySet<string> = new Set([
    "definition",
    "footnoteDefinition",
    "footnoteReference",
    "linkReference",
    "imageReference",
]);

/** True when any node of the region couples blocks through a reference or a footnote. */
function couplesBlocks(nodes: readonly ScannedNode[]): boolean {
    for (const node of nodes) {
        if (COUPLING_TYPES.has(node.type)) {
            return true;
        }
        if (node.children !== undefined && couplesBlocks(node.children)) {
            return true;
        }
    }
    return false;
}

/**
 * Parses a region that begins at a top-level block boundary.
 *
 * The extensions mirror the renderer's block-level ones; a construct added to `Markdown.tsx` that
 * can span lines must be added here too, or a block could be cut inside it.
 *
 * A parser failure drops the region into the tail instead of failing the render, because a partly
 * written message is normal input here.
 */
function scanRegion(region: string): ScannedRegion {
    try {
        const tree = fromMarkdown(region, {
            extensions: [gfm(), math()],
            mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
        });
        const nodes = tree.children;
        return { nodes, couplesBlocks: couplesBlocks(nodes) };
    } catch {
        return { nodes: [], couplesBlocks: false };
    }
}

/**
 * Start offsets of the region's top-level nodes, or null when they cannot be trusted.
 *
 * The scan rejects a missing offset and a non-increasing offset, so every slice has a positive
 * length and the blocks partition the source.
 */
function cutOffsets(nodes: readonly ScannedNode[]): readonly number[] | null {
    if (nodes.length < 2) {
        return null;
    }
    const offsets: number[] = [];
    let previous = -1;
    for (const node of nodes) {
        const offset = node.position?.start?.offset;
        if (offset === undefined || offset <= previous) {
            return null;
        }
        offsets.push(offset);
        previous = offset;
    }
    return offsets;
}

/**
 * Slices every top-level node of the region except the last one.
 *
 * The first slice starts at `regionStart`, so leading whitespace of the whole source survives; a
 * later region already begins at a node start.
 */
function slicedBlocks(source: string, regionStart: number, offsets: readonly number[]): string[] {
    const blocks: string[] = [];
    let start = regionStart;
    for (let index = 0; index < offsets.length - 1; index += 1) {
        const end = regionStart + (offsets[index + 1] ?? 0);
        blocks.push(source.slice(start, end));
        start = end;
    }
    return blocks;
}

/**
 * Creates a planner that cuts a streaming message at top-level node boundaries.
 *
 * @returns A planner whose results stay valid while the source only grows.
 */
export function createMarkdownBlockPlanner(): MarkdownBlockPlanner {
    let state: PlannerState | null = null;

    const remember = (plan: MarkdownBlockPlan, source: string, tailStart: number): MarkdownBlockPlan => {
        state = { source, plan, tailStart };
        return plan;
    };

    const planFrom = (
        source: string,
        regionStart: number,
        previousBlocks: readonly string[],
        previousRequiresWholeDocument: boolean,
    ): MarkdownBlockPlan => {
        // A whole-document fallback never becomes block-local again while the source only grows, so
        // skip the parse that could only confirm it.
        if (previousRequiresWholeDocument) {
            return remember({ blocks: [], tail: source, requiresWholeDocument: true }, source, 0);
        }

        const region = source.slice(regionStart);
        const scanned = scanRegion(region);

        if (scanned.couplesBlocks) {
            return remember({ blocks: [], tail: source, requiresWholeDocument: true }, source, 0);
        }

        const offsets = cutOffsets(scanned.nodes);
        if (offsets === null) {
            return remember(
                { blocks: previousBlocks, tail: region, requiresWholeDocument: false },
                source,
                regionStart,
            );
        }

        const tailStart = regionStart + (offsets[offsets.length - 1] ?? 0);
        return remember(
            {
                blocks: [...previousBlocks, ...slicedBlocks(source, regionStart, offsets)],
                tail: source.slice(tailStart),
                requiresWholeDocument: false,
            },
            source,
            tailStart,
        );
    };

    return {
        plan(source: string): MarkdownBlockPlan {
            const previous = state;
            if (previous !== null) {
                if (source === previous.source) {
                    return previous.plan;
                }
                if (source.startsWith(previous.source)) {
                    return planFrom(
                        source,
                        previous.tailStart,
                        previous.plan.blocks,
                        previous.plan.requiresWholeDocument,
                    );
                }
            }
            return planFrom(source, 0, [], false);
        },
    };
}
