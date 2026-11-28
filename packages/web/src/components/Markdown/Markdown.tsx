import "katex/dist/katex.min.css";

import {
    Children,
    createContext,
    isValidElement,
    memo,
    useCallback,
    useDeferredValue,
    useContext,
    useMemo,
    useState,
} from "react";
import type { ComponentProps, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components, ExtraProps, Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { useFontRole } from "@/hooks";
import { cn, prefersReducedMotion } from "@/lib";

import { CodeBlock } from "../CodeBlock";
import { Image } from "../Image";
import { ImageViewer } from "../ImageViewer";
import { ScrollArea } from "../ScrollArea";
import { createMarkdownBlockPlanner } from "./markdown-blocks";
import { remarkCurrency } from "./remark-currency";
import styles from "./Markdown.module.css";

export type MarkdownProps = {
    /** Markdown source, exactly as it arrived from the model. */
    children: string;
    /** True while the source is still arriving. */
    streaming?: boolean;
    /**
     * Called when a link is followed. The renderer never lets the page
     * navigate itself, so a link without this handler is inert.
     */
    onOpenLink?: ((href: string) => void) | undefined;
    className?: string | undefined;
};

type MarkdownImageRequest = {
    src: string;
    alt: string;
    title: string | undefined;
};

type MarkdownContextValue = {
    streaming: boolean;
    onOpenLink: ((href: string) => void) | undefined;
    openImage: (image: MarkdownImageRequest) => void;
};

const MarkdownContext = createContext<MarkdownContextValue>({
    streaming: false,
    onOpenLink: undefined,
    openImage: () => {},
});

/** The text of the task item, so its checkbox can carry the item's name. */
const TaskTextContext = createContext<string | undefined>(undefined);

/** An image inside a link cannot also be a button; the link keeps the image. */
const ImageLinkContext = createContext(false);

const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkMath, remarkCurrency, remarkBreaks];

const REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [
    [
        rehypeKatex,
        {
            // KaTeX colors a formula it cannot parse instead of failing the message.
            errorColor: "var(--md-error)",
            // Agent output often contains unicode text in formulas; KaTeX warns,
            // but the formula is still worth drawing.
            strict: "ignore",
        },
    ],
];

/**
 * One set of renderers for every instance: React compares component types, so a
 * map rebuilt per render would unmount every block and lose the state of the
 * code blocks while the answer streams in. The renderers read the per-message
 * values from the context instead.
 */
const COMPONENTS: Components = {
    a: MarkdownLink,
    pre: CodeFence,
    code: InlineCode,
    li: ListItem,
    input: TaskCheckbox,
    span: MarkdownSpan,
    table: MarkdownTable,
    img: MarkdownImage,
};

/**
 * One markdown document parsed as a whole.
 *
 * The source is the memo key, so a block that is already finished keeps its parsed tree when the
 * next token arrives: a growing answer re-parses only its tail.
 */
const MarkdownDocument = memo(function MarkdownDocument({ source }: { readonly source: string }): ReactElement {
    return (
        <ReactMarkdown
            components={COMPONENTS}
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            // Raw HTML stays out of the message; a model writes markup in a fence.
            skipHtml
        >
            {source}
        </ReactMarkdown>
    );
});

/**
 * Growing source rendered as parse-exact blocks plus a live tail.
 *
 * Block boundaries come from the same micromark/mdast extensions as the renderer, so a list, a
 * blockquote, a table or an indented code block keeps its place.
 *
 * FIXME: reference links and footnotes couple blocks, so a message that uses them renders as one
 * document. That fallback replaces the block tree and remounts the message, which resets focus and
 * code-block state inside it. Resolve reference definitions across blocks before this cost matters.
 */
const MessageMarkdown = memo(function MessageMarkdown({ source }: { readonly source: string }): ReactElement {
    const [planner] = useState(createMarkdownBlockPlanner);
    // `plan` is observationally pure: an unchanged source returns the cached plan, an extension
    // reuses verified blocks, and any other source starts over, so a double render or a discarded
    // concurrent render cannot produce a wrong plan.
    const plan = planner.plan(source);

    if (plan.requiresWholeDocument) {
        return <MarkdownDocument source={source} />;
    }

    return (
        <>
            {plan.blocks.map((block, index) => (
                // The source only grows, so a block keeps the position it was given once it is complete.
                <MarkdownDocument key={index} source={block} />
            ))}
            {plan.tail === "" ? null : <MarkdownDocument source={plan.tail} />}
        </>
    );
});

function MarkdownInner({ children, streaming = false, onOpenLink, className }: MarkdownProps) {
    // While tokens arrive faster than frames, let React drop intermediate sources:
    // the reader waits for one frame, not for every parse on the way to it.
    const deferred = useDeferredValue(children);
    const source = streaming ? deferred : children;
    const [viewer, setViewer] = useState<(MarkdownImageRequest & { open: boolean }) | null>(null);
    // A message that streamed once keeps its block tree after the stream ends, so the finished
    // answer is not remounted into a single document.
    const [streamed, setStreamed] = useState(streaming);
    if (streaming && !streamed) {
        setStreamed(true);
    }
    const openImage = useCallback((image: MarkdownImageRequest) => {
        setViewer({ ...image, open: true });
    }, []);
    const context = useMemo(() => ({ streaming, onOpenLink, openImage }), [onOpenLink, streaming, openImage]);

    return (
        <MarkdownContext.Provider value={context}>
            <div className={cn(styles.root, className)} data-slot="markdown" data-streaming={streaming || undefined}>
                {streaming || streamed ? <MessageMarkdown source={source} /> : <MarkdownDocument source={source} />}
            </div>
            <ImageViewer
                open={viewer?.open ?? false}
                onOpenChange={(open) => {
                    setViewer((current) => (current === null ? null : { ...current, open }));
                }}
                src={viewer?.src ?? ""}
                alt={viewer?.alt ?? ""}
                caption={viewer?.title}
            />
        </MarkdownContext.Provider>
    );
}

export const Markdown = memo(MarkdownInner);

type Fence = {
    code: string;
    language: string | undefined;
};

/**
 * A fence arrives as `pre > code`. The code element's text ends with the newline
 * before the closing fence; dropping that one newline keeps the block from
 * showing a trailing empty row, while a blank line the author wrote survives.
 */
function codeOf(children: ReactNode): Fence {
    const element = Children.toArray(children).find((child) =>
        isValidElement<{ className?: string; children?: ReactNode }>(child),
    );
    const language = /(?:^|\s)language-(\S+)/.exec(element?.props.className ?? "")?.[1];
    const text = toText(element === undefined ? children : element.props.children);

    return {
        code: text.replace(/\r\n/g, "\n").replace(/\n$/, ""),
        language,
    };
}

/**
 * Flattens rendered children to plain text.
 *
 * `skip` drops an element that carries no readable text, such as a task checkbox whose state is
 * announced separately.
 */
function toText(value: ReactNode, skip?: (element: ReactElement) => boolean): string {
    if (typeof value === "string" || typeof value === "number") {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value.map((child: ReactNode) => toText(child, skip)).join("");
    }
    if (isValidElement<{ children?: ReactNode }>(value)) {
        if (skip !== undefined && skip(value)) {
            return "";
        }
        return toText(value.props.children, skip);
    }
    return "";
}

function CodeFence({ children }: ComponentProps<"pre"> & ExtraProps) {
    const { streaming } = useContext(MarkdownContext);
    const fence = codeOf(children);

    return <CodeBlock code={fence.code} language={fence.language} streaming={streaming} className={styles.codeBlock} />;
}

function InlineCode({ children }: ComponentProps<"code"> & ExtraProps) {
    useFontRole("mono");
    return <code className={styles.inlineCode}>{children}</code>;
}

function ListItem({ className, children, node, ...props }: ComponentProps<"li"> & ExtraProps) {
    // remark-gfm names a task item in the class list and gives a footnote its id,
    // so both must reach the DOM. The HAST node must not.
    void node;

    const task = className?.split(/\s+/).includes("task-list-item") ?? false;

    if (!task) {
        return (
            <li className={className} {...props}>
                {children}
            </li>
        );
    }

    const text = toText(children, (element) => element.type === TaskCheckbox)
        .replace(/\s+/g, " ")
        .trim();

    return (
        <li className={className} {...props}>
            <TaskTextContext.Provider value={text === "" ? undefined : text}>{children}</TaskTextContext.Provider>
        </li>
    );
}

function TaskCheckbox({ checked }: ComponentProps<"input"> & ExtraProps) {
    const item = useContext(TaskTextContext);

    // A task checkbox is disabled and has no text of its own; the item text
    // names it, with the state as a fallback for an empty task.
    return (
        <input
            type="checkbox"
            checked={checked === true}
            disabled
            readOnly
            aria-label={item ?? (checked === true ? "Completed task" : "Open task")}
        />
    );
}

function MarkdownLink({ href, title, className, children, node, ...props }: ComponentProps<"a"> & ExtraProps) {
    const { onOpenLink } = useContext(MarkdownContext);
    // react-markdown clears a URL whose scheme is not safe, so an empty href is
    // an unsafe link: the text stays, the clickable target does not.
    const url = href;
    // The HAST node is a renderer detail; the other attributes, such as the id
    // and aria-describedby of a footnote reference, belong in the DOM.
    void node;

    if (url === undefined || url === "") {
        return <>{children}</>;
    }

    // A footnote reference stays inside the message. The hash router owns
    // `location.hash`, so a raw fragment would rewrite the route and a reload
    // would render RouteError; the link scrolls to the target itself instead.
    if (url.startsWith("#")) {
        return (
            <ImageLinkContext.Provider value={true}>
                <a
                    {...props}
                    href={url}
                    title={title}
                    className={cn(styles.link, className)}
                    onClick={(event) => {
                        event.preventDefault();
                        void followFragment(url);
                    }}
                >
                    {children}
                </a>
            </ImageLinkContext.Provider>
        );
    }

    const follow = (event: ReactMouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onOpenLink?.(url);
    };

    return (
        <ImageLinkContext.Provider value={true}>
            <a
                {...props}
                href={url}
                title={title}
                className={cn(styles.link, className)}
                onClick={follow}
                onAuxClick={(event) => {
                    // A middle click is the same link; without this it could open a
                    // second tab instead of reaching the host.
                    if (event.button === 1) {
                        follow(event);
                    }
                }}
            >
                {children}
            </a>
        </ImageLinkContext.Provider>
    );
}

/** Native controls and links already join the tab order. */
const NATIVELY_FOCUSABLE =
    'a[href], button, input, select, textarea, summary, [contenteditable]:not([contenteditable="false"])';

/**
 * Moves to a fragment target inside the message without touching the URL.
 *
 * The browser hands the sequential focus starting point to a fragment target,
 * so cancelling the default action has to repeat that step. A target that is not
 * already focusable becomes programmatically focusable; a native link or control
 * keeps its existing tab stop. Focus waits for the smooth scroll, and
 * `preventScroll` keeps it from starting a second one; a browser without scroll
 * promises focuses as the scroll begins.
 */
async function followFragment(url: string): Promise<void> {
    const target = fragmentTarget(url);
    if (target === null) {
        return;
    }

    const reduceMotion = prefersReducedMotion();
    const scroll = target.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
    });

    // `scrollIntoView` returns a Promise where scroll promises are supported.
    await (scroll as unknown as Promise<void> | undefined);

    if (!target.hasAttribute("tabindex") && !target.matches(NATIVELY_FOCUSABLE)) {
        target.tabIndex = -1;
    }
    target.focus({ preventScroll: true });
}

/** The element a fragment names, or null when the id is absent or malformed. */
function fragmentTarget(url: string): HTMLElement | null {
    try {
        return document.getElementById(decodeURIComponent(url.slice(1)));
    } catch {
        // A stray `%` in a model-written anchor is not an id.
        return null;
    }
}

function MarkdownTable({ children }: ComponentProps<"table"> & ExtraProps) {
    return (
        // The table scrolls sideways inside the shared overlay scroll area; the
        // viewport keeps the region name and, while the table overflows, the
        // keyboard focus.
        <ScrollArea label="Table" className={styles.tableScroll}>
            <table className={styles.table}>{children}</table>
        </ScrollArea>
    );
}

function MarkdownSpan({ className, children, node, ...props }: ComponentProps<"span"> & ExtraProps) {
    // The HAST node is a renderer detail and must not reach the DOM. The rest of
    // the attributes include the inline styles and aria-hidden of KaTeX spans.
    void node;

    const span = (
        <span className={className} {...props}>
            {children}
        </span>
    );

    // rehype-katex emits display math as a top-level katex-display span. It
    // scrolls sideways rather than widening the message.
    return className?.split(/\s+/).includes("katex-display") ? (
        <ScrollArea label="Formula" className={styles.mathScroll}>
            {span}
        </ScrollArea>
    ) : (
        span
    );
}

function MarkdownImage({ src, alt, title }: ComponentProps<"img"> & ExtraProps) {
    const { openImage } = useContext(MarkdownContext);
    const insideLink = useContext(ImageLinkContext);

    // react-markdown empties a URL with an unsafe scheme. An empty src would
    // make the browser request the document itself, so keep the alt text.
    if (src === undefined || src === "") {
        return alt === undefined || alt === "" ? null : <>{alt}</>;
    }

    const altText = alt ?? "";

    return (
        <Image
            src={src}
            alt={altText}
            title={title}
            className={styles.image}
            onOpen={
                insideLink
                    ? undefined
                    : () => {
                          openImage({ src, alt: altText, title });
                      }
            }
        />
    );
}
