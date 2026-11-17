process.env.LIMITS_MAX_PER_IP_PER_MINUTE = '100000';

import request from 'supertest';
import { createApp } from '../controller';
import { processorDeps } from '../lib/processor';
import { whenIdle } from '../lib/queue';
import { clearStatuses } from '../lib/status';
import { readComments, readMentions, readPostMeta } from '../lib/storage';
import { externalPostGuid } from '../lib/ids';
import { ADMIN_TOKEN, BLOG_JSON, BLOG_XML, FeedItemSpec, jsonFeed, rssFeed, testConfig } from './helpers';

const C = 'https://rm.example/comments/blog';
const S = 'comments/blog'; // storage path
const BOB = 'https://bob.example/feed.json';
const CAROL = 'https://carol.example/feed.xml';
const POST_URL = 'https://blog.example/2026/11/post-42';
const POST = externalPostGuid('blog', 'post-42');

describe('feedComments', () => {
    let cleanup: () => void;
    let app: ReturnType<typeof createApp>;
    let sources: Record<string, { status: number, body: string }>;
    let moderationAnswer: { ok: true } | { ok: false, code: 'moderation-rejected' | 'moderation-unavailable', text: string };
    const originalDeps = { ...processorDeps };

    function setup(feedOverrides: any = {}) {
        cleanup?.();
        ({ cleanup } = testConfig({}, feedOverrides));
        app = createApp({ happyServer: false });
    }

    const blogFeed = (items: any[], extra: Record<string, any> = {}) =>
        JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'The Blog', ...extra, items });
    const blogPost = (overrides: any = {}) => ({ id: 'post-42', url: POST_URL, title: 'Blog post', content_html: '<p>Hello</p>', ...overrides });

    beforeEach(() => {
        setup();
        sources = { [BLOG_JSON]: { status: 200, body: blogFeed([blogPost()]) } };
        moderationAnswer = { ok: true };
        processorDeps.fetchFeed = async (source: string) => {
            const url = new URL(source);
            url.hash = '';
            return sources[url.href] ?? { status: 404, body: '' };
        };
        processorDeps.moderate = async () => moderationAnswer;
    });

    afterEach(async () => {
        await whenIdle();
        Object.assign(processorDeps, originalDeps);
        clearStatuses();
        cleanup();
        cleanup = undefined as any;
    });

    const bobComment = (guid: string, inReplyTo: string, overrides: Partial<FeedItemSpec> = {}): FeedItemSpec => ({
        guid, markdown: `Comment ${guid}`, inReplyTo, account: '@bob.example', author: 'Bob', ...overrides,
    });
    // A post in Carol's main feed that mentions the blog post.
    const carolPost = (overrides: Partial<FeedItemSpec> = {}): FeedItemSpec => ({
        guid: 'cp1', title: 'My take on the blog post', link: 'https://carol.example/2026/my-take', author: 'Carol',
        html: `<p>As <a href="${POST_URL}">the blog</a> says, feeds are great.</p>`, ...overrides,
    });

    const mention = (source: string, target: string) =>
        request(app).post('/comments/blog/mention').type('form').send({ source, target });

    async function submit(source: string, target: string) {
        const res = await mention(source, target);
        expect(res.status).toBe(201);
        await whenIdle();
        const status = await request(app).get(`/comments/blog/status/${res.body.guid}`);
        return { guid: res.body.guid as string, status: status.body, location: res.headers.location };
    }

    async function publishComment(guid: string, target: string): Promise<string> {
        sources[BOB] = { status: 200, body: jsonFeed([bobComment(guid, target)]) };
        const res = await submit(`${BOB}#${guid}`, target);
        expect(res.status).toMatchObject({ status: 'success' });
        return res.guid;
    }

    async function publishMention(item: Partial<FeedItemSpec> = {}) {
        sources[CAROL] = { status: 200, body: rssFeed([carolPost(item)]) };
        return submit(`${CAROL}#${item.guid ?? 'cp1'}`, `${BLOG_XML}#post-42`);
    }

    const feed = async (path: string) => (await request(app).get(path)).body;

    describe('comments', () => {
        it('accepts comments on posts of the feed and serves them by the post guid', async () => {
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${BLOG_XML}#post-42`)]) };
            const { guid, status, location } = await submit(`${BOB}#c1`, `${BLOG_XML}#post-42`);
            expect(guid.startsWith(POST + '-')).toBe(true);
            expect(location).toBe(`${C}/status/${guid}`);
            expect(status).toEqual({ status: 'success', pubDate: expect.any(String), pubUrl: `${C}/post/post-42.json#${guid}` });

            const res = await request(app).get('/comments/blog/post/post-42.json');
            expect(res.headers.link).toBe(`<${C}/mention>; rel="webmention"`);
            expect(res.body).toMatchObject({
                title: 'The Blog: replies to a post',
                feed_url: `${C}/post/post-42.json`,
                _submissions: { url: `${C}/mention`, policies: { comments: { requireSocialSpec: true, title: 'none', threadLimit: 1000 } }, republish: 'full' },
                _source: { accounts: { socialspec: '@blog.example' } },
            });
            expect(res.body._submissions.policies.posts).toBeUndefined();
            expect(res.body._submissions.policies.mentions).toBeUndefined();
            expect(res.body.items).toEqual([{
                id: guid,
                content_html: '<p>Comment c1</p>',
                date_published: status.pubDate,
                authors: [{ name: 'Bob' }],
                _source: {
                    about: expect.any(String),
                    markdown: 'Comment c1',
                    accounts: { socialspec: '@bob.example' },
                    inReplyTo: `${BLOG_JSON}#post-42`,
                    comments: { feedUrl: `${C}/comment/${guid}.json`, count: 0 },
                },
            }]);
            expect(await readPostMeta(S, POST)).toMatchObject({ external: 'post-42', externalUrl: POST_URL, archive: 0, total: 1 });

            const xml = (await request(app).get('/comments/blog/post/post-42.xml')).text;
            expect(xml).toContain(`<source:inReplyTo>${BLOG_XML}#post-42</source:inReplyTo>`);
            expect(xml).toContain(`<source:comments count="0" feedUrl="${C}/comment/${guid}.xml"/>`);
        });

        it('accepts replies to comments in both kinds of replies feeds', async () => {
            const c1 = await publishComment('c1', `${BLOG_JSON}#post-42`);
            const c2 = await publishComment('c2', `${C}/post/post-42.json#${c1}`);
            expect(c2.startsWith(c1 + '-')).toBe(true);
            const c3 = await publishComment('c3', `${C}/comment/${c1}.xml#${c2}`);
            expect(c3.startsWith(c2 + '-')).toBe(true);

            const replies = await feed(`/comments/blog/comment/${c1}.json`);
            expect(replies.items.map((i: any) => i.id)).toEqual([c2]);
            expect(replies.items[0]._source.inReplyTo).toBe(`${C}/post/post-42.json#${c1}`);
            expect((await feed(`/comments/blog/comment/${c2}.json`)).items[0]._source.inReplyTo).toBe(`${C}/comment/${c1}.json#${c2}`);
            expect((await feed('/comments/blog/post/post-42.json')).items[0]._source.comments.count).toBe(1);

            expect((await mention(`${BOB}#x`, `${C}/comment/${c1}.json#${c3}`)).body.message).toContain('does not reference');
            expect((await mention(`${BOB}#x`, `${C}/post/post-42.json`)).body.message).toContain('#guid');
            expect((await request(app).get(`/comments/blog/comment/${c1}-zzzzz.json`)).status).toBe(404);
        });

        it('treats all configured feed URLs as the same feed', async () => {
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${BLOG_JSON}#post-42`)]) };
            const { status } = await submit(`${BOB}#c1`, `${BLOG_XML}#post-42`);
            expect(status.status).toBe('success');
        });

        it('serves an empty feed before the first comment and 404 for unknown feeds', async () => {
            const res = await request(app).get('/comments/blog/post/post-42.json');
            expect(res.status).toBe(200);
            expect(res.body.items).toEqual([]);
            expect((await request(app).get('/comments/nope/post/post-42.json')).status).toBe(404);
            // foreign guids must be printable ASCII: no control characters that would break the RSS output
            expect((await request(app).get('/comments/blog/post/%01x.xml')).status).toBe(400);
            expect((await request(app).get('/comments/blog/post/p%C3%B6st.json')).status).toBe(400);
            expect((await request(app).get(`/comments/blog/post/${'x'.repeat(513)}.json`)).status).toBe(400);
            expect((await mention(`${BOB}#x`, `${BLOG_JSON}#post%01`)).body.message).toContain('printable ASCII');
            expect((await request(app).get('/groups/blog/posts.json')).status).toBe(404);
            expect((await request(app).get('/comments/blog/post/post-42.html')).status).toBe(404);
        });

        it('handles guids that are URLs', async () => {
            const id = 'https://blog.example/?p=42';
            sources[BLOG_JSON] = { status: 200, body: blogFeed([blogPost({ id })]) };
            const target = `${BLOG_JSON}#${encodeURIComponent(id)}`;
            const guid = await publishComment('c1', target);
            const path = `/comments/blog/post/${encodeURIComponent(id)}.json`;
            const res = await feed(path);
            expect(res.items.map((i: any) => i.id)).toEqual([guid]);
            expect(res.feed_url).toBe(`${C}/post/https:%2F%2Fblog.example%2F%3Fp=42.json`);
            expect(res.items[0]._source.inReplyTo).toBe(`${BLOG_JSON}#https://blog.example/?p=42`);
        });

        it('rejects unknown posts, closed posts, unreadable feeds and wrong targets', async () => {
            expect((await mention(`${BOB}#c1`, `${BLOG_XML}#nope`)).body.message).toContain('does not exist');
            expect((await mention(`${BOB}#c1`, BLOG_XML)).body.message).toContain('#guid');
            expect((await mention(`${BOB}#c1`, 'https://rm.example/groups/twowaves/posts.xml')).body.message).toContain('must be a post of');

            sources[BLOG_JSON] = { status: 200, body: blogFeed([blogPost({ _commenting: { allowComments: false } })]) };
            expect((await mention(`${BOB}#c1`, `${BLOG_XML}#post-42`)).body.message).toBe('Comments are disabled for this post');

            // The feeds are tried in order until one can be read
            sources[BLOG_XML] = { status: 500, body: '' };
            sources[BLOG_JSON] = { status: 200, body: blogFeed([blogPost()]) };
            await publishComment('c1', `${BLOG_JSON}#post-42`);
            delete sources[BLOG_JSON];
            expect((await mention(`${BOB}#c3`, `${BLOG_XML}#post-42`)).body.message).toContain('returned HTTP');
        });

        it('applies the comment rules', async () => {
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${BLOG_XML}#post-42`, { account: undefined })]) };
            expect((await submit(`${BOB}#c1`, `${BLOG_XML}#post-42`)).status).toMatchObject({ status: 'failure', code: 'socialspec-missing' });
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c2', `${BLOG_XML}#post-42`, { title: 'A title' })]) };
            const { guid, status } = await submit(`${BOB}#c2`, `${BLOG_XML}#post-42`);
            expect(status).toMatchObject({ status: 'failure', code: 'title-not-allowed' });
            expect((await readComments(S, POST, 'failed')).map(i => i.id)).toContain(guid);
        });

        it('limits the comments per post with threadLimit', async () => {
            setup({ submissionRules: { threadLimit: 1 } });
            await publishComment('c1', `${BLOG_XML}#post-42`);
            expect((await mention(`${BOB}#c2`, `${BLOG_XML}#post-42`)).body.message).toBe('The post has reached its limit of 1 comments');
        });

        it('finds posts in archive pages of the feed', async () => {
            const ARCHIVE = 'https://blog.example/archive/feed-1.json';
            sources[BLOG_JSON] = { status: 200, body: blogFeed([{ id: 'new', content_html: '<p>x</p>' }], { next_url: '/archive/feed-1.json' }) };
            sources[ARCHIVE] = { status: 200, body: blogFeed([blogPost()]) };
            await publishComment('c1', `${BLOG_JSON}#post-42`);
            sources[ARCHIVE] = { status: 200, body: blogFeed([blogPost()], { next_url: 'https://other.example/feed.json' }) };
            expect((await mention(`${BOB}#c2`, `${BLOG_JSON}#nope`)).body.message).toContain('could not be found');
        });

        it('rejects comments when comments are disabled', async () => {
            setup({ submissionRules: { comments: false } });
            expect((await mention(`${BOB}#c1`, `${BLOG_XML}#post-42`)).body.message).toBe('This feed does not accept comments');
            expect((await feed('/comments/blog/submissions.json'))._submissions.policies).toEqual({});
        });
    });

    describe('mentions', () => {
        beforeEach(() => setup({ submissionRules: { comments: false, mentions: true } }));

        it('announces mentions with republish link', async () => {
            const json = await feed('/comments/blog/submissions.json');
            expect(json._submissions).toEqual({
                about: 'https://rssmention.bigwide.net/',
                url: `${C}/mention`,
                policies: { mentions: { republish: 'link' } },
                republish: 'full',
            });
            const xml = (await request(app).get('/comments/blog/submissions.xml')).text;
            expect(xml).toContain('<rm:policies type="mentions" republish="link"/>');
            expect(xml).not.toContain('type="comments"');
        });

        it('publishes a post that links to the blog post as a link', async () => {
            const { guid, status } = await publishMention();
            expect(guid.startsWith(POST + '-')).toBe(true);
            expect(status).toEqual({ status: 'success', pubDate: expect.any(String), pubUrl: `${C}/post/post-42.json#${guid}`, kind: 'mention' });
            const res = await feed('/comments/blog/post/post-42.json');
            expect(res.items).toEqual([{
                id: guid,
                url: 'https://carol.example/2026/my-take',
                title: 'My take on the blog post',
                content_html: '<p><a href="https://carol.example/2026/my-take">My take on the blog post</a></p>',
                date_published: status.pubDate,
                authors: [{ name: 'Carol' }],
                _source: { about: expect.any(String), inReplyTo: `${BLOG_JSON}#post-42` },
                _mention: { about: 'https://rssmention.bigwide.net/', republish: 'link' },
            }]);
            expect(await readPostMeta(S, POST)).toMatchObject({ mentions: 1, total: 0 });
            const xml = (await request(app).get('/comments/blog/post/post-42.xml')).text;
            expect(xml).toContain('<rm:mention republish="link"/>');
            expect(xml).not.toContain('source:comments');
        });

        it('accepts mentions with inReplyTo or a plain-text URL, and uses the URL as title if there is none', async () => {
            const a = await publishMention({ guid: 'a', html: '<p>Nice.</p>', inReplyTo: `${BLOG_JSON}#post-42`, title: undefined, link: 'https://carol.example/a' });
            expect(a.status.status).toBe('success');
            const b = await publishMention({ guid: 'b', html: undefined, markdown: `See ${POST_URL} for details`, link: 'https://carol.example/b' });
            expect(b.status.status).toBe('success');
            const items = (await feed('/comments/blog/post/post-42.json')).items;
            expect(items.find((i: any) => i.id == a.guid).content_html).toBe('<p><a href="https://carol.example/a">https://carol.example/a</a></p>');
        });

        it('rejects mentions without link, with a foreign link or without reference', async () => {
            expect((await publishMention({ link: undefined })).status).toMatchObject({ status: 'failure', code: 'link-missing' });
            expect((await publishMention({ guid: 'x2', link: 'https://elsewhere.example/post' })).status).toMatchObject({ status: 'failure', code: 'link-mismatch' });
            const { guid, status } = await publishMention({ guid: 'x3', html: '<p>Unrelated</p>' });
            expect(status).toMatchObject({ status: 'failure', code: 'mention-missing' });
            expect((await readMentions(S, POST, 'failed')).map(i => i.id)).toContain(guid);
            expect((await feed('/comments/blog/post/post-42.json')).items).toEqual([]);
        });

        it('does not accept replies to comments', async () => {
            const res = await mention(`${CAROL}#cp1`, `${C}/post/post-42.json#${POST}-aaaaa`);
            expect(res.status).toBe(400);
            expect(res.body.message).toBe('The target comment does not exist');
        });

        it('updates mentions and deletes them when the link or the item is gone', async () => {
            const { guid, status } = await publishMention();
            const edited = await publishMention({ title: 'New title' });
            expect(edited.guid).toBe(guid);
            const items = (await feed('/comments/blog/post/post-42.json')).items;
            expect(items).toHaveLength(1);
            expect(items[0]).toMatchObject({ title: 'New title', date_published: status.pubDate, date_modified: expect.any(String) });

            expect((await publishMention({ html: '<p>No longer linked</p>' })).status).toEqual({ status: 'deleted' });
            expect((await feed('/comments/blog/post/post-42.json')).items).toEqual([]);
            expect(await readPostMeta(S, POST)).toMatchObject({ mentions: 0 });

            await publishMention({ guid: 'cp2' });
            sources[CAROL] = { status: 410, body: '' };
            expect((await submit(`${CAROL}#cp2`, `${BLOG_XML}#post-42`)).status).toEqual({ status: 'deleted' });
        });

        it('moderates mentions; admins can approve and delete them', async () => {
            moderationAnswer = { ok: false, code: 'moderation-rejected', text: 'Spam.' };
            const { guid, status } = await publishMention();
            expect(status).toMatchObject({ status: 'failure', code: 'moderation-rejected' });
            const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
            const post = await request(app).get('/comments/blog/admin/posts/post-42').set(auth);
            expect(post.body.failedMentions.map((i: any) => i.id)).toEqual([guid]);

            const approved = await request(app).post(`/comments/blog/admin/items/${guid}/approve`).set(auth);
            expect(approved.body).toMatchObject({ status: 'success', pubUrl: `${C}/post/post-42.json#${guid}` });
            expect((await feed('/comments/blog/post/post-42.json')).items).toHaveLength(1);
            expect((await request(app).put(`/comments/blog/admin/items/${guid}`).set(auth).send({ text: 'x' })).status).toBe(400);

            const deleted = await request(app).delete(`/comments/blog/admin/items/${guid}`).set(auth);
            expect(deleted.body).toEqual({ guid, deleted: 1 });
            expect((await feed('/comments/blog/post/post-42.json')).items).toEqual([]);
        });

        it('lets admins close a post for mentions by its own guid', async () => {
            await publishMention();
            const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };
            const res = await request(app).put('/comments/blog/admin/posts/post-42/commenting').set(auth).send({ allowComments: false });
            expect(res.body).toEqual({ guid: 'post-42', allowComments: false });
            expect((await mention(`${CAROL}#cp2`, `${BLOG_XML}#post-42`)).body.message).toBe('Comments and mentions are disabled for this post');
        });
    });

    describe('comments and mentions', () => {
        beforeEach(() => setup({ submissionRules: { mentions: true } }));

        it('announces both policies', async () => {
            const json = await feed('/comments/blog/submissions.json');
            expect(json._submissions.policies).toEqual({ comments: expect.objectContaining({ requireSocialSpec: true }), mentions: { republish: 'link' } });
        });

        it('publishes comments as comments and other replies as mentions, and filters them', async () => {
            const comment = await publishComment('c1', `${BLOG_XML}#post-42`);
            // A blog post with inReplyTo, but a title and no socialspec: not a valid comment, but a mention
            const m = await publishMention({ inReplyTo: `${BLOG_XML}#post-42` });
            expect(m.status).toMatchObject({ status: 'success', kind: 'mention' });

            const all = await feed('/comments/blog/post/post-42.json');
            expect(all.items.map((i: any) => i.id)).toEqual([comment, m.guid]);
            const comments = await feed('/comments/blog/post/post-42.json?show=comments');
            expect(comments.items.map((i: any) => i.id)).toEqual([comment]);
            expect(comments.feed_url).toBe(`${C}/post/post-42.json?show=comments`);
            const mentionsXml = (await request(app).get('/comments/blog/post/post-42.xml?show=mentions')).text;
            expect(mentionsXml).toContain(`<atom:link rel="self" href="${C}/post/post-42.xml?show=mentions"`);
            expect(mentionsXml).not.toContain(`<guid isPermaLink="false">${comment}</guid>`);
            const mentionsJson = await feed('/comments/blog/post/post-42.json?show=mentions');
            expect(mentionsJson.items.map((i: any) => i.id)).toEqual([m.guid]);
            expect(mentionsJson.title).toBe('The Blog: mentions of a post');
            expect((await request(app).get('/comments/blog/post/post-42.json?show=likes')).status).toBe(400);
            expect(await readPostMeta(S, POST)).toMatchObject({ total: 1, mentions: 1 });

            // Replies to mentions are not possible
            expect((await mention(`${BOB}#c9`, `${C}/post/post-42.json#${m.guid}`)).body.message).toBe('The target comment does not exist');
        });

        it('reports the comment failure for items with inReplyTo that are neither', async () => {
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${BLOG_XML}#post-42`, { title: 'Title' })]) };
            expect((await submit(`${BOB}#c1`, `${BLOG_XML}#post-42`)).status).toMatchObject({ status: 'failure', code: 'title-not-allowed' });
            expect((await publishMention({ guid: 'x', html: '<p>Unrelated</p>' })).status).toMatchObject({ status: 'failure', code: 'mention-missing' });
        });

        it('keeps the kind of a comment when it is edited', async () => {
            setup({ submissionRules: { mentions: true, comments: { allowEdit: true } } });
            const guid = await publishComment('c1', `${BLOG_XML}#post-42`);
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${BLOG_XML}#post-42`, { title: 'Now with title', link: 'https://bob.example/c1' })]) };
            const res = await submit(`${BOB}#c1`, `${BLOG_XML}#post-42`);
            expect(res.guid).toBe(guid);
            expect(res.status).toMatchObject({ status: 'failure', code: 'title-not-allowed' });
        });

        it('accepts mentions when the comment limit of the post is reached', async () => {
            setup({ submissionRules: { mentions: true, threadLimit: 1 } });
            await publishComment('c1', `${BLOG_XML}#post-42`);
            expect((await publishMention()).status).toMatchObject({ status: 'success', kind: 'mention' });
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c2', `${BLOG_XML}#post-42`)]) };
            expect((await submit(`${BOB}#c2`, `${BLOG_XML}#post-42`)).status).toMatchObject({ status: 'failure', code: 'comment-limit' });
        });
    });

    describe('source pagination', () => {
        it('finds the submitted item on a later page of the source feed', async () => {
            const PAGE2 = 'https://bob.example/feed-2.json';
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('other', `${BLOG_XML}#post-42`)], undefined, { next_url: PAGE2 }) };
            sources[PAGE2] = { status: 200, body: jsonFeed([bobComment('c1', `${BLOG_XML}#post-42`)]) };
            expect((await submit(`${BOB}#c1`, `${BLOG_XML}#post-42`)).status).toMatchObject({ status: 'success' });
        });

        it('does not delete when it gives up before the end of the chain', async () => {
            setup({ submissionRules: { comments: { allowDelete: true } } });
            const guid = await publishComment('c1', `${BLOG_XML}#post-42`);
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('other', `${BLOG_XML}#post-42`)], undefined, { next_url: 'https://bob.example/missing.json' }) };
            expect((await submit(`${BOB}#c1`, `${BLOG_XML}#post-42`)).status).toMatchObject({ status: 'failure', code: 'item-not-found' });
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('other', `${BLOG_XML}#post-42`)]) };
            const res = await submit(`${BOB}#c1`, `${BLOG_XML}#post-42`);
            expect(res.guid).toBe(guid);
            expect(res.status).toEqual({ status: 'deleted' });
        });
    });
});
