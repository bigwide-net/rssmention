import { ConfigError, DEFAULT_FEED_MODERATION_PROMPT, DEFAULT_MODERATION_PROMPT, parseConfig } from '../lib/config';

const minimal = (group: any = {}, top: any = {}) => JSON.stringify({
    baseUrl: 'https://rm.example/',
    ...top,
    groups: { g: { name: 'n', topic: 't', adminToken: 'abcdefghijklmn', ...group } },
});

describe('parseConfig()', () => {
    it('parses the example from the spec (JSON5 with comments)', () => {
        const config = parseConfig(`{
            port: 80,
            baseUrl: 'https://rssmention.twowavesandadot.blog',
            groups: {
                twowaves: { // this is the group id in URLs
                    name: "Two Waves RSS Discussion",
                    topic: "Discussions about RSS",
                    socialSpec: "twowavesandadot.blog",
                    tos: "https://twowavesandadot.blog/discussion/tos.html",
                    adminToken: "abcdefgh12345z",
                    submissionRules: {
                        general: { maxLength: 4000, urlAutoLinking: true, allowStyle: true, allowLinks: true, allowCode: true,
                            allowQuote: false, allowImages: false, allowTables: false, allowLists: false, allowHeadlines: false,
                            requireSocialSpec: true, title: 'allowed' },
                        posts: { title: 'required', maxLength: 8000, allowHeadlines: true, allowLists: true, commentLimit: 1000 },
                        comments: { title: 'none', commentLimit: 20 },
                        moderationLLM: "openai/gpt-6-luna",
                        moderationPrompt: "Topic {topic}: {comment}",
                    },
                },
            },
        }`, {});
        expect(config.port).toBe(80);
        const g = config.groups.twowaves;
        expect(g.posts).toMatchObject({ title: 'required', maxLength: 8000, allowHeadlines: true, allowLists: true, allowQuote: false, commentLimit: 1000, requireSocialSpec: true });
        expect(g.comments).toMatchObject({ title: 'none', maxLength: 4000, allowHeadlines: false, allowLists: false, commentLimit: 20, maxDepth: 5 });
        expect(g.moderationLLM).toBe('openai/gpt-6-luna');
        expect(g.moderationPrompt).toBe('Topic {topic}: {comment}');
    });

    it('applies defaults', () => {
        const config = parseConfig(minimal(), {});
        expect(config.baseUrl).toBe('https://rm.example');
        expect(config.port).toBe(3040);
        expect(config.varDir).toBe('./var');
        expect(config.groups.g.posts).toMatchObject({ commentLimit: 1000, allowEdit: false, allowDelete: false, title: 'allowed' });
        expect(config.groups.g.comments).toMatchObject({ commentLimit: 20, maxDepth: 5 });
        expect(config.groups.g.moderationPrompt).toBe(DEFAULT_MODERATION_PROMPT);
    });

    it('lets environment variables override', () => {
        const config = parseConfig(minimal(), { RSSMENTION_VAR: '/data', RSSMENTION_PORT: '9000', RSSMENTION_BASE_URL: 'https://other.example' });
        expect(config).toMatchObject({ varDir: '/data', port: 9000, baseUrl: 'https://other.example' });
    });

    it('parses posts: false and rejects externalFeeds', () => {
        const g = parseConfig(minimal(), {}).groups.g;
        expect(g).toMatchObject({ type: 'group', path: 'groups/g', acceptPosts: true, acceptComments: true, acceptMentions: false });
        expect(parseConfig(minimal({ submissionRules: { posts: false } }), {}).groups.g).toMatchObject({ acceptPosts: false, posts: { commentLimit: 1000 } });
        expect(() => parseConfig(minimal({ externalFeeds: ['https://blog.example/feed.xml'] }), {})).toThrow('feedComments');
    });

    describe('feedComments', () => {
        const feedConfig = (feed: any = {}, top: any = {}) => JSON.stringify({
            baseUrl: 'https://rm.example/',
            ...top,
            feedComments: { blog: { name: 'Blog', adminToken: 'abcdefghijklmn', feeds: ['https://blog.example/feed.json'], ...feed } },
        });

        it('applies defaults: comments with socialspec required, no mentions', () => {
            const config = parseConfig(feedConfig(), {});
            expect(config.groups).toEqual({});
            expect(config.feedComments.blog).toMatchObject({
                type: 'feed', id: 'blog', path: 'comments/blog', name: 'Blog', topic: 'Blog', feeds: ['https://blog.example/feed.json'],
                acceptPosts: false, acceptComments: true, acceptMentions: false,
                comments: { title: 'none', requireSocialSpec: true, commentLimit: 20, maxDepth: 5 },
                posts: { commentLimit: 1000 },
                moderationPrompt: DEFAULT_FEED_MODERATION_PROMPT,
            });
        });

        it('enables mentions, disables comments and sets the thread limit', () => {
            const blog = parseConfig(feedConfig({ submissionRules: { comments: false, mentions: true, threadLimit: 50 } }), {}).feedComments.blog;
            expect(blog).toMatchObject({ acceptComments: false, acceptMentions: true, posts: { commentLimit: 50 } });
            const rules = parseConfig(feedConfig({ submissionRules: { general: { maxLength: 500 }, comments: { requireSocialSpec: false, title: 'allowed' } } }), {}).feedComments.blog;
            expect(rules.comments).toMatchObject({ maxLength: 500, requireSocialSpec: false, title: 'allowed' });
        });

        it('rejects invalid feedComments', () => {
            expect(() => parseConfig(feedConfig({ feeds: [] }), {})).toThrow('feeds');
            expect(() => parseConfig(feedConfig({ feeds: undefined }), {})).toThrow('feeds');
            expect(() => parseConfig(feedConfig({ feeds: ['ftp://x/feed'] }), {})).toThrow('feeds[0]');
            expect(() => parseConfig(feedConfig({ feeds: ['https://x/feed#a'] }), {})).toThrow('without fragment');
            expect(() => parseConfig(feedConfig({ submissionRules: { mentions: 'yes' } }), {})).toThrow('mentions must be a boolean');
            expect(() => parseConfig(feedConfig({ submissionRules: { posts: {} } }), {})).toThrow('unknown key posts');
            expect(() => parseConfig(feedConfig({ submissionRules: { threadLimit: -1 } }), {})).toThrow('threadLimit');
            expect(() => parseConfig(feedConfig({ submissionRules: { general: { commentLimit: 3 } } }), {})).toThrow('threadLimit');
            expect(() => parseConfig(feedConfig({ adminToken: 'short' }), {})).toThrow('adminToken');
            const bad = JSON.stringify({ baseUrl: 'https://x', feedComments: { 'Bad/Id': { name: 'n', adminToken: 'abcdefghijklmn', feeds: ['https://x/f'] } } });
            expect(() => parseConfig(bad, {})).toThrow('feedComments ids');
        });
    });

    it('strips @ from the group socialspec account', () => {
        expect(parseConfig(minimal({ socialSpec: '@x.example' }), {}).groups.g.socialSpec).toBe('x.example');
    });

    it('rejects invalid configs', () => {
        expect(() => parseConfig('{', {})).toThrow(ConfigError);
        expect(() => parseConfig(minimal({}, { baseUrl: 'ftp://x' }), {})).toThrow('baseUrl');
        expect(() => parseConfig(JSON.stringify({ baseUrl: 'https://x', groups: {} }), {})).toThrow('At least one group or feedComments');
        expect(() => parseConfig(minimal({ adminToken: 'short' }), {})).toThrow('adminToken');
        expect(() => parseConfig(minimal({ name: undefined }), {})).toThrow('name');
        expect(() => parseConfig(minimal({ submissionRules: { general: { allowFoo: true } } }), {})).toThrow('unknown rule allowFoo');
        expect(() => parseConfig(minimal({ submissionRules: { posts: { title: 'maybe' } } }), {})).toThrow('title');
        expect(() => parseConfig(minimal({ submissionRules: { posts: { maxLength: -1 } } }), {})).toThrow('maxLength');
        expect(() => parseConfig(minimal({ submissionRules: { comments: { minLength: 5000 } } }), {})).toThrow('minLength of comments must not exceed maxLength');
        expect(() => parseConfig(minimal({ submissionRules: { general: { maxDepth: 3 } } }), {})).toThrow('maxDepth');
        expect(() => parseConfig(minimal({ submissionRules: { comments: { allowLinks: 'yes' } } }), {})).toThrow('allowLinks');
    });

    it('rejects invalid group ids', () => {
        const text = JSON.stringify({ baseUrl: 'https://x', groups: { 'Bad/Id': { name: 'n', topic: 't', adminToken: 'abcdefghijklmn' } } });
        expect(() => parseConfig(text, {})).toThrow('group ids');
    });
});
