// Math delimiters in model output, normalised for remark-math.
//
// Models write formulas in several dialects: `$x^2$` (Gemini, many open
// models), `$$ … $$` (everyone), and `\( … \)` / `\[ … \]` (ChatGPT-style).
// remark-math is configured with singleDollarTextMath off, because a bare `$`
// pair would turn "costs $5 and $10" into a formula. So every dialect is
// rewritten to `$$ … $$` here, and a single-dollar pair only counts as math
// under the pandoc rules: no space just inside either `$`, and the closing `$`
// is not followed by a digit. Prices therefore stay prices.
//
// Code is never touched: fenced blocks, an unclosed fence still streaming in,
// and inline code spans are carried through verbatim.

const CODE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|```[\s\S]*$|~~~[\s\S]*$|`[^`\n]*`)/

// `\[ … \]` → a display block on its own lines.
const BRACKET_DISPLAY = /\\\[([\s\S]+?)\\\]/g
// `\( … \)` → inline.
const PAREN_INLINE = /\\\(([\s\S]+?)\\\)/g
// `$ … $`: opening not preceded by a word character, `$` or backslash and not
// followed by a space; closing not preceded by a space/backslash and not
// followed by a digit, `$` or word character. Inline only: no newline inside.
const SINGLE_DOLLAR = /(?<![\\$\w])\$(?![\s$])((?:[^$\n\\]|\\.)+?)(?<![\s\\])\$(?![\d$\w])/g

function rewrite(text: string): string {
  return text
    .replace(BRACKET_DISPLAY, (_, body: string) => `\n\n$$\n${body.trim()}\n$$\n\n`)
    .replace(PAREN_INLINE, (_, body: string) => `$$${body.trim()}$$`)
    .replace(SINGLE_DOLLAR, (_, body: string) => `$$${body}$$`)
}

/** Rewrite every math dialect in `markdown` to `$$ … $$`, leaving code alone. */
export function normalizeMath(markdown: string): string {
  if (!/[$\\]/.test(markdown)) return markdown
  return markdown
    .split(CODE)
    // split() with a capture group puts the code segments at the odd indexes.
    .map((part, i) => (i % 2 === 1 ? part : rewrite(part)))
    .join('')
}

/** Whether normalised text holds any math, i.e. whether KaTeX is worth loading. */
export function hasMath(normalized: string): boolean {
  return normalized.includes('$$')
}
