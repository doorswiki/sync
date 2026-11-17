// Validate that every literal <div> rendered by a wikitext page is closed.
//
// HTML comments and <nowiki>/<pre>/<code>/<syntaxhighlight> blocks are
// stripped before counting, so commented-out snippets and code examples do
// not trip the check. Other content models (e.g. JavaScript) are not checked:
// they routinely contain unmatched tags such as `$('<div>')`.

export type div_counts = {
    open : number;
    close : number;
};

function strip_ignored(text : string) : string {
    return text
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(nowiki|pre|code|syntaxhighlight)\b[\s\S]*?<\/\1>/gi, ' ');
};

export function count_divs(text : string) : div_counts {
    const stripped = strip_ignored(text);

    return {
        open : (stripped.match(/<div\b/gi) ?? []).length,
        close : (stripped.match(/<\/div\s*>/gi) ?? []).length,
    };
};

export function has_balanced_divs(text : string) : boolean {
    const { open, close } = count_divs(text);
    return open === close;
};
