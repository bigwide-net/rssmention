// Renders group and comment feeds as JSON Feed and RSS 2.0. Every feed carries the full submission
// configuration (rm:submissions / _submissions), so clients can post without other knowledge.
import { CommentRules, Config, GroupConfig, RSSMENTION_NS, SubmissionRules } from './config';
import { SOURCE_ABOUT, StoredItem } from './storage';
import { FeedFormat, mentionUrl } from './urls';

export const SOURCE_NS = 'http://source.scripting.com/';

export interface ItemView {
    item: StoredItem;
    inReplyTo?: (format: FeedFormat) => string;
    comments?: { feedUrl: (format: FeedFormat) => string, count: number, total?: number };
    allowComments?: boolean; // posts only
}

export interface FeedView {
    group: GroupConfig;
    title: string;
    description: string;
    url: (format: FeedFormat) => string;
    prevArchiveUrl?: (format: FeedFormat) => string;
    isArchive?: boolean;
    items: ItemView[];
}

const POLICY_KEYS: (keyof CommentRules)[] = ['minLength', 'maxLength', 'urlAutoLinking', 'allowStyle', 'allowLinks', 'allowCode', 'allowQuote',
    'allowImages', 'allowTables', 'allowLists', 'allowHeadlines', 'requireSocialSpec', 'title', 'allowEdit', 'allowDelete', 'commentLimit', 'maxDepth'];

export function policies(rules: SubmissionRules | CommentRules): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};
    for (const key of POLICY_KEYS)
        if ((rules as any)[key] !== undefined) result[key] = (rules as any)[key];
    return result;
}

export function submissionsJson(config: Config, group: GroupConfig) {
    return {
        about: RSSMENTION_NS,
        url: mentionUrl(config, group.id),
        ...(group.tos ? { tos: group.tos } : {}),
        policies: { ...(group.acceptPosts ? { posts: policies(group.posts) } : {}), comments: policies(group.comments) },
        republish: group.republish,
    };
}

// ---- JSON Feed ----

function jsonItem(view: ItemView) {
    const { _rssmention, _source, ...item } = view.item;
    const source: Record<string, any> = { about: SOURCE_ABOUT };
    if (_source?.markdown) source.markdown = _source.markdown;
    if (_source?.accounts) source.accounts = _source.accounts;
    if (view.inReplyTo) source.inReplyTo = view.inReplyTo('json');
    if (view.comments)
        source.comments = { feedUrl: view.comments.feedUrl('json'), count: view.comments.count, ...(view.comments.total !== undefined ? { total: view.comments.total } : {}) };
    return {
        ...item,
        _source: source,
        ...(view.allowComments !== undefined ? { _commenting: { about: RSSMENTION_NS, allowComments: view.allowComments } } : {}),
    };
}

export function renderJson(config: Config, feed: FeedView): string {
    return JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: feed.title,
        description: feed.description,
        home_page_url: feed.url('json'),
        feed_url: feed.url('json'),
        ...(feed.prevArchiveUrl ? { next_url: feed.prevArchiveUrl('json') } : {}),
        _submissions: submissionsJson(config, feed.group),
        ...(feed.group.socialSpec ? { _source: { about: SOURCE_ABOUT, accounts: { socialspec: '@' + feed.group.socialSpec } } } : {}),
        items: feed.items.map(jsonItem),
    }, null, 1);
}

// ---- RSS ----

export function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function el(name: string, content: string | undefined, attrs: Record<string, string | number | boolean> = {}): string {
    const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`).join('');
    return content === undefined ? `<${name}${a}/>` : `<${name}${a}>${escapeXml(content)}</${name}>`;
}

function rssItem(view: ItemView): string {
    const item = view.item;
    const lines = [
        item.title !== undefined ? el('title', item.title) : '',
        item.url ? el('link', item.url) : '',
        el('guid', item.id, { isPermaLink: 'false' }),
        el('pubDate', new Date(item.date_published).toUTCString()),
        item.authors?.[0] ? el('dc:creator', item.authors[0].name) : '',
        el('description', item.content_html),
        item._source?.markdown ? el('source:markdown', item._source.markdown) : '',
        item._source?.accounts?.socialspec ? el('source:account', item._source.accounts.socialspec, { service: 'socialspec' }) : '',
        view.inReplyTo ? el('source:inReplyTo', view.inReplyTo('xml')) : '',
        view.comments ? el('source:comments', undefined, { count: view.comments.count, feedUrl: view.comments.feedUrl('xml') }) : '',
        view.allowComments !== undefined ? `<rm:commenting>${el('rm:allowComments', String(view.allowComments))}</rm:commenting>` : '',
    ];
    return `<item>\n${lines.filter(Boolean).map(l => '  ' + l).join('\n')}\n</item>`;
}

function rssSubmissions(config: Config, group: GroupConfig): string {
    const policy = (type: string, rules: SubmissionRules) => el('rm:policies', undefined, { type, ...policies(rules) });
    return ['<rm:submissions>',
        '  ' + el('rm:url', mentionUrl(config, group.id)),
        group.tos ? '  ' + el('rm:tos', group.tos) : '',
        group.acceptPosts ? '  ' + policy('posts', group.posts) : '',
        '  ' + policy('comments', group.comments),
        '  ' + el('rm:republish', String(group.republish)),
        '</rm:submissions>'].filter(Boolean).join('\n');
}

// The submissions element alone, for owners of external feeds to copy into their feed.
export function renderSubmissionsXml(config: Config, group: GroupConfig): string {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        rssSubmissions(config, group).replace('<rm:submissions>', `<rm:submissions xmlns:rm="${RSSMENTION_NS}">`) + '\n';
}

export function renderRss(config: Config, feed: FeedView): string {
    const channel = [
        el('title', feed.title),
        el('link', feed.url('xml')),
        el('description', feed.description),
        el('atom:link', undefined, { rel: 'self', href: feed.url('xml'), type: 'application/rss+xml' }),
        el('atom:link', undefined, { rel: 'webmention', href: mentionUrl(config, feed.group.id) }),
        feed.prevArchiveUrl ? el('atom:link', undefined, { rel: 'prev-archive', href: feed.prevArchiveUrl('xml') }) : '',
        feed.isArchive ? '<fh:archive/>' : '',
        feed.group.socialSpec ? el('source:account', '@' + feed.group.socialSpec, { service: 'socialspec' }) : '',
        rssSubmissions(config, feed.group),
        ...feed.items.map(rssItem),
    ].filter(Boolean).join('\n');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        `<rss version="2.0" xmlns:source="${SOURCE_NS}" xmlns:rm="${RSSMENTION_NS}" xmlns:atom="http://www.w3.org/2005/Atom" ` +
        'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:fh="http://purl.org/syndication/history/1.0">\n' +
        `<channel>\n${channel}\n</channel>\n</rss>\n`;
}
