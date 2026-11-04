process.env.LIMITS_MAX_PER_IP_PER_MINUTE = '100000';

import request from 'supertest';
import { XMLParser } from 'fast-xml-parser';
import { createApp } from '../controller';
import { processorDeps } from '../lib/processor';
import { whenIdle } from '../lib/queue';
import { time } from '../lib/server-common';
import { clearStatuses } from '../lib/status';
import { appendToLog, readComments, readLog, readPostMeta, StoredItem, writePostMeta } from '../lib/storage';
import { ADMIN_TOKEN, FeedItemSpec, jsonFeed, rssFeed, testConfig } from './helpers';

const G = 'https://rm.example/groups/twowaves';
const ALICE = 'https://alice.example/feed.xml';
const BOB = 'https://bob.example/feed.json';

describe('rssmention API', () => {
    let cleanup: () => void;
    let app: ReturnType<typeof createApp>;
    let sources: Record<string, { status: number, body: string }>;
    let moderationAnswer: { ok: true } | { ok: false, code: 'moderation-rejected' | 'moderation-unavailable', text: string };
    const originalDeps = { ...processorDeps };
    const originalNow = time.now;

    function setup(groupOverrides: any = {}) {
        cleanup?.();
        ({ cleanup } = testConfig(groupOverrides));
        app = createApp({ happyServer: false });
    }

    beforeEach(() => {
        setup();
        sources = {};
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
        time.now = originalNow;
        clearStatuses();
        cleanup();
        cleanup = undefined as any;
    });

    const alicePost = (overrides: Partial<FeedItemSpec> = {}): FeedItemSpec => ({
        guid: 'p1', title: 'Hello group', markdown: 'My **first** post', inReplyTo: `${G}/posts.xml`, account: '@alice.example', author: 'Alice', ...overrides,
    });
    const bobComment = (guid: string, inReplyTo: string, overrides: Partial<FeedItemSpec> = {}): FeedItemSpec => ({
        guid, markdown: `Comment ${guid}`, inReplyTo, account: '@bob.example', author: 'Bob', ...overrides,
    });

    const mention = (source: string, target: string) =>
        request(app).post('/groups/twowaves/mention').type('form').send({ source, target });

    async function submit(source: string, target: string) {
        const res = await mention(source, target);
        expect(res.status).toBe(201);
        await whenIdle();
        const status = await request(app).get(`/groups/twowaves/status/${res.body.guid}`);
        return { guid: res.body.guid as string, status: status.body };
    }

    async function publishPost(item: Partial<FeedItemSpec> = {}): Promise<string> {
        sources[ALICE] = { status: 200, body: rssFeed([alicePost(item)]) };
        const { guid, status } = await submit(item.guid ? `${ALICE}#${item.guid}` : ALICE, `${G}/posts.xml`);
        expect(status.status).toBe('success');
        return guid;
    }

    async function publishComment(guid: string, target: string): Promise<string> {
        sources[BOB] = { status: 200, body: jsonFeed([bobComment(guid, target)]) };
        const res = await submit(`${BOB}#${guid}`, target);
        expect(res.status).toMatchObject({ status: 'success' });
        return res.guid;
    }

    const feed = async (path: string) => (await request(app).get(path)).body;

    describe('posting to a group', () => {
        it('accepts a post, returns a status page and publishes it', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost()]) };
            const res = await mention(ALICE, `${G}/posts.xml`);
            expect(res.status).toBe(201);
            const guid = res.body.guid;
            expect(guid).toMatch(/^[0-9A-Za-z]{10}$/);
            expect(res.headers.location).toBe(`${G}/status/${guid}`);
            expect((await request(app).get(`/groups/twowaves/status/${guid}`)).body).toEqual({ status: 'waiting' });

            await whenIdle();
            const status = (await request(app).get(`/groups/twowaves/status/${guid}`)).body;
            expect(status).toEqual({ status: 'success', pubDate: expect.any(String), pubUrl: `${G}/posts.json#${guid}` });

            const posts = await feed('/groups/twowaves/posts.json');
            expect(posts).toMatchObject({
                version: 'https://jsonfeed.org/version/1.1',
                title: 'Two Waves RSS Discussion',
                description: 'Discussions about RSS',
                feed_url: `${G}/posts.json`,
                _submissions: {
                    about: 'https://rssmention.bigwide.net/',
                    url: `${G}/mention`,
                    tos: 'https://twowaves.example/tos.html',
                    policies: { posts: { maxLength: 8000, title: 'required', commentLimit: 1000 }, comments: { title: 'none', commentLimit: 20, maxDepth: 5 } },
                    republish: true,
                },
                _source: { accounts: { socialspec: '@twowaves.example' } },
            });
            expect(posts.items).toEqual([{
                id: guid,
                title: 'Hello group',
                content_html: '<p>My <strong>first</strong> post</p>',
                date_published: status.pubDate,
                authors: [{ name: 'Alice' }],
                _source: {
                    about: expect.any(String),
                    markdown: 'My **first** post',
                    accounts: { socialspec: '@alice.example' },
                    comments: { feedUrl: `${G}/comments/${guid}/comments.json`, count: 0, total: 0 },
                },
                _commenting: { about: 'https://rssmention.bigwide.net/', allowComments: true },
            }]);
            expect(await readLog('twowaves', 'submissions')).toHaveLength(1);
            expect(await readLog('twowaves', 'published')).toHaveLength(1);
            expect(await readLog('twowaves', 'failed')).toHaveLength(0);
        });

        it('serves the same content as RSS', async () => {
            const guid = await publishPost();
            const res = await request(app).get('/groups/twowaves/posts.xml');
            expect(res.headers['content-type']).toContain('application/rss+xml');
            expect(res.headers.link).toBe(`<${G}/mention>; rel="webmention"`);
            const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }).parse(res.text);
            const channel = doc.rss.channel;
            expect(channel['rm:submissions']['rm:url']).toBe(`${G}/mention`);
            expect(channel['rm:submissions']['rm:policies'].map((p: any) => p['@_type'])).toEqual(['posts', 'comments']);
            expect(channel['rm:submissions']['rm:policies'][0]['@_maxLength']).toBe('8000');
            expect(channel['rm:submissions']['rm:republish']).toBe('true');
            expect(channel['source:account']['#text']).toBe('@twowaves.example');
            expect(channel.item.guid['#text']).toBe(guid);
            expect(channel.item.title).toBe('Hello group');
            expect(channel.item.description).toBe('<p>My <strong>first</strong> post</p>');
            expect(channel.item['source:markdown']).toBe('My **first** post');
            expect(channel.item['source:comments']).toMatchObject({ '@_count': '0', '@_feedUrl': `${G}/comments/${guid}/comments.xml` });
            expect(channel.item['rm:commenting']['rm:allowComments']).toBe('true');
        });

        it('accepts JSON Feed sources and the JSON group feed as target', async () => {
            sources[BOB] = { status: 200, body: jsonFeed([{ ...alicePost(), account: '@bob.example', inReplyTo: `${G}/posts.json` }]) };
            const { status } = await submit(BOB, `${G}/posts.json`);
            expect(status.status).toBe('success');
        });

        it('honors allowComments=false on the submitted item', async () => {
            sources[BOB] = { status: 200, body: JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', items: [{ id: 'x', title: 'T', content_html: '<p>x</p>', _commenting: { allowComments: false }, _source: { inReplyTo: `${G}/posts.json`, accounts: { socialspec: '@bob.example' } } }] }) };
            const { guid } = await submit(BOB, `${G}/posts.json`);
            expect((await readPostMeta('twowaves', guid))?.allowComments).toBe(false);
            expect((await mention(`${ALICE}#c`, `${G}/posts.json#${guid}`)).body.message).toBe('Comments are disabled for this post');
        });

        it('writes rule failures to group-failed only', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ title: undefined })]) };
            const { guid, status } = await submit(ALICE, `${G}/posts.xml`);
            expect(status).toEqual({ status: 'failure', code: 'title-required', text: 'Posts require a title' });
            const failed = await readLog('twowaves', 'failed');
            expect(failed[0]).toMatchObject({ id: guid, _rssmention: { failure: { code: 'title-required' } } });
            expect(await readLog('twowaves', 'submissions')).toHaveLength(0);
            expect(await readLog('twowaves', 'published')).toHaveLength(0);
        });

        it('writes moderation failures to group-submissions and group-failed', async () => {
            moderationAnswer = { ok: false, code: 'moderation-rejected', text: 'Looks like spam.' };
            sources[ALICE] = { status: 200, body: rssFeed([alicePost()]) };
            const { guid, status } = await submit(ALICE, `${G}/posts.xml`);
            expect(status).toEqual({ status: 'failure', code: 'moderation-rejected', text: 'Looks like spam.' });
            expect((await readLog('twowaves', 'submissions'))[0].id).toBe(guid);
            expect((await readLog('twowaves', 'failed'))[0]._rssmention.failure).toEqual({ code: 'moderation-rejected', text: 'Looks like spam.' });
            expect(await readLog('twowaves', 'published')).toHaveLength(0);
        });

        it('passes title and markdown to moderation', async () => {
            let moderated = '';
            processorDeps.moderate = async (_g, text) => { moderated = text; return { ok: true }; };
            await publishPost();
            expect(moderated).toBe('Hello group\n\nMy **first** post');
        });

        it('requires a socialspec account on the host of the source', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ account: '@mallory.example' })]) };
            expect((await submit(ALICE, `${G}/posts.xml`)).status.code).toBe('socialspec-mismatch');
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ account: undefined })]) };
            expect((await submit(ALICE, `${G}/posts.xml`)).status.code).toBe('socialspec-missing');
        });

        it('does not republish unverified accounts when not required', async () => {
            setup({ submissionRules: { general: { requireSocialSpec: false } } });
            await publishPost({ account: '@mallory.example' });
            const posts = await feed('/groups/twowaves/posts.json');
            expect(posts.items[0]._source.accounts).toBeUndefined();
        });

        it('requires inReplyTo to match the target', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ inReplyTo: 'https://elsewhere.example/feed' })]) };
            expect((await submit(ALICE, `${G}/posts.xml`)).status.code).toBe('in-reply-to-mismatch');
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ inReplyTo: undefined })]) };
            expect((await submit(ALICE, `${G}/posts.xml`)).status.code).toBe('in-reply-to-missing');
        });

        it('validates the content', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ markdown: undefined, html: '<p><span>x</span></p>' })]) };
            expect((await submit(ALICE, `${G}/posts.xml`)).status).toEqual({ status: 'failure', code: 'forbidden-element', text: 'The element <span> is not allowed' });
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ markdown: 'x'.repeat(8001) })]) };
            expect((await submit(ALICE, `${G}/posts.xml`)).status).toEqual({ status: 'failure', code: 'too-long', text: 'Post limit of 8000 characters exceeded: 8001 characters in post' });
        });

        it('needs a fragment for multi-item sources', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost(), alicePost({ guid: 'p2', title: 'Second' })]) };
            expect((await submit(ALICE, `${G}/posts.xml`)).status.code).toBe('ambiguous-source');
            const { status } = await submit(`${ALICE}#p2`, `${G}/posts.xml`);
            expect(status.status).toBe('success');
            expect((await feed('/groups/twowaves/posts.json')).items[0].title).toBe('Second');
        });

        it('reports missing items and fetch errors', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost()]) };
            expect((await submit(`${ALICE}#nope`, `${G}/posts.xml`)).status.code).toBe('item-not-found');
            expect((await submit('https://nothing.example/feed', `${G}/posts.xml`)).status).toEqual({ status: 'failure', code: 'fetch-failed', text: 'The source returned HTTP 404' });
            sources[ALICE] = { status: 200, body: 'garbage' };
            expect((await submit(ALICE, `${G}/posts.xml`)).status.code).toBe('invalid-feed');
        });

        it('keeps recent pubDates and replaces old ones', async () => {
            const now = new Date('2026-11-04T12:00:00.000Z');
            time.now = () => now;
            const recent = new Date(now.getTime() - 20 * 60 * 1000);
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ pubDate: recent })]) };
            expect((await submit(ALICE, `${G}/posts.xml`)).status.pubDate).toBe(recent.toISOString());
            sources[BOB] = { status: 200, body: jsonFeed([{ ...alicePost(), account: '@bob.example', pubDate: new Date(now.getTime() - 3600_000) }]) };
            expect((await submit(BOB, `${G}/posts.xml`)).status.pubDate).toBe(now.toISOString());
        });
    });

    describe('synchronous validation', () => {
        it('requires source and target', async () => {
            expect((await request(app).post('/groups/twowaves/mention').type('form').send({ source: ALICE })).status).toBe(400);
            expect((await request(app).post('/groups/twowaves/mention').send({ target: `${G}/posts.xml` })).status).toBe(400);
        });

        it('accepts JSON bodies', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost()]) };
            expect((await request(app).post('/groups/twowaves/mention').send({ source: ALICE, target: `${G}/posts.xml` })).status).toBe(201);
        });

        it('rejects bad sources', async () => {
            expect((await mention('https://10.0.0.1/feed', `${G}/posts.xml`)).body.message).toContain('IP address');
            expect((await mention('file:///etc/passwd', `${G}/posts.xml`)).status).toBe(400);
            expect((await mention('https://rm.example/groups/twowaves/posts.xml', `${G}/posts.xml`)).body.message).toContain('this server');
        });

        it('rejects bad targets', async () => {
            expect((await mention(ALICE, 'https://elsewhere.example/posts.xml')).status).toBe(400);
            expect((await mention(ALICE, `${G}/posts.xml#AAAAAAAAAA`)).body.message).toBe('The target post does not exist');
            expect((await mention(ALICE, `${G}/comments/AAAAAAAAAA/comments.json#AAAAAAAAAA-aaaaa`)).body.message).toBe('The target comment does not exist');
        });

        it('returns 404 for unknown groups', async () => {
            expect((await request(app).post('/groups/nope/mention').type('form').send({ source: ALICE, target: `${G}/posts.xml` })).status).toBe(404);
            expect((await request(app).get('/groups/nope/posts.json')).status).toBe(404);
            expect((await request(app).get('/groups/constructor/posts.json')).status).toBe(404);
        });

        it('rejects a source that is being processed or already published', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost()]) };
            expect((await mention(ALICE, `${G}/posts.xml`)).status).toBe(201);
            expect((await mention(ALICE, `${G}/posts.xml`)).body.message).toBe('This source is already being processed');
            await whenIdle();
            expect((await mention(ALICE, `${G}/posts.xml`)).body.message).toBe('This source has already been submitted');
        });

        it('returns 404 for unknown status pages', async () => {
            expect((await request(app).get('/groups/twowaves/status/AAAAAAAAAA')).status).toBe(404);
        });
    });

    describe('comments', () => {
        it('publishes comments to posts and counts them', async () => {
            const post = await publishPost();
            // inReplyTo uses the .xml variant, the target the .json one: equivalent
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${G}/posts.xml#${post}`)]) };
            const res = await mention(`${BOB}#c1`, `${G}/posts.json#${post}`);
            expect(res.status).toBe(201);
            const guid = res.body.guid;
            expect(guid).toMatch(new RegExp(`^${post}-[0-9a-z]{5}$`));
            await whenIdle();
            expect((await request(app).get(`/groups/twowaves/status/${guid}`)).body).toMatchObject({ status: 'success', pubUrl: `${G}/comments/${post}/comments.json#${guid}` });

            const comments = await feed(`/groups/twowaves/comments/${post}/comments.json`);
            expect(comments._submissions.url).toBe(`${G}/mention`);
            expect(comments.title).toBe('Two Waves RSS Discussion: replies to "Hello group"');
            expect(comments.items).toEqual([{
                id: guid,
                content_html: '<p>Comment c1</p>',
                date_published: expect.any(String),
                authors: [{ name: 'Bob' }],
                _source: {
                    about: expect.any(String),
                    markdown: 'Comment c1',
                    accounts: { socialspec: '@bob.example' },
                    inReplyTo: `${G}/posts.json#${post}`,
                    comments: { feedUrl: `${G}/comments/${post}/${guid}/comments.json`, count: 0 },
                },
            }]);
            const posts = await feed('/groups/twowaves/posts.json');
            expect(posts.items[0]._source.comments).toMatchObject({ count: 1, total: 1 });
            // comments are not written to the group logs
            expect(await readLog('twowaves', 'submissions')).toHaveLength(1);
        });

        it('publishes replies to comments', async () => {
            const post = await publishPost();
            const c1 = await publishComment('c1', `${G}/posts.json#${post}`);
            const r1 = await publishComment('r1', `${G}/comments/${post}/comments.json#${c1}`);
            expect(r1).toMatch(new RegExp(`^${c1}-[0-9a-z]{5}$`));

            const replies = await feed(`/groups/twowaves/comments/${post}/${c1}/comments.json`);
            expect(replies.items.map((i: any) => i.id)).toEqual([r1]);
            expect(replies.items[0]._source.inReplyTo).toBe(`${G}/comments/${post}/comments.json#${c1}`);
            const comments = await feed(`/groups/twowaves/comments/${post}/comments.json`);
            expect(comments.items[0]._source.comments.count).toBe(1);
            expect((await feed('/groups/twowaves/posts.json')).items[0]._source.comments).toMatchObject({ count: 1, total: 2 });

            const xml = await request(app).get(`/groups/twowaves/comments/${post}/${c1}/comments.xml`);
            expect(xml.text).toContain(`<source:inReplyTo>${G}/comments/${post}/comments.xml#${c1}</source:inReplyTo>`);
        });

        it('applies the comment rules', async () => {
            const post = await publishPost();
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${G}/posts.json#${post}`, { title: 'Not allowed' })]) };
            const { guid, status } = await submit(`${BOB}#c1`, `${G}/posts.json#${post}`);
            expect(status.code).toBe('title-not-allowed');
            expect((await readComments('twowaves', post, 'failed'))[0]).toMatchObject({ id: guid, _rssmention: { failure: { code: 'title-not-allowed' } } });
            expect(await readLog('twowaves', 'failed')).toHaveLength(0);
        });

        it('writes failed moderation of comments to the comments-failed file', async () => {
            const post = await publishPost();
            moderationAnswer = { ok: false, code: 'moderation-rejected', text: 'Rude.' };
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${G}/posts.json#${post}`)]) };
            const { guid } = await submit(`${BOB}#c1`, `${G}/posts.json#${post}`);
            expect((await readComments('twowaves', post, 'failed'))[0]).toMatchObject({ id: guid, _rssmention: { failure: { code: 'moderation-rejected', text: 'Rude.' } } });
            expect((await feed('/groups/twowaves/posts.json')).items[0]._source.comments.count).toBe(0);
        });

        it('enforces maxDepth', async () => {
            setup({ submissionRules: { comments: { maxDepth: 2 } } });
            const post = await publishPost();
            const c1 = await publishComment('c1', `${G}/posts.json#${post}`);
            const r1 = await publishComment('r1', `${G}/comments/${post}/comments.json#${c1}`);
            const res = await mention(`${BOB}#x`, `${G}/comments/${post}/${c1}/comments.json#${r1}`);
            expect(res.status).toBe(400);
            expect(res.body.message).toBe('Comments can be nested at most 2 levels deep');
        });

        it('enforces the comment limits', async () => {
            setup({ submissionRules: { posts: { commentLimit: 3 }, comments: { commentLimit: 1 } } });
            const post = await publishPost();
            const c1 = await publishComment('c1', `${G}/posts.json#${post}`);
            await publishComment('r1', `${G}/comments/${post}/comments.json#${c1}`);
            expect((await mention(`${BOB}#r2`, `${G}/comments/${post}/comments.json#${c1}`)).body.message).toBe('The comment has reached its limit of 1 replies');
            await publishComment('c2', `${G}/posts.json#${post}`);
            expect((await mention(`${BOB}#c3`, `${G}/posts.json#${post}`)).body.message).toBe('The post has reached its limit of 3 comments');
        });

        it('re-checks limits when publishing', async () => {
            setup({ submissionRules: { comments: { commentLimit: 1 } } });
            const post = await publishPost();
            const c1 = await publishComment('c1', `${G}/posts.json#${post}`);
            const target = `${G}/comments/${post}/comments.json#${c1}`;
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('r1', target), bobComment('r2', target)]) };
            const a = await mention(`${BOB}#r1`, target);
            const b = await mention(`${BOB}#r2`, target);
            expect([a.status, b.status]).toEqual([201, 201]);
            await whenIdle();
            expect((await request(app).get(`/groups/twowaves/status/${b.body.guid}`)).body.code).toBe('comment-limit');
        });

        it('returns 404 for comment feeds of unknown posts', async () => {
            expect((await request(app).get('/groups/twowaves/comments/AAAAAAAAAA/comments.json')).status).toBe(404);
            expect((await request(app).get('/groups/twowaves/comments/bad/comments.json')).status).toBe(400);
        });
    });

    describe('edits and deletes', () => {
        it('updates a post when re-sent and allowEdit is set', async () => {
            setup({ submissionRules: { general: { allowEdit: true } } });
            const guid = await publishPost();
            const before = (await feed('/groups/twowaves/posts.json')).items[0];
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ markdown: 'Edited' })]) };
            const res = await submit(ALICE, `${G}/posts.xml`);
            expect(res.guid).toBe(guid);
            expect(res.status).toMatchObject({ status: 'success', pubDate: before.date_published });
            const after = await feed('/groups/twowaves/posts.json');
            expect(after.items).toHaveLength(1);
            expect(after.items[0]).toMatchObject({ id: guid, content_html: '<p>Edited</p>', date_published: before.date_published, date_modified: expect.any(String) });
        });

        it('updates comments and keeps the old version when the edit fails', async () => {
            setup({ submissionRules: { general: { allowEdit: true } } });
            const post = await publishPost();
            const c1 = await publishComment('c1', `${G}/posts.json#${post}`);
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${G}/posts.json#${post}`, { markdown: 'Better' })]) };
            expect((await submit(`${BOB}#c1`, `${G}/posts.json#${post}`)).guid).toBe(c1);
            expect((await feed(`/groups/twowaves/comments/${post}/comments.json`)).items[0].content_html).toBe('<p>Better</p>');

            sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${G}/posts.json#${post}`, { markdown: '# Headline' })]) };
            expect((await submit(`${BOB}#c1`, `${G}/posts.json#${post}`)).status.code).toBe('forbidden-element');
            expect((await feed(`/groups/twowaves/comments/${post}/comments.json`)).items[0].content_html).toBe('<p>Better</p>');
            expect((await readPostMeta('twowaves', post))?.total).toBe(1);
        });

        it('rejects edits that change the target', async () => {
            setup({ submissionRules: { general: { allowEdit: true } } });
            const post = await publishPost();
            await publishComment('c1', `${G}/posts.json#${post}`);
            const other = await publishPost({ guid: 'p2' });
            expect((await mention(`${BOB}#c1`, `${G}/posts.json#${other}`)).body.message).toBe('An edited submission must keep its target');
        });

        it('rejects edits when only deletes are allowed', async () => {
            setup({ submissionRules: { general: { allowDelete: true } } });
            await publishPost();
            expect((await submit(ALICE, `${G}/posts.xml`)).status.code).toBe('edit-not-allowed');
        });

        it('deletes a post when the source is gone and allowDelete is set', async () => {
            setup({ submissionRules: { general: { allowDelete: true } } });
            const post = await publishPost();
            await publishComment('c1', `${G}/posts.json#${post}`);
            sources[ALICE] = { status: 410, body: '' };
            const res = await submit(ALICE, `${G}/posts.xml`);
            expect(res).toEqual({ guid: post, status: { status: 'deleted' } });
            expect((await feed('/groups/twowaves/posts.json')).items).toEqual([]);
            expect(await readPostMeta('twowaves', post)).toBeUndefined();
        });

        it('deletes a comment that disappeared from its feed', async () => {
            setup({ submissionRules: { general: { allowDelete: true } } });
            const post = await publishPost();
            const c1 = await publishComment('c1', `${G}/posts.json#${post}`);
            await publishComment('r1', `${G}/comments/${post}/comments.json#${c1}`);
            sources[BOB] = { status: 200, body: jsonFeed([bobComment('other', `${G}/posts.json#${post}`)]) };
            expect((await submit(`${BOB}#c1`, `${G}/posts.json#${post}`)).status).toEqual({ status: 'deleted' });
            expect((await feed(`/groups/twowaves/comments/${post}/comments.json`)).items).toEqual([]);
            expect((await feed('/groups/twowaves/posts.json')).items[0]._source.comments).toMatchObject({ count: 0, total: 0 });
        });

        it('does not delete without allowDelete', async () => {
            setup({ submissionRules: { general: { allowEdit: true } } });
            await publishPost();
            sources[ALICE] = { status: 410, body: '' };
            expect((await submit(ALICE, `${G}/posts.xml`)).status.code).toBe('fetch-failed');
            expect((await feed('/groups/twowaves/posts.json')).items).toHaveLength(1);
        });
    });

    describe('archives', () => {
        it('links and serves archives', async () => {
            for (let i = 0; i < 51; i++) {
                const id = `P${String(i).padStart(9, '0')}`;
                const item: StoredItem = { id, content_html: `<p>${i}</p>`, date_published: '2026-11-01T00:00:00.000Z', _rssmention: { kind: 'post', source: 's', target: 't', submittedAt: '' } };
                const archive = await appendToLog('twowaves', 'published', item);
                await writePostMeta('twowaves', { guid: id, archive, allowComments: true, counts: {}, total: 0 });
            }
            const posts = await feed('/groups/twowaves/posts.json');
            expect(posts.items).toHaveLength(50);
            expect(posts.next_url).toBe(`${G}/archive/posts-1.json`);
            const archive = await feed('/groups/twowaves/archive/posts-1.json');
            expect(archive.items).toHaveLength(50);
            expect(archive._submissions).toBeDefined();
            const xml = await request(app).get('/groups/twowaves/archive/posts-1.xml');
            expect(xml.text).toContain('<fh:archive/>');
            expect((await request(app).get('/groups/twowaves/archive/posts-9.json')).status).toBe(404);
            // comments on archived posts are possible
            expect((await mention(`${BOB}#c`, `${G}/archive/posts-1.json#P000000000`)).status).toBe(201);
        });
    });

    describe('admin', () => {
        const auth = { Authorization: `Bearer ${ADMIN_TOKEN}` };

        it('requires the admin token', async () => {
            expect((await request(app).get('/groups/twowaves/admin/published')).status).toBe(401);
            expect((await request(app).get('/groups/twowaves/admin/published').set({ Authorization: 'Bearer wrong' })).status).toBe(401);
            expect((await request(app).get('/groups/twowaves/admin/published').set(auth)).status).toBe(200);
        });

        it('lists the logs including internal data', async () => {
            const guid = await publishPost();
            const res = await request(app).get('/groups/twowaves/admin/submissions').set(auth);
            expect(res.body).toMatchObject({ archives: [1], items: [{ id: guid, _rssmention: { kind: 'post', source: ALICE } }] });
            expect((await request(app).get('/groups/twowaves/admin/published?archive=1').set(auth)).body.items).toHaveLength(1);
            expect((await request(app).get('/groups/twowaves/admin/whatever').set(auth)).status).toBe(404);
        });

        it('gets an item with its metadata', async () => {
            const guid = await publishPost();
            const res = await request(app).get(`/groups/twowaves/admin/items/${guid}`).set(auth);
            expect(res.body).toMatchObject({ item: { id: guid }, post: { guid, allowComments: true, total: 0 }, failedReplies: [] });
            expect((await request(app).get('/groups/twowaves/admin/items/AAAAAAAAAA').set(auth)).status).toBe(404);
            expect((await request(app).get('/groups/twowaves/admin/items/..%2F..').set(auth)).status).toBe(400);
        });

        it('disables and enables commenting', async () => {
            const post = await publishPost();
            const put = (allowComments: any) => request(app).put(`/groups/twowaves/admin/posts/${post}/commenting`).set(auth).send({ allowComments });
            expect((await put(false)).body).toEqual({ guid: post, allowComments: false });
            expect((await feed('/groups/twowaves/posts.json')).items[0]._commenting.allowComments).toBe(false);
            expect((await mention(`${BOB}#c1`, `${G}/posts.json#${post}`)).body.message).toBe('Comments are disabled for this post');
            expect((await put('no')).status).toBe(400);
            await put(true);
            await publishComment('c1', `${G}/posts.json#${post}`);
        });

        it('replaces a comment', async () => {
            const post = await publishPost();
            const c1 = await publishComment('c1', `${G}/posts.json#${post}`);
            const res = await request(app).put(`/groups/twowaves/admin/items/${c1}`).set(auth).send({ title: 'Removed', text: 'Removed by <admin>' });
            expect(res.status).toBe(200);
            const item = (await feed(`/groups/twowaves/comments/${post}/comments.json`)).items[0];
            expect(item).toMatchObject({ id: c1, title: 'Removed', content_html: '<p>Removed by &lt;admin&gt;</p>', authors: [{ name: 'Admin' }] });
            expect(item._source.markdown).toBeUndefined();
            expect(item._source.accounts).toBeUndefined();
        });

        it('replaces a post', async () => {
            const post = await publishPost();
            await request(app).put(`/groups/twowaves/admin/items/${post}`).set(auth).send({ text: 'Gone' }).expect(200);
            const item = (await feed('/groups/twowaves/posts.json')).items[0];
            expect(item).toMatchObject({ content_html: '<p>Gone</p>', authors: [{ name: 'Admin' }] });
            expect(item.title).toBeUndefined();
            expect((await request(app).put(`/groups/twowaves/admin/items/${post}`).set(auth).send({})).status).toBe(400);
        });

        it('deletes a comment with all replies', async () => {
            const post = await publishPost();
            const c1 = await publishComment('c1', `${G}/posts.json#${post}`);
            await publishComment('r1', `${G}/comments/${post}/comments.json#${c1}`);
            const c2 = await publishComment('c2', `${G}/posts.json#${post}`);
            const res = await request(app).delete(`/groups/twowaves/admin/items/${c1}`).set(auth);
            expect(res.body).toEqual({ guid: c1, deleted: 2 });
            expect((await feed(`/groups/twowaves/comments/${post}/comments.json`)).items.map((i: any) => i.id)).toEqual([c2]);
            expect((await request(app).get(`/groups/twowaves/comments/${post}/${c1}/comments.json`)).status).toBe(404);
            expect((await feed('/groups/twowaves/posts.json')).items[0]._source.comments).toMatchObject({ count: 1, total: 1 });
            expect((await request(app).delete(`/groups/twowaves/admin/items/${c1}`).set(auth)).status).toBe(404);
        });

        it('deletes a post with all comments', async () => {
            const post = await publishPost();
            await publishComment('c1', `${G}/posts.json#${post}`);
            expect((await request(app).delete(`/groups/twowaves/admin/items/${post}`).set(auth)).body).toEqual({ guid: post, deleted: 2 });
            expect((await feed('/groups/twowaves/posts.json')).items).toEqual([]);
        });

        it('approves submissions that failed moderation', async () => {
            moderationAnswer = { ok: false, code: 'moderation-rejected', text: 'Hmm.' };
            sources[ALICE] = { status: 200, body: rssFeed([alicePost()]) };
            const { guid } = await submit(ALICE, `${G}/posts.xml`);
            const res = await request(app).post(`/groups/twowaves/admin/items/${guid}/approve`).set(auth);
            expect(res.body).toMatchObject({ guid, status: 'success', pubUrl: `${G}/posts.json#${guid}` });
            expect((await feed('/groups/twowaves/posts.json')).items[0]).toMatchObject({ id: guid, content_html: '<p>My <strong>first</strong> post</p>' });
            expect((await request(app).get(`/groups/twowaves/status/${guid}`)).body.status).toBe('success');

            // comments
            const c = await (async () => {
                sources[BOB] = { status: 200, body: jsonFeed([bobComment('c1', `${G}/posts.json#${guid}`)]) };
                return (await submit(`${BOB}#c1`, `${G}/posts.json#${guid}`)).guid;
            })();
            expect((await request(app).post(`/groups/twowaves/admin/items/${c}/approve`).set(auth)).status).toBe(200);
            expect((await feed(`/groups/twowaves/comments/${guid}/comments.json`)).items[0].id).toBe(c);
        });

        it('does not approve submissions that failed the rules', async () => {
            sources[ALICE] = { status: 200, body: rssFeed([alicePost({ markdown: undefined, html: '<script>x</script>' })]) };
            const { guid } = await submit(ALICE, `${G}/posts.xml`);
            const res = await request(app).post(`/groups/twowaves/admin/items/${guid}/approve`).set(auth);
            expect(res.status).toBe(400);
            expect(res.body.message).toBe('Only submissions that failed moderation can be approved');
        });
    });
});
