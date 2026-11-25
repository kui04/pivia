import { Check, Copy, WrapText, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ThemedToken } from "shiki";

import { copyFeedbackText, useCopyFeedback } from "@/hooks";

import { cn } from "@/lib";

import { IconButton } from "../IconButton/IconButton";
import { ScrollArea } from "../ScrollArea/ScrollArea";
import { parseDiffLines } from "./diff";
import { highlight, resolveLanguage } from "./highlight";
import styles from "./CodeBlock.module.css";

export type CodeBlockProps = {
    /** Text that is rendered and copied. */
    code: string;
    /** Header label such as "ts"; it also chooses the grammar. */
    language?: string | undefined;
    /**
     * True while the source keeps changing. The block stays plain and skips the
     * grammar work until the answer is complete, then highlights once.
     */
    streaming?: boolean;
    /** Wrap lines on first render; the toolbar toggle owns the state afterwards. */
    defaultWrap?: boolean;
    /** Show a line-number gutter in front of every line. */
    lineNumbers?: boolean;
    /** Number of the first line. Only used together with `lineNumbers`. */
    startLine?: number;
    /** Turns a line number into its gutter label. Defaults to the decimal number. */
    formatLineNumber?: (line: number) => string;
    /** Hide the copy button. */
    copyable?: boolean;
    /** Called after the clipboard write succeeds. */
    onCopy?: ((code: string) => void) | undefined;
    /** Optional class name passed to the inner ScrollArea root (for vertical sizing). */
    scrollClassName?: string | undefined;
    /** Optional class name passed to the inner ScrollArea viewport. */
    viewportClassName?: string | undefined;
    className?: string | undefined;
};

export function CodeBlock({
    code,
    language,
    streaming = false,
    defaultWrap = false,
    lineNumbers = false,
    startLine = 1,
    formatLineNumber,
    copyable = true,
    onCopy,
    scrollClassName,
    viewportClassName,
    className,
}: CodeBlockProps) {
    const [wrapped, setWrapped] = useState(defaultWrap);
    const { status: copyStatus, copy } = useCopyFeedback(onCopy);
    const [rendered, setRendered] = useState<{ code: string; language: string; lines: ThemedToken[][] }>();

    const sourceLines = useMemo(() => code.split("\n"), [code]);
    const isDiff = language !== undefined && resolveLanguage(language)?.id === "diff";
    // The diff grammar only paints the signs, so a diff renders its lines
    // directly; every other language gets Shiki tokens.
    const displayLines = useMemo(
        () =>
            isDiff
                ? parseDiffLines(sourceLines)
                : sourceLines.map((line) => ({ marker: "", content: line, variant: "default" as const })),
        [isDiff, sourceLines],
    );
    const lineLabels = useMemo(() => {
        if (!lineNumbers) {
            return [];
        }

        return sourceLines.map((_, index) => {
            const line = startLine + index;
            return formatLineNumber === undefined ? `${line}` : formatLineNumber(line);
        });
    }, [formatLineNumber, lineNumbers, sourceLines, startLine]);
    // The block is monospace, so one character is exactly one ch and a
    // right-aligned gutter of N ch fits any label of N characters.
    const gutterChars = lineLabels.reduce((max, label) => Math.max(max, label.length), 0);
    const hasGutter = lineNumbers || isDiff;

    useEffect(() => {
        if (language === undefined || isDiff || streaming) {
            return;
        }

        let cancelled = false;

        // Highlighting runs off the render path; the block keeps its plain text
        // until the grammar is loaded, and forever when the grammar is missing.
        highlight(code, language).then(
            (lines) => {
                if (!cancelled && lines !== undefined) {
                    setRendered({ code, language, lines });
                }
            },
            () => undefined,
        );

        return () => {
            cancelled = true;
        };
    }, [code, isDiff, language, streaming]);

    const tokens =
        !streaming && rendered !== undefined && rendered.code === code && rendered.language === language
            ? rendered.lines
            : undefined;
    const statusText = copyFeedbackText(copyStatus);

    return (
        <div className={cn(styles.block, className)} data-slot="code-block">
            <div className={styles.header}>
                <span className={styles.language} data-slot="code-block-language">
                    {language}
                </span>
                <div className={styles.toolbar}>
                    <IconButton label="Wrap lines" aria-pressed={wrapped} onClick={() => setWrapped(!wrapped)}>
                        <WrapText />
                    </IconButton>
                    {copyable ? (
                        <IconButton label="Copy code" className={styles.copyButton} onClick={() => copy(code)}>
                            {copyStatus === "copied" ? <Check /> : copyStatus === "failed" ? <X /> : <Copy />}
                        </IconButton>
                    ) : null}
                </div>
            </div>
            <ScrollArea
                label={language === undefined ? "Code" : `${language} code`}
                className={scrollClassName}
                viewportClassName={viewportClassName}
            >
                <pre
                    className={cn(styles.pre, wrapped && styles.wrapped)}
                    data-gutter={hasGutter || undefined}
                    data-numbered={lineNumbers || undefined}
                    data-wrap={wrapped || undefined}
                >
                    <code className={styles.code}>
                        {displayLines.map((line, index) => (
                            <span
                                key={index}
                                className={styles.line}
                                data-slot="code-block-line"
                                data-variant={line.variant}
                            >
                                {hasGutter ? (
                                    <span className={styles.gutter} data-slot="code-block-gutter">
                                        {lineNumbers ? (
                                            <span
                                                className={styles.lineNumber}
                                                data-slot="code-block-line-number"
                                                style={{ minWidth: `${gutterChars}ch` }}
                                                aria-hidden="true"
                                            >
                                                {lineLabels[index]}
                                            </span>
                                        ) : null}
                                        {isDiff ? (
                                            <span className={styles.marker} data-slot="code-block-marker">
                                                {line.marker}
                                            </span>
                                        ) : null}
                                    </span>
                                ) : null}
                                <span className={styles.lineContent} data-slot="code-block-line-content">
                                    {isDiff
                                        ? line.content
                                        : tokens === undefined
                                          ? line.content
                                          : tokens[index]?.map((token) => (
                                                <span
                                                    key={token.offset}
                                                    // Shiki writes the two theme colors as --shiki-light and --shiki-dark.
                                                    style={token.htmlStyle}
                                                >
                                                    {token.content}
                                                </span>
                                            ))}
                                </span>
                            </span>
                        ))}
                    </code>
                </pre>
            </ScrollArea>
            <span className={styles.status} role="status">
                {statusText}
            </span>
        </div>
    );
}
