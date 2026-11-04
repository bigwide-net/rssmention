import { existsSync, readFileSync } from 'fs';
import path from 'path';
import {
    addFailedComment, addPublishedComment, appendToLog, deleteCommentTree, deletePost, findInLog, findSource, groupDir,
    listArchives, readComments, readLog, readPostMeta, setSource, StoredItem, updateInLog, withGroupLock, writePostMeta,
} from '../lib/storage';
import { testConfig } from './helpers';

const G = 'twowaves';

function item(id: string, kind: 'post' | 'comment' = 'post'): StoredItem {
    return { id, content_html: `<p>${id}</p>`, date_published: '2026-11-01T00:00:00.000Z', _rssmention: { kind, source: `https://a.example/${id}`, target: 't', submittedAt: '2026-11-01T00:00:00.000Z' } };
}

const postId = (n: number) => `P${String(n).padStart(9, '0')}`;

describe('storage', () => {
    let cleanup: () => void;
    beforeEach(() => ({ cleanup } = testConfig()));
    afterEach(() => cleanup());

    describe('appendToLog()', () => {
        it('keeps the latest 50 items, newest first, and archives in files of 50', async () => {
            for (let i = 1; i <= 120; i++)
                await appendToLog(G, 'published', item(postId(i)));
            const current = await readLog(G, 'published');
            expect(current).toHaveLength(50);
            expect(current[0].id).toBe(postId(120));
            expect(current[49].id).toBe(postId(71));
            expect(await listArchives(G, 'published')).toEqual([1, 2, 3]);
            const a1 = await readLog(G, 'published', 1);
            expect(a1).toHaveLength(50);
            expect(a1[0].id).toBe(postId(50));
            expect(a1[49].id).toBe(postId(1));
            expect(await readLog(G, 'published', 2)).toHaveLength(50);
            expect((await readLog(G, 'published', 3)).map(i => i.id)).toEqual(Array.from({ length: 20 }, (_, i) => postId(120 - i)));
            const file = JSON.parse(readFileSync(path.join(groupDir(G), 'group-published.json'), 'utf8'));
            expect(file.version).toBe('https://jsonfeed.org/version/1.1');
            expect(existsSync(path.join(groupDir(G), 'archive', 'group-published-3.json'))).toBe(true);
        });

        it('returns the archive number', async () => {
            for (let i = 1; i <= 50; i++)
                expect(await appendToLog(G, 'failed', item(postId(i)))).toBe(1);
            expect(await appendToLog(G, 'failed', item(postId(51)))).toBe(2);
        });

        it('keeps logs separate', async () => {
            await appendToLog(G, 'submissions', item(postId(1)));
            expect(await readLog(G, 'failed')).toEqual([]);
            expect(await readLog(G, 'submissions')).toHaveLength(1);
        });
    });

    describe('updateInLog() / findInLog()', () => {
        it('updates and removes items in the current file and the archive', async () => {
            for (let i = 1; i <= 60; i++)
                await appendToLog(G, 'published', item(postId(i)));
            await updateInLog(G, 'published', postId(55), i => ({ ...i, title: 'changed' }), 2);
            expect((await readLog(G, 'published'))[5].title).toBe('changed');
            expect((await readLog(G, 'published', 2)).find(i => i.id == postId(55))?.title).toBe('changed');

            // only in an archive
            expect((await findInLog(G, 'published', postId(3)))?.id).toBe(postId(3));
            await updateInLog(G, 'published', postId(3), () => null);
            expect(await findInLog(G, 'published', postId(3))).toBeUndefined();
            expect(await readLog(G, 'published', 1)).toHaveLength(49);
        });
    });

    describe('comments', () => {
        const post = 'AAAAAAAAAA', c1 = `${post}-aaaaa`, c2 = `${post}-bbbbb`, r1 = `${c1}-ccccc`, r2 = `${r1}-ddddd`;

        beforeEach(async () => {
            await appendToLog(G, 'published', item(post));
            await writePostMeta(G, { guid: post, archive: 1, allowComments: true, counts: {}, total: 0 });
            for (const c of [c1, c2, r1, r2])
                await addPublishedComment(G, item(c, 'comment'));
            await setSource(G, 'https://a.example/r1', r1);
            await setSource(G, 'https://a.example/c2', c2);
        });

        it('counts direct replies and the total', async () => {
            expect(await readPostMeta(G, post)).toMatchObject({ counts: { [post]: 2, [c1]: 1, [r1]: 1 }, total: 4 });
            expect((await readComments(G, post)).map(i => i.id)).toEqual([c1, c2]);
            expect((await readComments(G, c1)).map(i => i.id)).toEqual([r1]);
        });

        it('deletes a comment with all replies', async () => {
            await addFailedComment(G, r1, item(`${r1}-eeeee`, 'comment'));
            expect(await deleteCommentTree(G, c1)).toBe(3);
            expect((await readComments(G, post)).map(i => i.id)).toEqual([c2]);
            expect(await readComments(G, c1)).toEqual([]);
            expect(await readComments(G, r1, 'failed')).toEqual([]);
            expect(await readPostMeta(G, post)).toMatchObject({ counts: { [post]: 1 }, total: 1 });
            expect(await findSource(G, 'https://a.example/r1')).toBeUndefined();
            expect(await findSource(G, 'https://a.example/c2')).toBe(c2);
        });

        it('returns 0 for unknown comments', async () => {
            expect(await deleteCommentTree(G, `${post}-zzzzz`)).toBe(0);
        });

        it('deletes a post with all comments', async () => {
            await deletePost(G, post);
            expect(await readLog(G, 'published')).toEqual([]);
            expect(await readPostMeta(G, post)).toBeUndefined();
            expect(await findSource(G, 'https://a.example/c2')).toBeUndefined();
        });

        it('keeps the latest 50 failed comments', async () => {
            for (let i = 0; i < 55; i++)
                await addFailedComment(G, post, item(`${post}-${String(i).padStart(5, '0')}`, 'comment'));
            const failed = await readComments(G, post, 'failed');
            expect(failed).toHaveLength(50);
            expect(failed[0].id).toBe(`${post}-00054`);
        });
    });

    describe('withGroupLock()', () => {
        it('serializes tasks', async () => {
            const order: string[] = [];
            const slow = withGroupLock(G, async () => { await new Promise(r => setTimeout(r, 20)); order.push('a'); });
            const fast = withGroupLock(G, async () => { order.push('b'); });
            await Promise.all([slow, fast]);
            expect(order).toEqual(['a', 'b']);
        });

        it('continues after failures', async () => {
            await expect(withGroupLock(G, async () => { throw new Error('x'); })).rejects.toThrow('x');
            await expect(withGroupLock(G, async () => 5)).resolves.toBe(5);
        });
    });
});
