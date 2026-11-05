// Validates and normalizes submitted content. Markdown (preferred) is converted to HTML; the HTML is
// then checked with a strict tokenizer: tags must be properly nested and closed, only elements
// allowed by the rules may appear, and all attributes except a@href, img@src and img@alt are removed.
import MarkdownIt from 'markdown-it';
import { LinkifyIt } from 'linkify-it';
import { SubmissionRules, TitleRule } from './config';

export type FailureCode =
    | 'empty-content' | 'too-short' | 'too-long' | 'malformed-html' | 'forbidden-element' | 'bad-nesting' | 'missing-attribute'
    | 'invalid-url' | 'url-too-long' | 'link-text-too-long' | 'weird-formatting' | 'title-required' | 'title-not-allowed'
    | 'title-too-long';

export interface ContentFailure {
    ok: false;
    code: FailureCode;
    text: string;
}

export interface ContentSuccess {
    ok: true;
    html: string;
    markdown?: string;
}

export type ContentResult = ContentSuccess | ContentFailure;

export interface ContentInput {
    markdown?: string;
    html?: string;
    text?: string;
}

export const MAX_URL_LENGTH = 512;
export const MAX_LINK_TEXT_LENGTH = 120;
export const MAX_TITLE_LENGTH = 200;
const MAX_CONSECUTIVE_BR = 2;

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const linkify = new LinkifyIt().set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

// Element -> the rule that allows it. Elements without entry are always forbidden.
const ELEMENT_RULES: Record<string, keyof SubmissionRules | 'always'> = {
    p: 'always', br: 'always',
    strong: 'allowStyle', em: 'allowStyle', s: 'allowStyle',
    a: 'allowLinks',
    code: 'allowCode', pre: 'allowCode',
    q: 'allowQuote', blockquote: 'allowQuote',
    img: 'allowImages',
    table: 'allowTables', thead: 'allowTables', tbody: 'allowTables', tr: 'allowTables', td: 'allowTables', th: 'allowTables',
    ul: 'allowLists', ol: 'allowLists', li: 'allowLists',
    h1: 'allowHeadlines', h2: 'allowHeadlines', h3: 'allowHeadlines', h4: 'allowHeadlines', h5: 'allowHeadlines', h6: 'allowHeadlines',
};
const VOID_ELEMENTS = new Set(['br', 'img']);
const KEPT_ATTRIBUTES: Record<string, string[]> = { a: ['href'], img: ['src', 'alt'] };
const REQUIRED_ATTRIBUTES: Record<string, string> = { a: 'href', img: 'src' };
// Allowed parents for elements that must be nested in a specific way.
const REQUIRED_PARENTS: Record<string, string[]> = {
    thead: ['table'], tbody: ['table'], tr: ['table', 'thead', 'tbody'], td: ['tr'], th: ['tr'], li: ['ul', 'ol'],
};
// Elements that may only contain the given elements (and whitespace).
const ALLOWED_CHILDREN: Record<string, string[]> = {
    table: ['thead', 'tbody', 'tr'], thead: ['tr'], tbody: ['tr'], tr: ['td', 'th'], ul: ['li'], ol: ['li'],
};

type Token =
    | { type: 'open', name: string, attrs: Record<string, string> }
    | { type: 'close', name: string }
    | { type: 'text', raw: string };

const fail = (code: FailureCode, text: string): ContentFailure => ({ ok: false, code, text });

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
        if (e[0] == '#') {
            const code = e[1] == 'x' || e[1] == 'X' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
            try { return String.fromCodePoint(code); } catch { return m; }
        }
        return NAMED_ENTITIES[e] ?? m;
    });
}

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const OPEN_TAG_RE = /^<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const CLOSE_TAG_RE = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>/;
const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// Strict tokenizer. Returns a failure for anything that isn't a plain tag, comment or text.
function tokenize(html: string): Token[] | ContentFailure {
    const tokens: Token[] = [];
    let pos = 0;
    while (pos < html.length) {
        const lt = html.indexOf('<', pos);
        if (lt < 0) {
            tokens.push({ type: 'text', raw: html.substring(pos) });
            break;
        }
        if (lt > pos)
            tokens.push({ type: 'text', raw: html.substring(pos, lt) });
        const rest = html.substring(lt);
        if (rest.startsWith('<!--')) {
            const end = html.indexOf('-->', lt + 4);
            if (end < 0) return fail('malformed-html', 'Unterminated HTML comment');
            pos = end + 3;
            continue;
        }
        let m = CLOSE_TAG_RE.exec(rest);
        if (m) {
            tokens.push({ type: 'close', name: m[1].toLowerCase() });
            pos = lt + m[0].length;
            continue;
        }
        m = OPEN_TAG_RE.exec(rest);
        if (!m)
            return fail('malformed-html', `Malformed HTML near "${rest.substring(0, 30)}"`);
        const name = m[1].toLowerCase();
        const attrs: Record<string, string> = {};
        for (const a of m[2].matchAll(ATTR_RE))
            attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
        tokens.push({ type: 'open', name, attrs });
        if (m[3]) {
            if (!VOID_ELEMENTS.has(name))
                return fail('malformed-html', `<${name}/> must not be self-closing`);
        }
        if (VOID_ELEMENTS.has(name))
            tokens.push({ type: 'close', name });
        pos = lt + m[0].length;
    }
    return tokens;
}

function checkUrl(name: string, attr: string, value: string): ContentFailure | undefined {
    if (value.length > MAX_URL_LENGTH)
        return fail('url-too-long', `${name}@${attr} exceeds ${MAX_URL_LENGTH} characters`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return fail('invalid-url', `${name}@${attr} must be an absolute URL: ${value.substring(0, 80)}`);
    }
    if (url.protocol != 'http:' && url.protocol != 'https:')
        return fail('invalid-url', `${name}@${attr} must be a http(s) URL`);
    return undefined;
}

// Validates the token stream against the rules and returns the sanitized tokens.
function validateTokens(tokens: Token[], rules: SubmissionRules): Token[] | ContentFailure {
    const out: Token[] = [];
    const stack: string[] = [];
    let linkText: string | undefined;
    for (const token of tokens) {
        const parent = stack[stack.length - 1];
        if (token.type == 'text') {
            if (parent && ALLOWED_CHILDREN[parent] && token.raw.trim())
                return fail('bad-nesting', `Text is not allowed directly inside <${parent}>`);
            if (linkText !== undefined) linkText += decodeEntities(token.raw);
            out.push(token);
            continue;
        }
        if (token.type == 'close') {
            if (parent != token.name)
                return fail('malformed-html', parent ? `Expected </${parent}> but found </${token.name}>` : `Unexpected </${token.name}>`);
            stack.pop();
            if (token.name == 'a') {
                if (linkText!.trim().length > MAX_LINK_TEXT_LENGTH)
                    return fail('link-text-too-long', `Link text exceeds ${MAX_LINK_TEXT_LENGTH} characters`);
                linkText = undefined;
            }
            out.push(token);
            continue;
        }
        const rule = ELEMENT_RULES[token.name];
        if (!rule)
            return fail('forbidden-element', `The element <${token.name}> is not allowed`);
        if (rule != 'always' && !rules[rule])
            return fail('forbidden-element', `The element <${token.name}> is not allowed (${rule} is disabled)`);
        const required = REQUIRED_PARENTS[token.name];
        if (required && !required.includes(parent))
            return fail('bad-nesting', `<${token.name}> must be inside ${required.map(p => `<${p}>`).join(' or ')}`);
        if (parent && ALLOWED_CHILDREN[parent] && !ALLOWED_CHILDREN[parent].includes(token.name))
            return fail('bad-nesting', `<${token.name}> is not allowed directly inside <${parent}>`);
        if (token.name == 'a' && stack.includes('a'))
            return fail('bad-nesting', 'Links must not be nested');
        const attrs: Record<string, string> = {};
        for (const attr of KEPT_ATTRIBUTES[token.name] ?? [])
            if (token.attrs[attr] !== undefined) attrs[attr] = token.attrs[attr];
        const requiredAttr = REQUIRED_ATTRIBUTES[token.name];
        if (requiredAttr) {
            if (!attrs[requiredAttr])
                return fail('missing-attribute', `<${token.name}> requires the ${requiredAttr} attribute`);
            const urlFailure = checkUrl(token.name, requiredAttr, attrs[requiredAttr]);
            if (urlFailure) return urlFailure;
        }
        if (token.name == 'a') linkText = '';
        stack.push(token.name);
        out.push({ type: 'open', name: token.name, attrs });
    }
    if (stack.length)
        return fail('malformed-html', `Unclosed <${stack[stack.length - 1]}>`);
    return out;
}

// Removes <br> runs longer than MAX_CONSECUTIVE_BR (whitespace in between doesn't break a run).
function collapseBreaks(tokens: Token[]): Token[] {
    const out: Token[] = [];
    let run = 0;
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type == 'open' && t.name == 'br') {
            run++;
            i++; // skip the matching close token
            if (run > MAX_CONSECUTIVE_BR) continue;
            out.push(t, tokens[i]);
        } else {
            if (!(t.type == 'text' && !t.raw.trim())) run = 0;
            out.push(t);
        }
    }
    return out;
}

const INLINE_ELEMENTS = new Set(['strong', 'em', 's', 'a', 'code', 'q']);

// Length of the visible text, with whitespace runs collapsed to one space. Block elements and <br>
// separate words; inline elements don't.
function textLength(tokens: Token[]): number {
    const text = tokens.map(t => t.type == 'text' ? decodeEntities(t.raw) : INLINE_ELEMENTS.has(t.name) ? '' : ' ').join('');
    return text.replace(/\s+/g, ' ').trim().length;
}

function checkFormatting(tokens: Token[]): ContentFailure | undefined {
    const len = textLength(tokens);
    const brs = tokens.filter(t => t.type == 'open' && t.name == 'br').length;
    const ps = tokens.filter(t => t.type == 'open' && t.name == 'p').length;
    const maxBr = 3 + Math.floor(len / 80), maxP = 3 + Math.floor(len / 200);
    if (brs > maxBr)
        return fail('weird-formatting', `Too many line breaks for the text length (${brs}, max. ${maxBr})`);
    if (ps > maxP)
        return fail('weird-formatting', `Too many paragraphs for the text length (${ps}, max. ${maxP})`);
    return undefined;
}

// Turns bare http(s) URLs in text into links, except inside links and code.
function autoLink(tokens: Token[]): Token[] {
    const out: Token[] = [];
    let protectedDepth = 0;
    for (const t of tokens) {
        if (t.type == 'open' && ['a', 'code', 'pre'].includes(t.name)) protectedDepth++;
        if (t.type == 'close' && ['a', 'code', 'pre'].includes(t.name)) protectedDepth--;
        const matches = t.type == 'text' && !protectedDepth ? linkify.match(t.raw) : null;
        if (t.type != 'text' || !matches) {
            out.push(t);
            continue;
        }
        let pos = 0;
        for (const m of matches) {
            const href = decodeEntities(m.raw);
            if (!/^https?:\/\//i.test(href) || href.length > MAX_URL_LENGTH) continue;
            if (m.index > pos) out.push({ type: 'text', raw: t.raw.substring(pos, m.index) });
            out.push({ type: 'open', name: 'a', attrs: { href } }, { type: 'text', raw: t.raw.substring(m.index, m.lastIndex) }, { type: 'close', name: 'a' });
            pos = m.lastIndex;
        }
        if (pos < t.raw.length) out.push({ type: 'text', raw: t.raw.substring(pos) });
    }
    return out;
}

function serialize(tokens: Token[]): string {
    return tokens.map(t => {
        if (t.type == 'text') return t.raw;
        if (t.type == 'close') return VOID_ELEMENTS.has(t.name) ? '' : `</${t.name}>`;
        const attrs = Object.entries(t.attrs).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('');
        return `<${t.name}${attrs}>`;
    }).join('');
}

export function textToHtml(text: string): string {
    return text.trim().split(/\n\s*\n/).map(p => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('\n');
}

export function markdownToHtml(md: string): string {
    return markdown.render(md).trim();
}

/**
 * Validates submitted content. `kind` ("Post" or "Comment") is used in messages.
 */
export function processContent(input: ContentInput, rules: SubmissionRules, kind = 'Post'): ContentResult {
    const md = input.markdown?.trim();
    const source = md ?? input.html?.trim() ?? input.text?.trim();
    if (!source)
        return fail('empty-content', `${kind} has no content`);
    if (source.length > rules.maxLength)
        return fail('too-long', `${kind} limit of ${rules.maxLength} characters exceeded: ${source.length} characters in ${kind.toLowerCase()}`);
    const html = md !== undefined ? markdownToHtml(md) : input.html?.trim() ? input.html.trim() : textToHtml(source);

    const tokens = tokenize(html);
    if (!Array.isArray(tokens)) return tokens;
    const validated = validateTokens(tokens, rules);
    if (!Array.isArray(validated)) return validated;
    let result = collapseBreaks(validated);
    const formatFailure = checkFormatting(result);
    if (formatFailure) return formatFailure;
    if (rules.urlAutoLinking)
        result = autoLink(result);
    if (!textLength(result) && !result.some(t => t.type == 'open' && t.name == 'img'))
        return fail('empty-content', `${kind} has no content`);
    const len = textLength(result);
    if (len < rules.minLength)
        return fail('too-short', `${kind} must have at least ${rules.minLength} characters of text: ${len} characters in ${kind.toLowerCase()}`);
    return { ok: true, html: serialize(result).trim(), markdown: md };
}

export function processTitle(title: string | undefined, rule: TitleRule, kind = 'Post'): { ok: true, title?: string } | ContentFailure {
    const t = title?.replace(/\s+/g, ' ').trim() || undefined;
    if (rule == 'required' && !t)
        return fail('title-required', `${kind}s require a title`);
    if (rule == 'none' && t)
        return fail('title-not-allowed', `${kind}s must not have a title`);
    if (t && t.length > MAX_TITLE_LENGTH)
        return fail('title-too-long', `Title exceeds ${MAX_TITLE_LENGTH} characters`);
    return { ok: true, title: t };
}
