import { ConfigError, DEFAULT_MODERATION_PROMPT, parseConfig } from '../lib/config';

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

    it('parses externalFeeds and posts: false', () => {
        const g = parseConfig(minimal(), {}).groups.g;
        expect(g).toMatchObject({ acceptPosts: true });
        expect(g.externalFeeds).toBeUndefined();
        expect(parseConfig(minimal({ submissionRules: { posts: false } }), {}).groups.g).toMatchObject({ acceptPosts: false, posts: { commentLimit: 1000 } });
        const ext = parseConfig(minimal({ externalFeeds: ['https://blog.example/feed.xml'] }), {}).groups.g;
        expect(ext).toMatchObject({ acceptPosts: false, externalFeeds: ['https://blog.example/feed.xml'] });
        expect(() => parseConfig(minimal({ externalFeeds: [] }), {})).toThrow('externalFeeds');
        expect(() => parseConfig(minimal({ externalFeeds: ['ftp://x/feed'] }), {})).toThrow('externalFeeds[0]');
        expect(() => parseConfig(minimal({ externalFeeds: ['https://x/feed#a'] }), {})).toThrow('without fragment');
    });

    it('strips @ from the group socialspec account', () => {
        expect(parseConfig(minimal({ socialSpec: '@x.example' }), {}).groups.g.socialSpec).toBe('x.example');
    });

    it('rejects invalid configs', () => {
        expect(() => parseConfig('{', {})).toThrow(ConfigError);
        expect(() => parseConfig(minimal({}, { baseUrl: 'ftp://x' }), {})).toThrow('baseUrl');
        expect(() => parseConfig(JSON.stringify({ baseUrl: 'https://x', groups: {} }), {})).toThrow('At least one group');
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
