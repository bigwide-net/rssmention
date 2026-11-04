// Parses submitted RSS 2.0 and JSON feeds into a normalized form. Only the fields rssmention needs
// are extracted: the source namespace (RSS) and Downread RFC-1 `_source` (JSON) supply Markdown,
// accounts and inReplyTo.
import { XMLParser } from 'fast-xml-parser';

export const SOURCE_NS_URIS = ['http://source.scripting.com/', 'https://source.scripting.com/'];
export const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/';
export const DC_NS = 'http://purl.org/dc/elements/1.1/';
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
}

export class FeedParseError extends Error {}

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

    const channelAccount = text(socialSpecOf(channel));
    const channelAuthor = text(get(channel, [DC_NS], 'creator')) ?? text(channel.managingEditor);
    const items: SourceItem[] = [];
    for (const item of asArray(channel.item)) {
        if (!item || typeof item != 'object') continue;
        const guid = text(item.guid) ?? text(item.link);
        if (!guid) continue;
        const commenting = get(item, RM_NS_URIS, 'commenting');
        const allowComments = commenting && typeof commenting == 'object' ? text(get(commenting, RM_NS_URIS, 'allowComments')) : undefined;
        items.push({
            guid,
            title: text(item.title),
            html: text(get(item, [CONTENT_NS], 'encoded')) ?? text(item.description),
            markdown: text(get(item, SOURCE_NS_URIS, 'markdown')),
            authorName: text(get(item, [DC_NS], 'creator')) ?? text(item.author) ?? channelAuthor,
            socialSpec: text(socialSpecOf(item)) ?? channelAccount,
            inReplyTo: text(get(item, SOURCE_NS_URIS, 'inReplyTo')),
            pubDate: parseDate(text(item.pubDate)),
            url: text(item.link),
            allowComments: allowComments === undefined ? undefined : allowComments.toLowerCase() != 'false',
        });
    }
    return { format: 'rss', title: text(channel.title), items };
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
    const feedAccount = jsonSocialSpec(feed._source);
    const feedAuthor = jsonString(feed.authors?.[0]?.name) ?? jsonString(feed.author?.name);
    const items: SourceItem[] = [];
    for (const item of feed.items) {
        if (!item || typeof item != 'object') continue;
        const guid = jsonString(item.id);
        if (!guid) continue;
        const source = item._source && typeof item._source == 'object' ? item._source : {};
        const inReplyTo = typeof source.inReplyTo == 'string' ? source.inReplyTo : jsonString(source.inReplyTo?.value);
        const allowComments = item._commenting?.allowComments;
        items.push({
            guid,
            title: jsonString(item.title),
            html: jsonString(item.content_html),
            text: jsonString(item.content_text),
            markdown: jsonString(source.markdown),
            authorName: jsonString(item.authors?.[0]?.name) ?? jsonString(item.author?.name) ?? feedAuthor,
            socialSpec: jsonSocialSpec(source) ?? feedAccount,
            inReplyTo: inReplyTo?.trim() || undefined,
            pubDate: parseDate(jsonString(item.date_published)),
            url: jsonString(item.url),
            allowComments: typeof allowComments == 'boolean' ? allowComments : undefined,
        });
    }
    return { format: 'json', title: jsonString(feed.title), items };
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
