import { depthOf, isPostGuid, isSelfOrDescendant, isValidGuid, newCommentGuid, newPostGuid, parentGuidOf, postGuidOf } from '../lib/ids';
import { commentsFeedUrl, itemUrl, normalizeFeedRef, parseTarget } from '../lib/urls';
import { testConfig } from './helpers';

describe('ids', () => {
    it('creates post guids of 10 base62 characters', () => {
        const guid = newPostGuid();
        expect(guid).toMatch(/^[0-9A-Za-z]{10}$/);
        expect(isPostGuid(guid)).toBe(true);
    });

    it('creates comment guids by appending segments', () => {
        const post = newPostGuid();
        const c1 = newCommentGuid(post);
        const c2 = newCommentGuid(c1);
        expect(c1).toMatch(new RegExp(`^${post}-[0-9a-z]{5}$`));
        expect(parentGuidOf(c2)).toBe(c1);
        expect(parentGuidOf(c1)).toBe(post);
        expect(parentGuidOf(post)).toBeUndefined();
        expect(postGuidOf(c2)).toBe(post);
        expect([depthOf(post), depthOf(c1), depthOf(c2)]).toEqual([0, 1, 2]);
        expect(isValidGuid(c2)).toBe(true);
        expect(isPostGuid(c1)).toBe(false);
    });

    it('validates guids', () => {
        expect(isValidGuid('abc')).toBe(false);
        expect(isValidGuid('AAAAAAAAAA-ABCDE')).toBe(false);
        expect(isValidGuid('AAAAAAAAAA-abcde-')).toBe(false);
        expect(isValidGuid('../../etc/x')).toBe(false);
    });

    it('detects descendants', () => {
        expect(isSelfOrDescendant('AAAAAAAAAA-aaaaa-bbbbb', 'AAAAAAAAAA-aaaaa')).toBe(true);
        expect(isSelfOrDescendant('AAAAAAAAAA-aaaaa', 'AAAAAAAAAA-aaaaa')).toBe(true);
        expect(isSelfOrDescendant('AAAAAAAAAA-aaaab', 'AAAAAAAAAA-aaaaa')).toBe(false);
    });
});

describe('urls', () => {
    const { config, cleanup } = testConfig();
    afterAll(cleanup);
    const g = 'https://rm.example/groups/twowaves';
    const post = 'AAAAAAAAAA', comment = 'AAAAAAAAAA-aaaaa', reply = 'AAAAAAAAAA-aaaaa-bbbbb';

    it('builds feed urls', () => {
        expect(commentsFeedUrl(config, 'twowaves', post, 'json')).toBe(`${g}/comments/${post}/comments.json`);
        expect(commentsFeedUrl(config, 'twowaves', comment, 'xml')).toBe(`${g}/comments/${post}/${comment}/comments.xml`);
        expect(itemUrl(config, 'twowaves', post, 'json')).toBe(`${g}/posts.json#${post}`);
        expect(itemUrl(config, 'twowaves', reply, 'json')).toBe(`${g}/comments/${post}/${comment}/comments.json#${reply}`);
    });

    describe('parseTarget()', () => {
        it('accepts the posts feed for new posts', () => {
            expect(parseTarget(config, 'twowaves', `${g}/posts.xml`)).toEqual({ kind: 'group' });
            expect(parseTarget(config, 'twowaves', `${g}/posts.json`)).toEqual({ kind: 'group' });
        });

        it('accepts posts feeds and archives with #post-guid', () => {
            expect(parseTarget(config, 'twowaves', `${g}/posts.json#${post}`)).toEqual({ kind: 'post', guid: post });
            expect(parseTarget(config, 'twowaves', `${g}/archive/posts-3.xml#${post}`)).toEqual({ kind: 'post', guid: post });
        });

        it('accepts the comments feed containing the comment', () => {
            expect(parseTarget(config, 'twowaves', `${g}/comments/${post}/comments.json#${comment}`)).toEqual({ kind: 'comment', guid: comment });
            expect(parseTarget(config, 'twowaves', `${g}/comments/${post}/${comment}/comments.xml#${reply}`)).toEqual({ kind: 'comment', guid: reply });
        });

        it('rejects comments in the wrong feed', () => {
            expect(() => parseTarget(config, 'twowaves', `${g}/comments/${post}/comments.json#${reply}`)).toThrow('does not reference');
            expect(() => parseTarget(config, 'twowaves', `${g}/comments/BBBBBBBBBB/comments.json#${comment}`)).toThrow('does not reference');
        });

        it('rejects foreign and malformed targets', () => {
            expect(() => parseTarget(config, 'twowaves', 'https://other.example/groups/twowaves/posts.xml')).toThrow();
            expect(() => parseTarget(config, 'twowaves', 'https://rm.example/groups/other/posts.xml')).toThrow();
            expect(() => parseTarget(config, 'twowaves', `${g}/posts.json#not-a-guid`)).toThrow();
            expect(() => parseTarget(config, 'twowaves', `${g}/archive/posts-1.json`)).toThrow();
            expect(() => parseTarget(config, 'twowaves', `${g}/posts.json?x=1`)).toThrow();
            expect(() => parseTarget(config, 'twowaves', 'nonsense')).toThrow('not a valid URL');
        });
    });

    it('normalizes feed refs: xml equals json', () => {
        expect(normalizeFeedRef(`${g}/posts.xml#${post}`)).toBe(normalizeFeedRef(`${g}/posts.json#${post}`));
        expect(normalizeFeedRef(`${g}/posts.xml`)).toBe(`${g}/posts.json`);
        expect(normalizeFeedRef(`${g}/posts.xml#a`)).not.toBe(normalizeFeedRef(`${g}/posts.xml#b`));
        expect(normalizeFeedRef('not a url')).toBeUndefined();
    });
});
