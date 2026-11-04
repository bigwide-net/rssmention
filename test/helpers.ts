import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { Config, parseConfig, setConfig } from '../lib/config';

export const BASE = 'https://rm.example';
export const ADMIN_TOKEN = 'admin-token-123456';

export function testConfig(groupOverrides: any = {}): { config: Config, cleanup: () => void } {
    const varDir = mkdtempSync(path.join(os.tmpdir(), 'rssmention-test-'));
    const group = {
        name: 'Two Waves RSS Discussion',
        topic: 'Discussions about RSS',
        socialSpec: 'twowaves.example',
        tos: 'https://twowaves.example/tos.html',
        adminToken: ADMIN_TOKEN,
        ...groupOverrides,
        submissionRules: {
            general: { maxLength: 4000, requireSocialSpec: true, title: 'allowed', ...groupOverrides.submissionRules?.general },
            posts: { title: 'required', maxLength: 8000, allowHeadlines: true, commentLimit: 1000, ...groupOverrides.submissionRules?.posts },
            comments: { title: 'none', commentLimit: 20, ...groupOverrides.submissionRules?.comments },
            ...(groupOverrides.submissionRules?.moderationLLM ? { moderationLLM: groupOverrides.submissionRules.moderationLLM } : {}),
        },
    };
    const config = parseConfig(JSON.stringify({ baseUrl: BASE, groups: { twowaves: group } }), { RSSMENTION_VAR: varDir });
    setConfig(config);
    return { config, cleanup: () => rmSync(varDir, { recursive: true, force: true }) };
}

export interface FeedItemSpec {
    guid: string;
    title?: string;
    html?: string;
    markdown?: string;
    inReplyTo?: string;
    account?: string;
    author?: string;
    pubDate?: Date;
    link?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function rssFeed(items: FeedItemSpec[], channelAccount?: string): string {
    return `<?xml version="1.0"?>
<rss version="2.0" xmlns:source="http://source.scripting.com/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>Alice</title>
<link>https://alice.example/</link>
${channelAccount ? `<source:account service="socialspec">${channelAccount}</source:account>` : ''}
${items.map(i => `<item>
  <guid isPermaLink="false">${esc(i.guid)}</guid>
  ${i.title ? `<title>${esc(i.title)}</title>` : ''}
  ${i.link ? `<link>${esc(i.link)}</link>` : ''}
  ${i.html !== undefined ? `<description><![CDATA[${i.html}]]></description>` : ''}
  ${i.markdown !== undefined ? `<source:markdown>${esc(i.markdown)}</source:markdown>` : ''}
  ${i.inReplyTo ? `<source:inReplyTo>${esc(i.inReplyTo)}</source:inReplyTo>` : ''}
  ${i.account ? `<source:account service="socialspec">${esc(i.account)}</source:account>` : ''}
  ${i.author ? `<dc:creator>${esc(i.author)}</dc:creator>` : ''}
  ${i.pubDate ? `<pubDate>${i.pubDate.toUTCString()}</pubDate>` : ''}
</item>`).join('\n')}
</channel>
</rss>`;
}

export function jsonFeed(items: FeedItemSpec[], feedAccount?: string): string {
    return JSON.stringify({
        version: 'https://jsonfeed.org/version/1.1',
        title: 'Bob',
        ...(feedAccount ? { _source: { about: 'x', accounts: { socialspec: feedAccount } } } : {}),
        items: items.map(i => ({
            id: i.guid,
            ...(i.title ? { title: i.title } : {}),
            ...(i.html !== undefined ? { content_html: i.html } : {}),
            ...(i.link ? { url: i.link } : {}),
            ...(i.author ? { authors: [{ name: i.author }] } : {}),
            ...(i.pubDate ? { date_published: i.pubDate.toISOString() } : {}),
            _source: {
                about: 'x',
                ...(i.markdown !== undefined ? { markdown: i.markdown } : {}),
                ...(i.inReplyTo ? { inReplyTo: i.inReplyTo } : {}),
                ...(i.account ? { accounts: { socialspec: i.account } } : {}),
            },
        })),
    });
}
