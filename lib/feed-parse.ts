// Parses submitted RSS 2.0 and JSON feeds into a normalized form. Only the fields rssmention needs
// are extracted: the source namespace (RSS) and Downread RFC-1 `_source` (JSON) supply Markdown,
// accounts and inReplyTo.
import { XMLParser } from 'fast-xml-parser';
import { cleanLine, cleanText, MAX_FEED_FIELD_LENGTH, MAX_NAME_LENGTH } from './sanitize';

export const SOURCE_NS_URIS = ['http://source.scripting.com/', 'https://source.scripting.com/'];
export const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/';
export const DC_NS = 'http://purl.org/dc/elements/1.1/';
export const ATOM_NS = 'http://www.w3.org/2005/Atom';
export const RM_NS_URIS = ['https://rssmention.bigwide.net/', 'http://rssmention.bigwide.net/'];

export interface SourceItem {
    guid: string;
    title?: string;
    html?: string;
    markdown?: string;
    text?: string;          // JSON Feed content_text
    authorName?: string;
    socialSpec?: string;    // socialspec account, item-level or inherited from the feed
    inReplyTo?: string;
    pubDate?: Date;
    url?: string;
    allowComments?: boolean;
}

export interface SourceFeed {
    format: 'rss' | 'json';
    title?: string;
    items: SourceItem[];
    // the next (older) page of a paged feed: JSON next_url, RSS <atom:link rel="next">
    next?: string;
}

export class FeedParseError extends Error {}

// Every string taken from a feed is sanitized here, before anything else sees it: single-line fields
// lose control and invisible characters and are capped, content keeps its line breaks.
const line = (s: string | undefined, max = MAX_FEED_FIELD_LENGTH) => s === undefined ? undefined : cleanLine(s, max) || undefined;
const multi = (s: string | undefined) => s === undefined ? undefined : cleanText(s).trim() || undefined;
// Item guids are identifiers: items with absurdly long guids are skipped rather than truncated.
const itemGuid = (s: string | undefined) => s === undefined || s.length > MAX_FEED_FIELD_LENGTH ? undefined : line(s);

function text(value: any): string | undefined {
    if (Array.isArray(value)) value = value[0];
    if (value === undefined || value === null) return undefined;
    if (typeof value == 'object') value = value['#text'];
    if (value === undefined || value === null) return undefined;
    const s = String(value).trim();
    return s || undefined;
}

function asArray(value: any): any[] {
    return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function parseDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    return isNaN(d.getTime()) ? undefined : d;
}

function normalizeNs(uri: string): string {
    return uri.trim().replace(/\/?$/, '/');
}

// Maps namespace URIs to the prefixes the document declared for them.
function collectPrefixes(...elements: any[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const el of elements) {
        if (!el || typeof el != 'object') continue;
        for (const [key, value] of Object.entries(el)) {
            const m = /^@_xmlns:(.+)$/.exec(key);
            if (m && typeof value == 'string') {
                const uri = normalizeNs(value);
                map.set(uri, [...(map.get(uri) ?? []), m[1]]);
            }
        }
    }
    return map;
}

function parseRss(xml: string): SourceFeed {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: false,
        parseAttributeValue: false,
        trimValues: true,
        processEntities: true,
        htmlEntities: true,
        isArray: (name) => name == 'item',
    });
    let doc: any;
    try {
        doc = parser.parse(xml, true);
    } catch (err: any) {
        throw new FeedParseError('Feed is neither valid XML nor JSON: ' + (err.message || err));
    }
    const rss = doc?.rss;
    const channel = rss?.channel;
    if (!channel || typeof channel != 'object')
        throw new FeedParseError('Not an RSS 2.0 feed (missing rss/channel)');

    const prefixes = collectPrefixes(rss, channel);
    const names = (uris: string[], local: string) =>
        uris.flatMap(u => prefixes.get(normalizeNs(u)) ?? []).map(p => `${p}:${local}`);
    const get = (el: any, uris: string[], local: string) => {
        for (const n of names(uris, local))
            if (el[n] !== undefined) return el[n];
        return undefined;
    };
    const socialSpecOf = (el: any) => asArray(get(el, SOURCE_NS_URIS, 'account'))
        .find(a => typeof a == 'object' && String(a['@_service'] ?? '').toLowerCase() == 'socialspec');

    const channelAccount = line(text(socialSpecOf(channel)));
    const channelAuthor = line(text(get(channel, [DC_NS], 'creator')) ?? text(channel.managingEditor), MAX_NAME_LENGTH);
    const items: SourceItem[] = [];
    for (const item of asArray(channel.item)) {
        if (!item || typeof item != 'object') continue;
        const guid = itemGuid(text(item.guid) ?? text(item.link));
        if (!guid) continue;
        const commenting = get(item, RM_NS_URIS, 'commenting');
        const allowComments = commenting && typeof commenting == 'object' ? text(get(commenting, RM_NS_URIS, 'allowComments')) : undefined;
        items.push({
            guid,
            title: line(text(item.title)),
            html: multi(text(get(item, [CONTENT_NS], 'encoded')) ?? text(item.description)),
            markdown: multi(text(get(item, SOURCE_NS_URIS, 'markdown'))),
            authorName: line(text(get(item, [DC_NS], 'creator')) ?? text(item.author), MAX_NAME_LENGTH) ?? channelAuthor,
            socialSpec: line(text(socialSpecOf(item))) ?? channelAccount,
            inReplyTo: line(text(get(item, SOURCE_NS_URIS, 'inReplyTo'))),
            pubDate: parseDate(text(item.pubDate)),
            url: line(text(item.link)),
            allowComments: allowComments === undefined ? undefined : allowComments.toLowerCase() != 'false',
        });
    }
    const next = asArray(get(channel, [ATOM_NS], 'link'))
        .find(l => l && typeof l == 'object' && String(l['@_rel'] ?? '').toLowerCase() == 'next' && typeof l['@_href'] == 'string');
    const nextUrl = line(next?.['@_href']);
    return { format: 'rss', title: line(text(channel.title)), items, ...(nextUrl ? { next: nextUrl } : {}) };
}

// RFC-1 accounts: the map form ({"socialspec": "@x"}), the list form ([{service, name}]) and the
// early single-object form (account: {service, name}).
function jsonSocialSpec(source: any): string | undefined {
    if (!source || typeof source != 'object') return undefined;
    const accounts = source.accounts;
    if (accounts && typeof accounts == 'object' && !Array.isArray(accounts)) {
        for (const [service, name] of Object.entries(accounts))
            if (service.toLowerCase() == 'socialspec' && typeof name == 'string' && name.trim()) return name.trim();
        return undefined;
    }
    const list = Array.isArray(accounts) ? accounts : source.account ? [source.account] : [];
    const entry = list.find((a: any) => a && typeof a == 'object' && String(a.service ?? '').toLowerCase() == 'socialspec');
    return typeof entry?.name == 'string' && entry.name.trim() ? entry.name.trim() : undefined;
}

function jsonString(value: any): string | undefined {
    if (typeof value == 'number') return String(value);
    return typeof value == 'string' && value.trim() ? value.trim() : undefined;
}

function parseJson(body: string): SourceFeed {
    let feed: any;
    try {
        feed = JSON.parse(body);
    } catch (err: any) {
        throw new FeedParseError('Feed is not valid JSON: ' + err.message);
    }
    if (!feed || typeof feed != 'object' || typeof feed.version != 'string' || !feed.version.startsWith('https://jsonfeed.org/version/'))
        throw new FeedParseError('Not a JSON Feed (missing version)');
    if (!Array.isArray(feed.items))
        throw new FeedParseError('JSON Feed has no items array');
    const feedAccount = line(jsonSocialSpec(feed._source));
    const feedAuthor = line(jsonString(feed.authors?.[0]?.name) ?? jsonString(feed.author?.name), MAX_NAME_LENGTH);
    const items: SourceItem[] = [];
    for (const item of feed.items) {
        if (!item || typeof item != 'object') continue;
        const guid = itemGuid(jsonString(item.id));
        if (!guid) continue;
        const source = item._source && typeof item._source == 'object' ? item._source : {};
        const inReplyTo = typeof source.inReplyTo == 'string' ? source.inReplyTo : jsonString(source.inReplyTo?.value);
        const allowComments = item._commenting?.allowComments;
        items.push({
            guid,
            title: line(jsonString(item.title)),
            html: multi(jsonString(item.content_html)),
            text: multi(jsonString(item.content_text)),
            markdown: multi(jsonString(source.markdown)),
            authorName: line(jsonString(item.authors?.[0]?.name) ?? jsonString(item.author?.name), MAX_NAME_LENGTH) ?? feedAuthor,
            socialSpec: line(jsonSocialSpec(source)) ?? feedAccount,
            inReplyTo: line(inReplyTo),
            pubDate: parseDate(jsonString(item.date_published)),
            url: line(jsonString(item.url)),
            allowComments: typeof allowComments == 'boolean' ? allowComments : undefined,
        });
    }
    const next = typeof feed.next_url == 'string' ? line(feed.next_url) : undefined;
    return { format: 'json', title: line(jsonString(feed.title)), items, ...(next ? { next } : {}) };
}

export function parseFeed(body: string): SourceFeed {
    const trimmed = body.replace(/^﻿/, '').trimStart();
    return trimmed.startsWith('{') ? parseJson(trimmed) : parseRss(trimmed);
}

/**
 * Finds the submitted item: the one whose guid (RSS) or id (JSON) equals the source URL's fragment,
 * or the only item of the feed if the source has no fragment.
 */
export function findSourceItem(feed: SourceFeed, fragment: string | undefined): SourceItem | 'ambiguous' | undefined {
    if (fragment)
        return feed.items.find(i => i.guid == fragment);
    if (feed.items.length > 1) return 'ambiguous';
    return feed.items[0];
}
