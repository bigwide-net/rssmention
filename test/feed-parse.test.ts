import { FeedParseError, findSourceItem, parseFeed } from '../lib/feed-parse';
import { jsonFeed, rssFeed } from './helpers';

describe('parseFeed()', () => {
    describe('RSS', () => {
        it('extracts items with source namespace elements', () => {
            const date = new Date('2026-11-01T10:00:00Z');
            const feed = parseFeed(rssFeed([{
                guid: 'c1', title: 'Hi', html: '<p>html</p>', markdown: 'md *x*', inReplyTo: 'https://rm.example/groups/g/posts.xml',
                account: '@alice.example', author: 'Alice', pubDate: date, link: 'https://alice.example/c1',
            }]));
            expect(feed.format).toBe('rss');
            expect(feed.title).toBe('Alice');
            expect(feed.items).toEqual([{
                guid: 'c1', title: 'Hi', html: '<p>html</p>', markdown: 'md *x*', inReplyTo: 'https://rm.example/groups/g/posts.xml',
                socialSpec: '@alice.example', authorName: 'Alice', pubDate: date, url: 'https://alice.example/c1', allowComments: undefined,
            }]);
        });

        it('inherits the channel socialspec account', () => {
            const feed = parseFeed(rssFeed([{ guid: 'c1', html: 'x' }], '@alice.example'));
            expect(feed.items[0].socialSpec).toBe('@alice.example');
        });

        it('resolves namespace prefixes by URI', () => {
            const feed = parseFeed(`<rss version="2.0" xmlns:s="http://source.scripting.com/" xmlns:content="http://purl.org/rss/1.0/modules/content/"
                xmlns:r="https://rssmention.bigwide.net/"><channel><title>t</title>
                <item><guid>g</guid><description>short</description><content:encoded>&lt;p&gt;full&lt;/p&gt;</content:encoded>
                <s:markdown>md</s:markdown><s:account service="SocialSpec">@x.example</s:account><s:account service="mastodon">@a@b</s:account>
                <r:commenting><r:allowComments>false</r:allowComments></r:commenting></item></channel></rss>`);
            expect(feed.items[0]).toMatchObject({ guid: 'g', html: '<p>full</p>', markdown: 'md', socialSpec: '@x.example', allowComments: false });
        });

        it('ignores elements of unknown namespaces with a source prefix', () => {
            const feed = parseFeed(`<rss version="2.0" xmlns:source="http://other.example/"><channel><item><guid>g</guid><source:markdown>md</source:markdown></item></channel></rss>`);
            expect(feed.items[0].markdown).toBeUndefined();
        });

        it('rejects non-RSS XML', () => {
            expect(() => parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toThrow(FeedParseError);
            expect(() => parseFeed('<rss><channel>')).toThrow(FeedParseError);
        });
    });

    describe('JSON Feed', () => {
        it('extracts items with _source', () => {
            const feed = parseFeed(jsonFeed([{ guid: 'c1', title: 'T', html: '<p>h</p>', markdown: 'm', inReplyTo: 'https://x/#a', account: '@bob.example', author: 'Bob' }]));
            expect(feed.format).toBe('json');
            expect(feed.items[0]).toMatchObject({ guid: 'c1', title: 'T', html: '<p>h</p>', markdown: 'm', inReplyTo: 'https://x/#a', socialSpec: '@bob.example', authorName: 'Bob' });
        });

        it('accepts the list and single-object account forms and the object inReplyTo form', () => {
            const feed = parseFeed(JSON.stringify({
                version: 'https://jsonfeed.org/version/1.1',
                _source: { accounts: [{ service: 'mastodon', name: '@a@b' }, { service: 'socialspec', name: '@list.example' }] },
                items: [
                    { id: 1, content_text: 'text', _source: { inReplyTo: { value: 'https://x/', feedUrl: 'https://y/' } } },
                    { id: 'b', content_html: 'h', _source: { account: { service: 'socialspec', name: '@single.example' } }, _commenting: { allowComments: false } },
                ],
            }));
            expect(feed.items[0]).toMatchObject({ guid: '1', text: 'text', inReplyTo: 'https://x/', socialSpec: '@list.example' });
            expect(feed.items[1]).toMatchObject({ guid: 'b', socialSpec: '@single.example', allowComments: false });
        });

        it('rejects JSON that is not a JSON Feed', () => {
            expect(() => parseFeed('{"items": []}')).toThrow(FeedParseError);
            expect(() => parseFeed('{"version": "https://jsonfeed.org/version/1.1"}')).toThrow(FeedParseError);
            expect(() => parseFeed('{bad json')).toThrow(FeedParseError);
        });
    });
});

describe('findSourceItem()', () => {
    const feed = parseFeed(jsonFeed([{ guid: 'a', html: 'x' }, { guid: 'b', html: 'y' }]));
    const single = parseFeed(jsonFeed([{ guid: 'a', html: 'x' }]));

    it('finds items by fragment', () => {
        expect(findSourceItem(feed, 'b')?.toString()).toBeDefined();
        expect((findSourceItem(feed, 'b') as any).guid).toBe('b');
        expect(findSourceItem(feed, 'c')).toBeUndefined();
    });

    it('uses the only item without fragment', () => {
        expect((findSourceItem(single, undefined) as any).guid).toBe('a');
        expect(findSourceItem(feed, undefined)).toBe('ambiguous');
    });
});
