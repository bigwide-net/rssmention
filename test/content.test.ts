import { CommentRules, parseConfig } from '../lib/config';
import { decodeEntities, processContent, processTitle } from '../lib/content';

const config = parseConfig(`{baseUrl: 'https://x.org', groups: {g: {name: 'n', topic: 't', adminToken: 'abcdefghijklmn'}}}`);
const rules: CommentRules = { ...config.groups.g.comments, urlAutoLinking: false, minLength: 0 };
const all: CommentRules = { ...rules, allowImages: true, allowTables: true, allowHeadlines: true, allowLists: true, allowQuote: true };

function ok(input: Parameters<typeof processContent>[0], r = rules): string {
    const result = processContent(input, r);
    if (!result.ok) throw new Error(`Expected success, got ${result.code}: ${result.text}`);
    return result.html;
}

function failure(input: Parameters<typeof processContent>[0], r = rules) {
    const result = processContent(input, r);
    if (result.ok) throw new Error(`Expected failure, got ${result.html}`);
    return result;
}

describe('processContent()', () => {
    describe('minLength', () => {
        const min = { ...rules, minLength: 10 };

        it('defaults to 10', () => {
            expect(config.groups.g.posts.minLength).toBe(10);
            expect(config.groups.g.comments.minLength).toBe(10);
        });

        it('rejects content with less visible text', () => {
            expect(failure({ markdown: 'Too **short**' }, { ...rules, minLength: 20 })).toEqual({ ok: false, code: 'too-short',
                text: 'Post must have at least 20 characters of text: 9 characters in post' });
            expect(failure({ html: '<p>Thanks!</p>' }, min).code).toBe('too-short');
            expect(failure({ html: '<p>  a    b  </p>' }, { ...min, minLength: 4 }).code).toBe('too-short');
        });

        it('counts text, not markup', () => {
            expect(ok({ html: '<p><strong>0123456789</strong></p>' }, min)).toBe('<p><strong>0123456789</strong></p>');
            expect(ok({ markdown: '0123456789' }, min)).toBe('<p>0123456789</p>');
            expect(ok({ html: '<p>01234<em>56789</em></p>' }, min)).toBe('<p>01234<em>56789</em></p>');
            expect(failure({ html: '<p>01234<em>5678</em></p>' }, min).code).toBe('too-short');
        });
    });

    describe('markdown', () => {
        it('converts markdown to html', () => {
            expect(ok({ markdown: 'Hello **world** and *you*' })).toBe('<p>Hello <strong>world</strong> and <em>you</em></p>');
        });

        it('prefers markdown over html', () => {
            expect(ok({ markdown: 'from markdown', html: '<p>from html</p>' })).toBe('<p>from markdown</p>');
        });

        it('escapes raw html in markdown instead of interpreting it', () => {
            expect(ok({ markdown: 'a <script>alert(1)</script> b' })).toBe('<p>a &lt;script&gt;alert(1)&lt;/script&gt; b</p>');
        });

        it('rejects headlines unless allowed', () => {
            expect(failure({ markdown: '# Title' })).toMatchObject({ code: 'forbidden-element', text: expect.stringContaining('allowHeadlines') });
            expect(ok({ markdown: '# Title' }, all)).toBe('<h1>Title</h1>');
        });

        it('strips the class attribute of code blocks', () => {
            expect(ok({ markdown: '```js\nlet x = 1;\n```' })).toBe('<pre><code>let x = 1;\n</code></pre>');
        });

        it('does not render strikethrough', () => {
            expect(ok({ markdown: '~~gone~~' })).toBe('<p>~~gone~~</p>');
        });

        it('rejects javascript links', () => {
            // markdown-it refuses to link javascript: URLs, so the text stays literal
            expect(ok({ markdown: '[x](javascript:alert(1))' })).not.toContain('<a');
        });

        it('allows images only when enabled, keeping alt', () => {
            expect(failure({ markdown: '![cat](https://img.example/cat.png)' }).code).toBe('forbidden-element');
            expect(ok({ markdown: '![cat](https://img.example/cat.png)' }, all)).toBe('<p><img src="https://img.example/cat.png" alt="cat"></p>');
        });

        it('allows tables when enabled', () => {
            const html = ok({ markdown: '| a | b |\n|---|---|\n| 1 | 2 |' }, all);
            expect(html).toContain('<table>');
            expect(html).toContain('<td>1</td>');
        });

        it('measures the length of the markdown', () => {
            const md = 'a'.repeat(rules.maxLength + 1);
            expect(failure({ markdown: md })).toEqual({ ok: false, code: 'too-long', text: `Post limit of ${rules.maxLength} characters exceeded: ${rules.maxLength + 1} characters in post` });
        });
    });

    describe('html', () => {
        it('accepts simple paragraphs and line breaks', () => {
            expect(ok({ html: '<p>one<br/>two</p><p>three</p>' })).toBe('<p>one<br>two</p><p>three</p>');
        });

        it('strips attributes other than a@href and img@src/alt', () => {
            expect(ok({ html: '<p class="x" style="color:red">a <a href="https://a.example/" target="_blank" rel="nofollow">link</a></p>' }))
                .toBe('<p>a <a href="https://a.example/">link</a></p>');
        });

        it('rejects unclosed tags', () => {
            expect(failure({ html: '<p>open' }).code).toBe('malformed-html');
        });

        it('rejects mismatched tags', () => {
            expect(failure({ html: '<p><strong>x</p></strong>' }).code).toBe('malformed-html');
        });

        it('rejects stray closing tags', () => {
            expect(failure({ html: '<p>a</p></em>' }).code).toBe('malformed-html');
        });

        it('rejects unescaped <', () => {
            expect(failure({ html: '<p>1 < 2</p>' }).code).toBe('malformed-html');
        });

        it('rejects self-closing non-void elements', () => {
            expect(failure({ html: '<p/>' }).code).toBe('malformed-html');
        });

        it('ignores comments', () => {
            expect(ok({ html: '<p>a<!-- hidden --></p>' })).toBe('<p>a</p>');
        });

        it('rejects unknown elements, naming them', () => {
            expect(failure({ html: '<p><b>bold</b></p>' })).toEqual({ ok: false, code: 'forbidden-element', text: 'The element <b> is not allowed' });
            expect(failure({ html: '<script>x</script>' }).text).toContain('<script>');
            expect(failure({ html: '<div>x</div>' }).code).toBe('forbidden-element');
        });

        it('applies the style, link, code and quote switches', () => {
            expect(failure({ html: '<p><strong>x</strong></p>' }, { ...rules, allowStyle: false }).text).toContain('allowStyle');
            expect(failure({ html: '<p><a href="https://a.example">x</a></p>' }, { ...rules, allowLinks: false }).text).toContain('allowLinks');
            expect(failure({ html: '<pre>x</pre>' }, { ...rules, allowCode: false }).text).toContain('allowCode');
            expect(failure({ html: '<blockquote>x</blockquote>' }, { ...rules, allowQuote: false }).text).toContain('allowQuote');
            expect(ok({ html: '<blockquote><p>x</p></blockquote><p><q>y</q></p>' }, all)).toBe('<blockquote><p>x</p></blockquote><p><q>y</q></p>');
        });

        it('requires href and src', () => {
            expect(failure({ html: '<a>x</a>' }).code).toBe('missing-attribute');
            expect(failure({ html: '<img alt="x">' }, all).code).toBe('missing-attribute');
        });

        it('rejects non-http urls', () => {
            expect(failure({ html: '<a href="javascript:alert(1)">x</a>' }).code).toBe('invalid-url');
            expect(failure({ html: '<a href="/relative">x</a>' }).code).toBe('invalid-url');
        });

        it('limits url and link text length', () => {
            expect(failure({ html: `<a href="https://a.example/${'x'.repeat(520)}">x</a>` }).code).toBe('url-too-long');
            expect(failure({ html: `<img src="https://a.example/${'x'.repeat(520)}">` }, all).code).toBe('url-too-long');
            expect(failure({ html: `<a href="https://a.example/">${'x'.repeat(121)}</a>` }).code).toBe('link-text-too-long');
            expect(ok({ html: `<a href="https://a.example/">${'x'.repeat(120)}</a>` })).toContain('</a>');
        });

        it('rejects nested links', () => {
            expect(failure({ html: '<a href="https://a.example/"><a href="https://b.example/">x</a></a>' }).code).toBe('bad-nesting');
        });

        it('checks list nesting', () => {
            expect(ok({ html: '<ul><li>a</li><li>b<ol><li>c</li></ol></li></ul>' }, all)).toBe('<ul><li>a</li><li>b<ol><li>c</li></ol></li></ul>');
            expect(failure({ html: '<li>a</li>' }, all).code).toBe('bad-nesting');
            expect(failure({ html: '<ul><p>a</p></ul>' }, all).code).toBe('bad-nesting');
            expect(failure({ html: '<ul>text</ul>' }, all).code).toBe('bad-nesting');
            expect(failure({ html: '<ul><li>a</li></ul>' }, { ...all, allowLists: false }).code).toBe('forbidden-element');
        });

        it('checks table nesting', () => {
            expect(ok({ html: '<table><tr><th>a</th></tr><tr><td>b</td></tr></table>' }, all)).toContain('<td>b</td>');
            expect(failure({ html: '<table><td>b</td></table>' }, all).code).toBe('bad-nesting');
            expect(failure({ html: '<tr><td>b</td></tr>' }, all).code).toBe('bad-nesting');
        });

        it('collapses more than two consecutive <br>', () => {
            const text = 'x'.repeat(400);
            expect(ok({ html: `<p>${text}<br><br> <br/><br>${text}</p>` })).toBe(`<p>${text}<br><br> ${text}</p>`);
        });

        it('limits the number of <br> and <p> relative to the text length', () => {
            expect(ok({ html: '<p>a<br>b<br>c<br>d</p>' })).toContain('<br>');
            expect(failure({ html: '<p>a<br>b<br>c<br>d<br>e</p>' }).code).toBe('weird-formatting');
            expect(ok({ html: `<p>${'x'.repeat(80)}<br>b<br>c<br>d<br>e</p>` })).toContain('<br>');
            expect(failure({ html: '<p>a</p><p>b</p><p>c</p><p>d</p>' }).code).toBe('weird-formatting');
            expect(ok({ html: `<p>${'x'.repeat(200)}</p><p>b</p><p>c</p><p>d</p>` })).toContain('<p>d</p>');
        });

        it('keeps entities', () => {
            expect(ok({ html: '<p>1 &lt; 2 &amp; 3</p>' })).toBe('<p>1 &lt; 2 &amp; 3</p>');
        });

        it('rejects empty content', () => {
            expect(failure({}).code).toBe('empty-content');
            expect(failure({ html: '<p> </p>' }).code).toBe('empty-content');
        });

        it('measures the length of the html when there is no markdown', () => {
            expect(failure({ html: '<p>' + 'a'.repeat(rules.maxLength) + '</p>' }).code).toBe('too-long');
        });
    });

    describe('content_text', () => {
        it('escapes text and converts paragraphs', () => {
            expect(ok({ text: 'a < b\nc\n\nd' })).toBe('<p>a &lt; b<br>c</p>\n<p>d</p>');
        });
    });

    describe('url auto-linking', () => {
        const linking = { ...rules, urlAutoLinking: true };

        it('links bare urls', () => {
            expect(ok({ markdown: 'see https://a.example/x?y=1&z=2 now' }, linking))
                .toBe('<p>see <a href="https://a.example/x?y=1&amp;z=2">https://a.example/x?y=1&amp;z=2</a> now</p>');
        });

        it('links even when allowLinks is disabled', () => {
            expect(ok({ markdown: 'see https://a.example/' }, { ...linking, allowLinks: false })).toContain('<a href="https://a.example/">');
        });

        it('does not link inside links and code', () => {
            expect(ok({ html: '<p><a href="https://b.example/">https://a.example/</a> <code>https://c.example/</code></p>' }, linking))
                .toBe('<p><a href="https://b.example/">https://a.example/</a> <code>https://c.example/</code></p>');
        });

        it('does not link without urlAutoLinking', () => {
            expect(ok({ markdown: 'see https://a.example/' })).toBe('<p>see https://a.example/</p>');
        });
    });
});

describe('processTitle()', () => {
    it('enforces required titles', () => {
        expect(processTitle(undefined, 'required')).toMatchObject({ ok: false, code: 'title-required' });
        expect(processTitle('  Hi  there ', 'required')).toEqual({ ok: true, title: 'Hi there' });
    });

    it('enforces forbidden titles', () => {
        expect(processTitle('x', 'none', 'Comment')).toMatchObject({ ok: false, code: 'title-not-allowed', text: 'Comments must not have a title' });
        expect(processTitle(undefined, 'none')).toEqual({ ok: true, title: undefined });
    });

    it('limits title length', () => {
        expect(processTitle('x'.repeat(201), 'allowed')).toMatchObject({ ok: false, code: 'title-too-long' });
    });
});

describe('decodeEntities()', () => {
    it('decodes named and numeric entities', () => {
        expect(decodeEntities('&amp;&lt;&#65;&#x42;&unknown;')).toBe('&<AB&unknown;');
    });
});
