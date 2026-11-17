import { processContent } from '../lib/content';
import { parseFeed } from '../lib/feed-parse';
import { createLog, setLogSilent } from '../lib/log';
import { buildItem, buildMention } from '../lib/processor';
import { escapeXml } from '../lib/render';
import {
    cleanLine, cleanText, escapeForLog, hasForbiddenChars, httpUrl, isValidExternalGuid, MAX_NAME_LENGTH, quote, stripXmlInvalid, truncate,
} from '../lib/sanitize';
import { jsonFeed, rssFeed, testConfig } from './helpers';

const RLO = '‮', ZWSP = '​', BOM = '﻿';

describe('sanitize', () => {
    describe('cleanText()', () => {
        it('removes control, bidi and invisible characters but keeps tabs, newlines and Unicode text', () => {
            expect(cleanText(`a\u0000b\u0001c\u007F\u0085d${RLO}e⁦f${ZWSP}g${BOM}h­i`)).toBe('abcdefghi');
            expect(cleanText('line1\r\nline2\rline3 line4\ttab')).toBe('line1\nline2\nline3\nline4\ttab');
            expect(cleanText('Grüße, 日本語, Ελληνικά, عربي, emoji 👩‍👩‍👧')).toBe('Grüße, 日本語, Ελληνικά, عربي, emoji 👩‍👩‍👧');
        });

        it('removes unpaired surrogates and noncharacters', () => {
            expect(cleanText('a\uD800b\uDC00c￾d﷐e\u{1FFFF}f\u{10FFFF}g')).toBe('abcdefg');
            expect(cleanText('😀')).toBe('😀');
        });

        it('normalizes to NFC', () => {
            expect(cleanText('é')).toBe('é');
        });
    });

    it('cleanLine() collapses whitespace and truncates', () => {
        expect(cleanLine('  a \n\t b  ')).toBe('a b');
        expect(cleanLine('abcdef', 3)).toBe('abc');
        expect(truncate('ab😀', 3)).toBe('ab');
    });

    it('quote() shortens values for messages', () => {
        expect(quote('x'.repeat(200))).toBe('x'.repeat(100) + '…');
        expect(quote(`a\nb${RLO}`)).toBe('a b');
    });

    it('hasForbiddenChars() detects line breaks, tabs and invisible characters', () => {
        expect(hasForbiddenChars('https://a.example/x')).toBe(false);
        expect(hasForbiddenChars('https://a.example/ü')).toBe(false);
        for (const c of ['\n', '\t', '\r', '\u0000', RLO, ZWSP, ' ', '\uD800'])
            expect(hasForbiddenChars(`a${c}b`)).toBe(true);
    });

    it('isValidExternalGuid() accepts printable ASCII of at most 512 characters', () => {
        expect(isValidExternalGuid('post-42')).toBe(true);
        expect(isValidExternalGuid('tag:blog.example,2026:post 42')).toBe(true);
        expect(isValidExternalGuid('x'.repeat(512))).toBe(true);
        expect(isValidExternalGuid('x'.repeat(513))).toBe(false);
        expect(isValidExternalGuid('')).toBe(false);
        expect(isValidExternalGuid('\u0001x')).toBe(false);
        expect(isValidExternalGuid('pöst')).toBe(false);
        expect(isValidExternalGuid(42)).toBe(false);
    });

    it('httpUrl() returns the ASCII href of http(s) URLs', () => {
        expect(httpUrl('https://a.example/ü?q=ä#f', 512)).toBe('https://a.example/%C3%BC?q=%C3%A4#f');
        expect(httpUrl('https://bücher.example/', 512)).toBe('https://xn--bcher-kva.example/');
        expect(httpUrl('javascript:alert(1)', 512)).toBeUndefined();
        expect(httpUrl('/relative', 512)).toBeUndefined();
        expect(httpUrl(`https://a.example/${'x'.repeat(600)}`, 512)).toBeUndefined();
    });

    it('escapeForLog() escapes line breaks and invisible characters', () => {
        expect(escapeForLog(`a\nb\r${RLO}c\u0000`)).toBe('a\\u{a}b\\u{d}\\u{202e}c\\u{0}');
        expect(escapeForLog('Grüße')).toBe('Grüße');
    });

    it('stripXmlInvalid() and escapeXml() never emit characters that are invalid in XML', () => {
        expect(stripXmlInvalid('a\u0001b￿c\td\n')).toBe('abc\td\n');
        expect(escapeXml('<\u0000>')).toBe('&lt;&gt;');
    });
});

describe('sanitizing of feed input', () => {
    it('cleans all fields of RSS items', () => {
        const feed = parseFeed(rssFeed([{
            guid: `g${ZWSP}1`, title: `Ti\u0001tle${RLO}`, markdown: `md\u0000 text\r\nline2`, author: `Al\u0007ice\n Smith`,
            link: `https://alice.example/${RLO}x`, inReplyTo: `https://rm.example/groups/g/posts.xml${ZWSP}`,
        }]).replace('&#x0;', ''));
        expect(feed.items[0]).toMatchObject({
            guid: 'g1', title: 'Title', markdown: 'md text\nline2', authorName: 'Alice Smith',
            url: 'https://alice.example/x', inReplyTo: 'https://rm.example/groups/g/posts.xml',
        });
    });

    it('cleans all fields of JSON items and limits author names', () => {
        const feed = parseFeed(jsonFeed([{
            guid: `g\u00001`, title: `T${RLO}`, html: `<p>a\u0000b</p>`, author: 'A'.repeat(500), account: `@bob.example${ZWSP}`,
        }]));
        expect(feed.items[0]).toMatchObject({ guid: 'g1', title: 'T', html: '<p>ab</p>', socialSpec: '@bob.example' });
        expect(feed.items[0].authorName).toHaveLength(MAX_NAME_LENGTH);
    });

    it('skips items with absurdly long guids', () => {
        expect(parseFeed(jsonFeed([{ guid: 'x'.repeat(3000) }, { guid: 'ok' }])).items.map(i => i.guid)).toEqual(['ok']);
    });

    it('drops character references to forbidden characters in content', () => {
        const rules = { minLength: 0, maxLength: 1000, urlAutoLinking: false, allowStyle: true, allowLinks: true, allowCode: false, allowQuote: false,
            allowImages: true, allowTables: false, allowLists: false, allowHeadlines: false, requireSocialSpec: false, title: 'allowed', allowEdit: false,
            allowDelete: false, commentLimit: 10 } as any;
        const result = processContent({ html: '<p>a&#x202E;b&#1;c&#65;&#x1F600;</p><img src="https://a.example/i.png" alt="x&#x202E;y">' }, rules);
        expect(result).toEqual({ ok: true, html: '<p>abc&#65;&#x1F600;</p><img src="https://a.example/i.png" alt="xy">' });
    });
});

describe('sanitizing in the processor', () => {
    let cleanup: () => void;
    let config: any;
    beforeEach(() => ({ config, cleanup } = testConfig()));
    afterEach(() => cleanup());

    const sub = (guid: string) => ({ space: config.groups.twowaves, guid, source: 'https://alice.example/feed.xml', target: 'https://rm.example/groups/twowaves/posts.xml', update: false });
    const src = (overrides: any = {}) => ({
        guid: 'p1', title: 'Hello', markdown: 'Some text', inReplyTo: 'https://rm.example/groups/twowaves/posts.xml', authorName: 'Alice', ...overrides,
    });

    it('drops item links that are not absolute http(s) URLs of sensible length, and normalizes the others', () => {
        const at = new Date();
        expect(buildItem(config.groups.twowaves, sub('AAAAAAAAAA'), src({ url: 'javascript:alert(1)' }), at).item.url).toBeUndefined();
        expect(buildItem(config.groups.twowaves, sub('AAAAAAAAAA'), src({ url: `https://a.example/${'x'.repeat(600)}` }), at).item.url).toBeUndefined();
        expect(buildItem(config.groups.twowaves, sub('AAAAAAAAAA'), src({ url: 'https://alice.example/ü' }), at).item.url).toBe('https://alice.example/%C3%BC');
    });

    it('quotes untrusted values in failure texts only briefly', () => {
        const { failure } = buildItem(config.groups.twowaves, sub('AAAAAAAAAA'), src({ inReplyTo: 'https://x.example/' + 'y'.repeat(5000) }), new Date());
        expect(failure?.code).toBe('in-reply-to-mismatch');
        expect(failure!.text.length).toBeLessThan(300);
    });

    it('does not keep an invalid mention link in the stored item', () => {
        const space = config.feedComments.blog;
        const s = { space, guid: 'AAAAAAAAAA-aaaaa', source: 'https://carol.example/feed.xml', target: 'x', update: false };
        const { item, failure } = buildMention(space, s, src({ url: `https://carol.example/${'x'.repeat(5000)}` }) as any, new Date(), { external: 'post-42' });
        expect(failure?.code).toBe('url-too-long');
        expect(item.url).toBeUndefined();
    });
});

describe('log', () => {
    it('escapes line breaks in arguments, so they cannot forge log lines', () => {
        const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
        setLogSilent(false);
        try {
            createLog('t').info('Accepted {0}', 'https://a.example/\n[rssmention] FAKE');
            createLog('t').info('request', { path: `/x\n${RLO}` });
            const lines = spy.mock.calls.map(c => c.join(' '));
            expect(lines).toEqual(['[t] Accepted https://a.example/\\u{a}[rssmention] FAKE', '[t] request {"path":"/x\\n\\u{202e}"}']);
        } finally {
            setLogSilent(true);
            spy.mockRestore();
        }
    });
});
