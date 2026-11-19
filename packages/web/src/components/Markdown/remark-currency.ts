type MdNode = {
    type: string;
    value?: string | undefined;
    children?: MdNode[] | undefined;
    position?:
        | {
              start?: { offset?: number | undefined } | undefined;
              end?: { offset?: number | undefined } | undefined;
          }
        | undefined;
};

type VFileLike = { value?: unknown };

/**
 * remark-math reads `$5 and $10` as inline math: the second dollar closes the
 * span, so the prices lose their signs and the words between them become a
 * formula. A conversation talks about money far more often than it writes a
 * single-dollar formula, so this transformer turns such a span back into the
 * text it came from when it looks like an amount rather than notation.
 *
 * Display math on its own lines is a different node type. A single-line
 * `$$...$$` parses as inline math, so the same currency rules apply to it.
 */
export function remarkCurrency() {
    return (tree: unknown, file: VFileLike): void => {
        if (!isMdNode(tree)) {
            return;
        }

        const source = typeof file.value === "string" ? file.value : "";

        if (!source.includes("$")) {
            return;
        }

        restoreText(tree, source);
    };
}

function isMdNode(value: unknown): value is MdNode {
    return (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        typeof (value as { type?: unknown }).type === "string"
    );
}

function restoreText(parent: MdNode, source: string): void {
    const children = parent.children;

    if (children === undefined) {
        return;
    }

    for (let index = 0; index < children.length; index += 1) {
        const child = children[index];

        if (child === undefined) {
            continue;
        }

        if (child.type === "inlineMath" && child.value !== undefined && isCurrency(child, source)) {
            children[index] = { type: "text", value: sourceOf(child, source) };
            continue;
        }

        restoreText(child, source);
    }
}

function isCurrency(node: MdNode, source: string): boolean {
    const value = node.value ?? "";

    // Pandoc and Obsidian: math cannot start or end with a space. This catches
    // "5 a month, or " and "$.50 and " without knowing what the prose says.
    if (/^\s|\s$/.test(value)) {
        return true;
    }

    // ".50" is an amount too. Checking this before the delimiter rule keeps
    // `$x$5` a formula (x followed by 5) rather than a pair of prices.
    if (!/^(?:\d|\.\d)/.test(value)) {
        return false;
    }

    const end = node.position?.end?.offset;

    // A closing dollar followed by a digit or by ".5" is the boundary between
    // two prices: "$5 and $10", "$.50-$.75".
    if (end !== undefined) {
        const next = source.charAt(end);
        if (/\d/.test(next) || (next === "." && /\d/.test(source.charAt(end + 1)))) {
            return true;
        }
    }

    // "5 km" or "5 apples" with no space at the delimiter: it starts like an
    // amount and has none of the notation that would make it a formula.
    return /\s/.test(value) && /[A-Za-z]{2,}/.test(value) && !/[\\^_=+*/<>]/.test(value);
}

function sourceOf(node: MdNode, source: string): string {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;

    if (start !== undefined && end !== undefined && start < end && end <= source.length) {
        return source.slice(start, end);
    }

    return `$${node.value ?? ""}$`;
}
