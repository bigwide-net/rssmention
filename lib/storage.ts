// File-based storage. All data of a group lives in $RSSMENTION_VAR/groups/<group>:
//
//   group-{submissions,failed,published}.json      the latest 50 items, newest first
//   archive/group-{...}-<n>.json                    archives of 50 items each, n = 1, 2, ...
//   comments/<post-guid>/post.json                  post metadata: archive number, comment counts, allowComments
//   comments/<post-guid>/comments-published-<parent-guid>.json   direct replies to a post or comment
//   comments/<post-guid>/comments-failed-<parent-guid>.json      failed replies (latest 50)
//   sources.json                                    source URL -> guid, to recognize re-sent webmentions
//
// Files are written atomically (temp file + rename). Writers serialize per group with withGroupLock.
import { promises as fs } from 'fs';
import path from 'path';
import { getConfig } from './config';
import { isSelfOrDescendant, parentGuidOf, postGuidOf } from './ids';

export const FEED_FILE_SIZE = 50;
export const JSON_FEED_VERSION = 'https://jsonfeed.org/version/1.1';
export const SOURCE_ABOUT = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md';

export type LogKind = 'submissions' | 'failed' | 'published';

export interface ItemInternal {
    kind: 'post' | 'comment';
    source: string;
    target: string;
    submittedAt: string;
    failure?: { code: string, text: string };
    edit?: boolean;
    replacedByAdmin?: boolean;
    approved?: boolean;
    // allowComments requested by the submitter (rm:commenting / _commenting on the source item)
    allowComments?: boolean;
}

// A JSON Feed item plus rssmention's internal data in _rssmention (removed before serving).
export interface StoredItem {
    id: string;
    url?: string;
    title?: string;
    content_html: string;
    date_published: string;
    date_modified?: string;
    authors?: { name: string }[];
    _source?: { about: string, markdown?: string, accounts?: Record<string, string> };
    _rssmention: ItemInternal;
}

export interface FeedFile {
    version: string;
    title?: string;
    items: StoredItem[];
}

export interface PostMeta {
    guid: string;
    // archive/group-published-<archive>.json contains the post
    archive: number;
    allowComments: boolean;
    // guid (post or comment) -> number of direct replies
    counts: Record<string, number>;
    // all comments of the post at all levels
    total: number;
}

export function groupDir(groupId: string): string {
    return path.join(getConfig().varDir, 'groups', groupId);
}

function logPath(groupId: string, kind: LogKind): string {
    return path.join(groupDir(groupId), `group-${kind}.json`);
}

function archivePath(groupId: string, kind: LogKind, n: number): string {
    return path.join(groupDir(groupId), 'archive', `group-${kind}-${n}.json`);
}

function postDir(groupId: string, postGuid: string): string {
    return path.join(groupDir(groupId), 'comments', postGuid);
}

function commentsPath(groupId: string, parentGuid: string, kind: 'published' | 'failed'): string {
    return path.join(postDir(groupId, postGuidOf(parentGuid)), `comments-${kind}-${parentGuid}.json`);
}

// ---- low-level file helpers ----

async function readJson<T>(file: string): Promise<T | undefined> {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err: any) {
        if (err.code == 'ENOENT') return undefined;
        throw err;
    }
}

let tmpCounter = 0;
async function writeJson(file: string, data: any): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 1));
    await fs.rename(tmp, file);
}

async function readItems(file: string): Promise<StoredItem[]> {
    return (await readJson<FeedFile>(file))?.items ?? [];
}

async function writeItems(file: string, items: StoredItem[], title?: string): Promise<void> {
    await writeJson(file, { version: JSON_FEED_VERSION, title, items } satisfies FeedFile);
}

// ---- locking ----

const locks = new Map<string, Promise<unknown>>();

// Runs fn after all previously queued fns for the group have finished.
export function withGroupLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(groupId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(fn);
    const tail = result.catch(() => {});
    locks.set(groupId, tail);
    tail.then(() => { if (locks.get(groupId) === tail) locks.delete(groupId); });
    return result;
}

// ---- group logs (submissions, failed, published) ----

export async function listArchives(groupId: string, kind: LogKind): Promise<number[]> {
    let files: string[];
    try {
        files = await fs.readdir(path.join(groupDir(groupId), 'archive'));
    } catch (err: any) {
        if (err.code == 'ENOENT') return [];
        throw err;
    }
    const re = new RegExp(`^group-${kind}-(\\d+)\\.json$`);
    return files.map(f => re.exec(f)).filter(m => !!m).map(m => Number(m![1])).sort((a, b) => a - b);
}

/**
 * Adds an item to group-<kind>.json (dropping the oldest beyond 50) and to the newest archive file
 * (starting a new one when it has 50 items). Returns the archive number.
 */
export async function appendToLog(groupId: string, kind: LogKind, item: StoredItem): Promise<number> {
    const title = `${kind} of ${groupId}`;
    const current = await readItems(logPath(groupId, kind));
    await writeItems(logPath(groupId, kind), [item, ...current].slice(0, FEED_FILE_SIZE), title);

    const archives = await listArchives(groupId, kind);
    let n = archives.length ? archives[archives.length - 1] : 1;
    let archived = await readItems(archivePath(groupId, kind, n));
    if (archived.length >= FEED_FILE_SIZE) {
        n++;
        archived = [];
    }
    await writeItems(archivePath(groupId, kind, n), [item, ...archived], `${title}, archive ${n}`);
    return n;
}

export async function readLog(groupId: string, kind: LogKind, archive?: number): Promise<StoredItem[]> {
    return readItems(archive === undefined ? logPath(groupId, kind) : archivePath(groupId, kind, archive));
}

/**
 * Applies `update` to the item with the given guid in group-<kind>.json and in the archives (only
 * archive `archiveHint` if given, all otherwise). `update` returns the new item, or null to remove it.
 * Returns the item as it was before the update, if found.
 */
export async function updateInLog(groupId: string, kind: LogKind, guid: string, update: (item: StoredItem) => StoredItem | null,
                                  archiveHint?: number): Promise<StoredItem | undefined> {
    const files = [logPath(groupId, kind)];
    const archives = archiveHint !== undefined ? [archiveHint] : (await listArchives(groupId, kind)).reverse();
    files.push(...archives.map(n => archivePath(groupId, kind, n)));
    let found: StoredItem | undefined;
    for (const file of files) {
        const data = await readJson<FeedFile>(file);
        const index = data?.items.findIndex(i => i.id == guid) ?? -1;
        if (!data || index < 0) continue;
        found ??= data.items[index];
        const updated = update(data.items[index]);
        if (updated) data.items[index] = updated;
        else data.items.splice(index, 1);
        await writeJson(file, data);
    }
    return found;
}

// Finds an item in group-<kind>.json or its archives (newest first).
export async function findInLog(groupId: string, kind: LogKind, guid: string, archiveHint?: number): Promise<StoredItem | undefined> {
    const current = (await readItems(logPath(groupId, kind))).find(i => i.id == guid);
    if (current) return current;
    const archives = archiveHint !== undefined ? [archiveHint] : (await listArchives(groupId, kind)).reverse();
    for (const n of archives) {
        const item = (await readItems(archivePath(groupId, kind, n))).find(i => i.id == guid);
        if (item) return item;
    }
    return undefined;
}

// ---- posts ----

export async function readPostMeta(groupId: string, postGuid: string): Promise<PostMeta | undefined> {
    return readJson<PostMeta>(path.join(postDir(groupId, postGuid), 'post.json'));
}

export async function writePostMeta(groupId: string, meta: PostMeta): Promise<void> {
    await writeJson(path.join(postDir(groupId, meta.guid), 'post.json'), meta);
}

export async function postExists(groupId: string, postGuid: string): Promise<boolean> {
    return !!(await readPostMeta(groupId, postGuid));
}

export async function findPublishedPost(groupId: string, postGuid: string): Promise<StoredItem | undefined> {
    const meta = await readPostMeta(groupId, postGuid);
    return meta && findInLog(groupId, 'published', postGuid, meta.archive);
}

export async function updatePublishedPost(groupId: string, postGuid: string, update: (item: StoredItem) => StoredItem | null): Promise<StoredItem | undefined> {
    const meta = await readPostMeta(groupId, postGuid);
    return meta && updateInLog(groupId, 'published', postGuid, update, meta.archive);
}

// Removes a post with all its comments.
export async function deletePost(groupId: string, postGuid: string): Promise<void> {
    await updatePublishedPost(groupId, postGuid, () => null);
    await fs.rm(postDir(groupId, postGuid), { recursive: true, force: true });
    await removeSources(groupId, postGuid);
}

// ---- comments ----

export async function readComments(groupId: string, parentGuid: string, kind: 'published' | 'failed' = 'published'): Promise<StoredItem[]> {
    return readItems(commentsPath(groupId, parentGuid, kind));
}

export async function findComment(groupId: string, guid: string): Promise<StoredItem | undefined> {
    const parent = parentGuidOf(guid);
    return parent ? (await readComments(groupId, parent)).find(i => i.id == guid) : undefined;
}

export async function addFailedComment(groupId: string, parentGuid: string, item: StoredItem): Promise<void> {
    const file = commentsPath(groupId, parentGuid, 'failed');
    await writeItems(file, [item, ...await readItems(file)].slice(0, FEED_FILE_SIZE), `Failed replies to ${parentGuid}`);
}

// Publishes a comment and updates the counts in the post's metadata. Comments are kept oldest first.
export async function addPublishedComment(groupId: string, item: StoredItem): Promise<void> {
    const parent = parentGuidOf(item.id)!;
    const meta = (await readPostMeta(groupId, postGuidOf(item.id)))!;
    const file = commentsPath(groupId, parent, 'published');
    await writeItems(file, [...await readItems(file), item], `Replies to ${parent}`);
    meta.counts[parent] = (meta.counts[parent] ?? 0) + 1;
    meta.total++;
    await writePostMeta(groupId, meta);
}

export async function updateComment(groupId: string, guid: string, update: (item: StoredItem) => StoredItem): Promise<StoredItem | undefined> {
    const parent = parentGuidOf(guid)!;
    const file = commentsPath(groupId, parent, 'published');
    const items = await readItems(file);
    const index = items.findIndex(i => i.id == guid);
    if (index < 0) return undefined;
    const old = items[index];
    items[index] = update(old);
    await writeItems(file, items, `Replies to ${parent}`);
    return old;
}

// Removes a comment and all replies to it. Returns the number of removed comments.
export async function deleteCommentTree(groupId: string, guid: string): Promise<number> {
    const postGuid = postGuidOf(guid);
    const parent = parentGuidOf(guid)!;
    const meta = await readPostMeta(groupId, postGuid);
    if (!meta) return 0;
    const file = commentsPath(groupId, parent, 'published');
    const items = await readItems(file);
    if (!items.some(i => i.id == guid)) return 0;
    await writeItems(file, items.filter(i => i.id != guid), `Replies to ${parent}`);

    let removed = 1;
    const dir = postDir(groupId, postGuid);
    for (const f of await fs.readdir(dir)) {
        const m = /^comments-(published|failed)-(.+)\.json$/.exec(f);
        if (!m || !isSelfOrDescendant(m[2], guid)) continue;
        if (m[1] == 'published') removed += (await readItems(path.join(dir, f))).length;
        await fs.rm(path.join(dir, f), { force: true });
    }
    for (const key of Object.keys(meta.counts))
        if (isSelfOrDescendant(key, guid)) delete meta.counts[key];
    meta.counts[parent] = Math.max(0, (meta.counts[parent] ?? 1) - 1);
    meta.total = Math.max(0, meta.total - removed);
    await writePostMeta(groupId, meta);
    await removeSources(groupId, guid);
    return removed;
}

// ---- source index ----

function sourcesPath(groupId: string): string {
    return path.join(groupDir(groupId), 'sources.json');
}

export async function findSource(groupId: string, key: string): Promise<string | undefined> {
    return (await readJson<Record<string, string>>(sourcesPath(groupId)))?.[key];
}

export async function setSource(groupId: string, key: string, guid: string): Promise<void> {
    const sources = (await readJson<Record<string, string>>(sourcesPath(groupId))) ?? {};
    sources[key] = guid;
    await writeJson(sourcesPath(groupId), sources);
}

// Removes the index entries of an item and its descendants.
async function removeSources(groupId: string, guid: string): Promise<void> {
    const sources = await readJson<Record<string, string>>(sourcesPath(groupId));
    if (!sources) return;
    const kept = Object.fromEntries(Object.entries(sources).filter(([, g]) => !isSelfOrDescendant(g, guid)));
    if (Object.keys(kept).length != Object.keys(sources).length)
        await writeJson(sourcesPath(groupId), kept);
}
