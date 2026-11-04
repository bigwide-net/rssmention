// Fetches submitted source feeds. Guards against SSRF: http(s) only, no IP-literal hosts, hostnames
// must resolve to public addresses (checked inside the DNS lookup to prevent rebinding), at most one
// redirect, 1 MB and 10 seconds.
import http from 'http';
import https from 'https';
import { isIP } from 'net';
import { safeLookup } from './safe-target';

export const MAX_FEED_BYTES = 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 1;

export interface FetchResult {
    status: number;
    body: string;
    contentType?: string;
}

export class FetchError extends Error {}

// RSSMENTION_ALLOW_PRIVATE_TARGETS=true allows private addresses (local development and tests).
const allowPrivate = () => process.env.RSSMENTION_ALLOW_PRIVATE_TARGETS == 'true';

// Checks a URL for use as webmention source. Returns an error message, or undefined if acceptable.
export function checkSourceUrl(source: string): string | undefined {
    let url: URL;
    try {
        url = new URL(source);
    } catch {
        return 'source is not a valid URL';
    }
    if (url.protocol != 'http:' && url.protocol != 'https:')
        return 'source must be a http(s) URL';
    if (url.username || url.password)
        return 'source must not contain credentials';
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')))
        return 'source must use a host name, not an IP address';
    return undefined;
}

function fetchOnce(url: URL): Promise<{ status: number, location?: string, body: string, contentType?: string }> {
    return new Promise((resolve, reject) => {
        const client = url.protocol == 'https:' ? https : http;
        const req = client.get(url, {
            lookup: allowPrivate() ? undefined : (safeLookup as any),
            timeout: FETCH_TIMEOUT_MS,
            headers: { 'User-Agent': 'rssmention/1.0 (+https://rssmention.bigwide.net/)', 'Accept': 'application/rss+xml, application/feed+json, application/json, application/xml, text/xml, */*;q=0.1' },
        }, res => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
                res.resume();
                resolve({ status, location: res.headers.location, body: '' });
                return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_FEED_BYTES) {
                    req.destroy(new FetchError(`Feed exceeds ${MAX_FEED_BYTES} bytes`));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), contentType: res.headers['content-type'] }));
            res.on('error', reject);
        });
        const deadline = setTimeout(() => req.destroy(new FetchError('Timeout fetching feed')), FETCH_TIMEOUT_MS);
        req.on('close', () => clearTimeout(deadline));
        req.on('timeout', () => req.destroy(new FetchError('Timeout fetching feed')));
        req.on('error', reject);
    });
}

export async function fetchFeed(source: string): Promise<FetchResult> {
    let url = new URL(source);
    url.hash = '';
    for (let redirects = 0; ; redirects++) {
        const problem = checkSourceUrl(url.href);
        if (problem) throw new FetchError(problem);
        let res;
        try {
            res = await fetchOnce(url);
        } catch (err: any) {
            throw err instanceof FetchError ? err : new FetchError(`Could not fetch ${url.href}: ${err.message}`);
        }
        if (res.location === undefined)
            return { status: res.status, body: res.body, contentType: res.contentType };
        if (redirects >= MAX_REDIRECTS)
            throw new FetchError('Too many redirects');
        url = new URL(res.location, url);
    }
}
