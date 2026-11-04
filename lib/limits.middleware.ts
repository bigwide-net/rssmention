// Copied from t-lib-backend/server/limits.middleware.ts (mono repo). Keep in sync.
import { Request, Response, NextFunction, RequestHandler } from 'express';

// Default limits
const DEFAULT_LIMITS = {
    MAX_PER_IP_PER_DAY: 100000,
    MAX_PER_IP_PER_HOUR: 10000,
    MAX_PER_IP_PER_MINUTE: 500,
    MAX_IP_TRACKED: 100000,
    REQUESTS_SECOND: 500,
    REQUESTS_MINUTE: 5000,
    REQUESTS_QUARTER: 50000,
};

export interface RateLimitOptions {
    maxPerIpPerDay?: number;
    maxPerIpPerHour?: number;
    maxPerIpPerMinute?: number;
    maxIpTracked?: number;
    requestsPerSecond?: number;
    requestsPerMinute?: number;
    requestsPerQuarter?: number;
    /**
     * IPs that bypass all limits (per-IP and global), e.g. trusted peer servers.
     * Matched against the TCP peer address only, never against CF-Connecting-IP /
     * X-Forwarded-For: those headers are client-controlled on a directly reachable
     * origin, so trusting them here would let anyone skip rate limiting.
     */
    whitelist?: string[];
}

// Environment variables override the options, which override the defaults
function getLimit(envVar: string, optionValue: number | undefined, defaultValue: number): number {
    const parsed = parseInt(process.env[envVar] ?? '', 10);
    return parsed > 0 ? parsed : optionValue ?? defaultValue;
}

// Time constants
const ONE_SECOND = 1000;
const ONE_MINUTE = 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_QUARTER = 15 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

// Interval tracking for global request limits
interface IntervalTracker {
    requestCount: number;
    intervalStart: number;
}

// Per-IP counters for one time window
interface IpWindow {
    counts: Map<string, number>;
    lastReset: number;
    duration: number;
}

/**
 * Updates an interval tracker and returns the current request count
 */
function updateIntervalTracker(tracker: IntervalTracker, now: number, intervalDuration: number): number {
    if (now - tracker.intervalStart > intervalDuration) {
        tracker.requestCount = 1;
        tracker.intervalStart = now;
    } else {
        tracker.requestCount++;
    }
    return tracker.requestCount;
}

/**
 * Gets the client IP address from the request.
 *
 * Behind Cloudflare the real visitor IP is in CF-Connecting-IP (a single IP that
 * Cloudflare always sets and overwrites, so the client cannot spoof it). This is
 * only trustworthy if the origin can ONLY be reached through Cloudflare (restrict
 * the origin ports to Cloudflare's IP ranges) — otherwise a direct-to-origin
 * caller can set these headers to anything.
 *
 * Falls back to X-Forwarded-For (taking the LAST entry: the proxy appends the real
 * client, so the first entries are client-controllable) and finally the socket.
 */
export function getClientIp(req: Request): string {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp) return cfIp.trim();

    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
        return ips[ips.length - 1].trim();
    }
    return req.ip || req.socket.remoteAddress || 'unknown';
}

// Strips the IPv4-mapped IPv6 prefix Node reports for IPv4 peers on dual-stack sockets
const normalizeIp = (ip: string) => ip.trim().replace(/^::ffff:/i, '');

/**
 * Increments the request count for an IP in a window, resetting the window first if it expired.
 * Returns the new count, or undefined if the IP cannot be added due to the map size limit.
 */
function incrementIpCount(window: IpWindow, ip: string, now: number, maxTracked: number): number | undefined {
    if (now - window.lastReset > window.duration) {
        window.counts.clear();
        window.lastReset = now;
    }
    const count = (window.counts.get(ip) ?? 0) + 1;
    if (count == 1 && window.counts.size >= maxTracked)
        return undefined;
    window.counts.set(ip, count);
    return count;
}

export type RateLimitMiddleware = RequestHandler & {
    /**
     * Exempts a client IP (as resolved by getClientIp) from all limits until the process restarts.
     * Unlike the static whitelist this matches the client IP, so it is only meant for admin-triggered
     * exemptions (e.g. an admin running the e2e suite against production).
     */
    allowClientIp: (ip: string) => void;
};

/**
 * Creates an Express rate limiting middleware with its own counters.
 * LIMITS_* environment variables take precedence over the given options.
 */
export function createRateLimitMiddleware(options: RateLimitOptions = {}): RateLimitMiddleware {
    const limits = {
        maxPerIpPerDay: getLimit('LIMITS_MAX_PER_IP_PER_DAY', options.maxPerIpPerDay, DEFAULT_LIMITS.MAX_PER_IP_PER_DAY),
        maxPerIpPerHour: getLimit('LIMITS_MAX_PER_IP_PER_HOUR', options.maxPerIpPerHour, DEFAULT_LIMITS.MAX_PER_IP_PER_HOUR),
        maxPerIpPerMinute: getLimit('LIMITS_MAX_PER_IP_PER_MINUTE', options.maxPerIpPerMinute, DEFAULT_LIMITS.MAX_PER_IP_PER_MINUTE),
        maxIpTracked: getLimit('LIMITS_MAX_IP_TRACKED', options.maxIpTracked, DEFAULT_LIMITS.MAX_IP_TRACKED),
        requestsPerSecond: getLimit('LIMITS_REQUESTS_SECOND', options.requestsPerSecond, DEFAULT_LIMITS.REQUESTS_SECOND),
        requestsPerMinute: getLimit('LIMITS_REQUESTS_MINUTE', options.requestsPerMinute, DEFAULT_LIMITS.REQUESTS_MINUTE),
        requestsPerQuarter: getLimit('LIMITS_REQUESTS_QUARTER', options.requestsPerQuarter, DEFAULT_LIMITS.REQUESTS_QUARTER),
    };
    const whitelist = new Set((options.whitelist ?? []).map(normalizeIp).filter(Boolean));
    const clientWhitelist = new Set<string>();

    const start = Date.now();
    const globalTrackers: [IntervalTracker, number, number, string][] = [
        [{ requestCount: 0, intervalStart: start }, ONE_SECOND, limits.requestsPerSecond, 'Too many requests per second'],
        [{ requestCount: 0, intervalStart: start }, ONE_MINUTE, limits.requestsPerMinute, 'Too many requests per minute'],
        [{ requestCount: 0, intervalStart: start }, ONE_QUARTER, limits.requestsPerQuarter, 'Too many requests per quarter hour'],
    ];
    const ipWindows: [IpWindow, number, string][] = [
        [{ counts: new Map(), lastReset: start, duration: ONE_MINUTE }, limits.maxPerIpPerMinute, 'Too many requests per minute from this IP'],
        [{ counts: new Map(), lastReset: start, duration: ONE_HOUR }, limits.maxPerIpPerHour, 'Too many requests per hour from this IP'],
        [{ counts: new Map(), lastReset: start, duration: ONE_DAY }, limits.maxPerIpPerDay, 'Too many requests per day from this IP'],
    ];

    // Retry-After (whole seconds until the exceeded window resets) lets clients back off exactly as
    // long as needed. Browsers only expose the header cross-origin when CORS lists it in exposedHeaders,
    // so the body repeats it as retryAfter.
    const reject = (res: Response, message: string, resetsInMs: number) => {
        const retryAfter = Math.max(1, Math.ceil(resetsInMs / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({ type: 'RateLimited', error: 'Rate limit exceeded', message, retryAfter });
    };

    const middleware = (req: Request, res: Response, next: NextFunction): void => {
        const peerIp = req.socket.remoteAddress;
        if (whitelist.size && peerIp && whitelist.has(normalizeIp(peerIp)))
            return next();
        const clientIp = getClientIp(req);
        if (clientWhitelist.size && clientWhitelist.has(normalizeIp(clientIp)))
            return next();

        const now = Date.now();
        for (const [tracker, duration, limit, message] of globalTrackers)
            if (updateIntervalTracker(tracker, now, duration) > limit) {
                reject(res, message, tracker.intervalStart + duration - now);
                return;
            }

        for (const [window, limit, message] of ipWindows) {
            const count = incrementIpCount(window, clientIp, now, limits.maxIpTracked);
            const resetsInMs = window.lastReset + window.duration - now;
            if (count == undefined) {
                reject(res, 'Too many unique IPs tracked', resetsInMs);
                return;
            }
            if (count > limit) {
                reject(res, message, resetsInMs);
                return;
            }
        }

        next();
    };
    return Object.assign(middleware, { allowClientIp: (ip: string) => void clientWhitelist.add(normalizeIp(ip)) });
}

/**
 * Rate limiting middleware with the default limits
 */
export const rateLimitMiddleware = createRateLimitMiddleware();
