// File-based storage. All data of a space lives in $RSSMENTION_VAR/<space path>, i.e. groups/<group>
// for groups and comments/<feed> for feedComments. Storage functions take the space path.
//
//   group-{submissions,failed,published}.json      the latest 50 items, newest first
//   archive/group-{...}-<n>.json                    archives of 50 items each, n = 1, 2, ...
//   comments/<post-guid>/post.json                  post metadata: archive number, comment counts, allowComments
//   comments/<post-guid>/comments-published-<parent-guid>.json   direct replies to a post or comment
//   comments/<post-guid>/comments-failed-<parent-guid>.json      failed replies (latest 50)
//   comments/<post-guid>/mentions-{published,failed}.json         mentions of a post (feeds only; failed: latest 50)
//   sources.json                                    source URL -> guid, to recognize re-sent webmentions
//
// Files are written atomically (temp file + rename). Writers serialize per space with withGroupLock.
import { promises as fs } from 'fs';
import path from 'path';
import { getConfig } from './config';
import { isSelfOrDescendant, parentGuidOf, postGuidOf } from './ids';

export const FEED_FILE_SIZE = 50;
export const JSON_FEED_VERSION = 'https://jsonfeed.org/version/1.1';
export const SOURCE_ABOUT = 'https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md';

export type LogKind = 'submissions' | 'failed' | 'published';

export interface ItemInternal {
    kind: 'post' | 'comment' | 'mention';
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
    // archive/group-published-<archive>.json contains the post (0 for posts of feedComments)
    archive: number;
    // feedComments: the guid of the post in the feed, and its link (url) as last seen there
    external?: string;
    externalUrl?: string;
    allowComments: boolean;
    // guid (post or comment) -> number of direct replies (without mentions)
    counts: Record<string, number>;
    // all comments of the post at all levels (without mentions)
    total: number;
    // number of published mentions
    mentions?: number;
}

export function spaceDir(space: string): string {
    return path.join(getConfig().varDir, space);
}

function logPath(space: string, kind: LogKind): string {
    return path.join(spaceDir(space), `group-${kind}.json`);
}

function archivePath(space: string, kind: LogKind, n: number): string {
    return path.join(spaceDir(space), 'archive', `group-${kind}-${n}.json`);
}

function postDir(space: string, postGuid: string): string {
    return path.join(spaceDir(space), 'comments', postGuid);
}

function commentsPath(space: string, parentGuid: string, kind: 'published' | 'failed'): string {
    return path.join(postDir(space, postGuidOf(parentGuid)), `comments-${kind}-${parentGuid}.json`);
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

// Runs fn after all previously queued fns for the space have finished.
export function withGroupLock<T>(space: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(space) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(fn);
    const tail = result.catch(() => {});
    locks.set(space, tail);
    tail.then(() => { if (locks.get(space) === tail) locks.delete(space); });
    return result;
}

// ---- group logs (submissions, failed, published) ----

export async function listArchives(space: string, kind: LogKind): Promise<number[]> {
    let files: string[];
    try {
        files = await fs.readdir(path.join(spaceDir(space), 'archive'));
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
export async function appendToLog(space: string, kind: LogKind, item: StoredItem): Promise<number> {
    const title = `${kind} of ${space}`;
    const current = await readItems(logPath(space, kind));
    await writeItems(logPath(space, kind), [item, ...current].slice(0, FEED_FILE_SIZE), title);

    const archives = await listArchives(space, kind);
    let n = archives.length ? archives[archives.length - 1] : 1;
    let archived = await readItems(archivePath(space, kind, n));
    if (archived.length >= FEED_FILE_SIZE) {
        n++;
        archived = [];
    }
    await writeItems(archivePath(space, kind, n), [item, ...archived], `${title}, archive ${n}`);
    return n;
}

export async function readLog(space: string, kind: LogKind, archive?: number): Promise<StoredItem[]> {
    return readItems(archive === undefined ? logPath(space, kind) : archivePath(space, kind, archive));
}

/**
 * Applies `update` to the item with the given guid in group-<kind>.json and in the archives (only
 * archive `archiveHint` if given, all otherwise). `update` returns the new item, or null to remove it.
 * Returns the item as it was before the update, if found.
 */
export async function updateInLog(space: string, kind: LogKind, guid: string, update: (item: StoredItem) => StoredItem | null,
                                  archiveHint?: number): Promise<StoredItem | undefined> {
    const files = [logPath(space, kind)];
    const archives = archiveHint !== undefined ? [archiveHint] : (await listArchives(space, kind)).reverse();
    files.push(...archives.map(n => archivePath(space, kind, n)));
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
export async function findInLog(space: string, kind: LogKind, guid: string, archiveHint?: number): Promise<StoredItem | undefined> {
    const current = (await readItems(logPath(space, kind))).find(i => i.id == guid);
    if (current) return current;
    const archives = archiveHint !== undefined ? [archiveHint] : (await listArchives(space, kind)).reverse();
    for (const n of archives) {
        const item = (await readItems(archivePath(space, kind, n))).find(i => i.id == guid);
        if (item) return item;
    }
    return undefined;
}

// ---- posts ----

export async function readPostMeta(space: string, postGuid: string): Promise<PostMeta | undefined> {
    return readJson<PostMeta>(path.join(postDir(space, postGuid), 'post.json'));
}

export async function writePostMeta(space: string, meta: PostMeta): Promise<void> {
    await writeJson(path.join(postDir(space, meta.guid), 'post.json'), meta);
}

export async function postExists(space: string, postGuid: string): Promise<boolean> {
    return !!(await readPostMeta(space, postGuid));
}

export async function findPublishedPost(space: string, postGuid: string): Promise<StoredItem | undefined> {
    const meta = await readPostMeta(space, postGuid);
    return meta && findInLog(space, 'published', postGuid, meta.archive);
}

export async function updatePublishedPost(space: string, postGuid: string, update: (item: StoredItem) => StoredItem | null): Promise<StoredItem | undefined> {
    const meta = await readPostMeta(space, postGuid);
    return meta && updateInLog(space, 'published', postGuid, update, meta.archive);
}

// Removes a post with all its comments and mentions.
export async function deletePost(space: string, postGuid: string): Promise<void> {
    await updatePublishedPost(space, postGuid, () => null);
    await fs.rm(postDir(space, postGuid), { recursive: true, force: true });
    await removeSources(space, postGuid);
}

// ---- comments ----

export async function readComments(space: string, parentGuid: string, kind: 'published' | 'failed' = 'published'): Promise<StoredItem[]> {
    return readItems(commentsPath(space, parentGuid, kind));
}

export async function findComment(space: string, guid: string): Promise<StoredItem | undefined> {
    const parent = parentGuidOf(guid);
    return parent ? (await readComments(space, parent)).find(i => i.id == guid) : undefined;
}

export async function addFailedComment(space: string, parentGuid: string, item: StoredItem): Promise<void> {
    const file = commentsPath(space, parentGuid, 'failed');
    await writeItems(file, [item, ...await readItems(file)].slice(0, FEED_FILE_SIZE), `Failed replies to ${parentGuid}`);
}

// Publishes a comment and updates the counts in the post's metadata. Comments are kept oldest first.
export async function addPublishedComment(space: string, item: StoredItem): Promise<void> {
    const parent = parentGuidOf(item.id)!;
    const meta = (await readPostMeta(space, postGuidOf(item.id)))!;
    const file = commentsPath(space, parent, 'published');
    await writeItems(file, [...await readItems(file), item], `Replies to ${parent}`);
    meta.counts[parent] = (meta.counts[parent] ?? 0) + 1;
    meta.total++;
    await writePostMeta(space, meta);
}

export async function updateComment(space: string, guid: string, update: (item: StoredItem) => StoredItem): Promise<StoredItem | undefined> {
    const parent = parentGuidOf(guid)!;
    const file = commentsPath(space, parent, 'published');
    const items = await readItems(file);
    const index = items.findIndex(i => i.id == guid);
    if (index < 0) return undefined;
    const old = items[index];
    items[index] = update(old);
    await writeItems(file, items, `Replies to ${parent}`);
    return old;
}

// Removes a comment and all replies to it. Returns the number of removed comments.
export async function deleteCommentTree(space: string, guid: string): Promise<number> {
    const postGuid = postGuidOf(guid);
    const parent = parentGuidOf(guid)!;
    const meta = await readPostMeta(space, postGuid);
    if (!meta) return 0;
    const file = commentsPath(space, parent, 'published');
    const items = await readItems(file);
    if (!items.some(i => i.id == guid)) return 0;
    await writeItems(file, items.filter(i => i.id != guid), `Replies to ${parent}`);

    let removed = 1;
    const dir = postDir(space, postGuid);
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
    await writePostMeta(space, meta);
    await removeSources(space, guid);
    return removed;
}

// ---- mentions (feeds only), oldest first ----

function mentionsPath(space: string, postGuid: string, kind: 'published' | 'failed'): string {
    return path.join(postDir(space, postGuid), `mentions-${kind}.json`);
}

export async function readMentions(space: string, postGuid: string, kind: 'published' | 'failed' = 'published'): Promise<StoredItem[]> {
    return readItems(mentionsPath(space, postGuid, kind));
}

export async function findMention(space: string, guid: string): Promise<StoredItem | undefined> {
    const post = parentGuidOf(guid);
    return post && post == postGuidOf(guid) ? (await readMentions(space, post)).find(i => i.id == guid) : undefined;
}

export async function addFailedMention(space: string, item: StoredItem): Promise<void> {
    const file = mentionsPath(space, postGuidOf(item.id), 'failed');
    await writeItems(file, [item, ...await readItems(file)].slice(0, FEED_FILE_SIZE), 'Failed mentions');
}

export async function addPublishedMention(space: string, item: StoredItem): Promise<void> {
    const postGuid = postGuidOf(item.id);
    const meta = (await readPostMeta(space, postGuid))!;
    const file = mentionsPath(space, postGuid, 'published');
    await writeItems(file, [...await readItems(file), item], 'Mentions');
    meta.mentions = (meta.mentions ?? 0) + 1;
    await writePostMeta(space, meta);
}

export async function updateMention(space: string, guid: string, update: (item: StoredItem) => StoredItem): Promise<StoredItem | undefined> {
    const file = mentionsPath(space, postGuidOf(guid), 'published');
    const items = await readItems(file);
    const index = items.findIndex(i => i.id == guid);
    if (index < 0) return undefined;
    const old = items[index];
    items[index] = update(old);
    await writeItems(file, items, 'Mentions');
    return old;
}

// Removes a mention. Returns true if it existed.
export async function deleteMention(space: string, guid: string): Promise<boolean> {
    const postGuid = postGuidOf(guid);
    const file = mentionsPath(space, postGuid, 'published');
    const items = await readItems(file);
    if (!items.some(i => i.id == guid)) return false;
    await writeItems(file, items.filter(i => i.id != guid), 'Mentions');
    const meta = await readPostMeta(space, postGuid);
    if (meta) {
        meta.mentions = Math.max(0, (meta.mentions ?? 1) - 1);
        await writePostMeta(space, meta);
    }
    await removeSources(space, guid);
    return true;
}

// ---- source index ----

function sourcesPath(space: string): string {
    return path.join(spaceDir(space), 'sources.json');
}

export async function findSource(space: string, key: string): Promise<string | undefined> {
    return (await readJson<Record<string, string>>(sourcesPath(space)))?.[key];
}

export async function setSource(space: string, key: string, guid: string): Promise<void> {
    const sources = (await readJson<Record<string, string>>(sourcesPath(space))) ?? {};
    sources[key] = guid;
    await writeJson(sourcesPath(space), sources);
}

// Removes the index entries of an item and its descendants.
async function removeSources(space: string, guid: string): Promise<void> {
    const sources = await readJson<Record<string, string>>(sourcesPath(space));
    if (!sources) return;
    const kept = Object.fromEntries(Object.entries(sources).filter(([, g]) => !isSelfOrDescendant(g, guid)));
    if (Object.keys(kept).length != Object.keys(sources).length)
        await writeJson(sourcesPath(space), kept);
}
