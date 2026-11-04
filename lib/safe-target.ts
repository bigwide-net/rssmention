// Copied from t-lib-backend/server/safe-target.ts (mono repo). Keep in sync.
/**
 * SSRF guard for servers that fetch URLs on someone else's behalf (downread/feed-proxy-server,
 * aux-services/cors-proxy). A server sits next to its own loopback services, the provider's
 * private network and the cloud metadata endpoint (169.254.169.254), so every target must
 * resolve to a public address.
 *
 * The check runs inside the socket's DNS lookup (safeLookup), not before the fetch: resolving
 * once up front and letting fetch resolve again would be open to DNS rebinding, where the second
 * answer is the private one. IP-literal hostnames never hit the lookup, so checkTargetUrl covers
 * them separately.
 */

import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup, LookupAddress } from 'node:dns';

const blocked = new BlockList();
const IPV4_BLOCKED: [string, number][] = [
    ['0.0.0.0', 8],        // "this network"
    ['10.0.0.0', 8],       // private
    ['100.64.0.0', 10],    // carrier-grade NAT (also used by some VPS private networks)
    ['127.0.0.0', 8],      // loopback
    ['169.254.0.0', 16],   // link-local, incl. cloud metadata
    ['172.16.0.0', 12],    // private
    ['192.0.0.0', 24],     // IETF protocol assignments
    ['192.168.0.0', 16],   // private
    ['198.18.0.0', 15],    // benchmarking
    ['224.0.0.0', 3],      // multicast (224/4) + reserved (240/4)
];
const IPV6_BLOCKED: [string, number][] = [
    ['::', 128],           // unspecified
    ['::1', 128],          // loopback
    ['fc00::', 7],         // unique local
    ['fe80::', 10],        // link-local
    ['ff00::', 8],         // multicast
];
for (const [net, prefix] of IPV4_BLOCKED) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of IPV6_BLOCKED) blocked.addSubnet(net, prefix, 'ipv6');

export class ForbiddenTargetError extends Error {
    code = 'EFORBIDDENTARGET';
}

/** `::ffff:127.0.0.1` and its normalized form `::ffff:7f00:1` are IPv4 in disguise. */
function unmapIpv4(address: string): string | undefined {
    const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
    if (!m) return undefined;
    if (m[1]) return m[1];
    const hi = parseInt(m[2], 16), lo = parseInt(m[3], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/** True for anything that is not a public unicast address — including things that aren't IPs at all. */
export function isPrivateAddress(address: string): boolean {
    const v4 = unmapIpv4(address) ?? (isIP(address) == 4 ? address : undefined);
    try {
        if (v4) return blocked.check(v4, 'ipv4');
        if (isIP(address) == 6) return blocked.check(address.replace(/%.*$/, ''), 'ipv6');
    } catch {
        // BlockList rejects forms it can't parse; refuse rather than guess.
    }
    return true;
}

export interface TargetProblem {
    category: 'bad-request' | 'forbidden-target';
    message: string;
}

/**
 * Validates a target URL before fetching: http(s) only, and IP-literal hosts must be public.
 * Hostnames are left to safeLookup. Returns the problem, or undefined if acceptable.
 */
export function checkTargetUrl(url: string, allowPrivate: boolean): TargetProblem | undefined {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { return { category: 'bad-request', message: 'invalid url' }; }
    if (parsed.protocol != 'http:' && parsed.protocol != 'https:')
        return { category: 'bad-request', message: 'only http(s) urls are allowed' };
    if (allowPrivate) return undefined;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isPrivateAddress(host))
        return { category: 'forbidden-target', message: `target address ${host} is not public` };
    return undefined;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void;

/**
 * Creates a drop-in for dns.lookup (as net.connect calls it) that refuses non-public results and
 * any address `isBlocked` refuses (e.g. our own servers' public IPs). `baseLookup` does the actual
 * resolution, by default the OS resolver.
 */
export function createSafeLookup(isBlocked: (address: string) => boolean = () => false, baseLookup: Function = dnsLookup) {
    return (hostname: string, options: object, callback: LookupCallback): void => {
        baseLookup(hostname, options, (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => {
            if (err) return callback(err);
            const addresses = Array.isArray(address) ? address.map(a => a.address) : [address];
            const bad = addresses.find(a => isPrivateAddress(a) || isBlocked(a));
            if (bad) return callback(new ForbiddenTargetError(`${hostname} resolves to forbidden address ${bad}`));
            callback(null, address, family);
        });
    };
}

/** Drop-in for dns.lookup (as net.connect calls it) that refuses non-public results. */
export const safeLookup = createSafeLookup();
