// Request abstraction in the style of t-lib-backend/server/server-common.ts: handlers receive an
// IncomingHttpRequest and return a JSON-serializable value, or a RawResponse for XML and other bodies.
import { timingSafeEqual } from 'crypto';
import { InvalidAuthError } from './exceptions';

export interface IncomingHttpRequest {
    body: any | null;
    queryStringParameters: {[key: string]: string};
    headers: {[key: string]: string};
    pathParameters: {[key: string]: string};
    sourceIp?: string;
    // Headers the handler wants set on the response, applied by the Express wrapper.
    responseHeaders?: {[name: string]: string};
    // Status code for successful responses (default 200).
    responseStatus?: number;
}

// A handler result that is sent as-is instead of being JSON-encoded.
export class RawResponse {
    constructor(public body: string, public contentType: string) {}
}

export const time = {
    now: () => new Date(),
};

function safeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a), bb = Buffer.from(b);
    return ba.length == bb.length && timingSafeEqual(ba, bb);
}

// Checks "Authorization: Bearer <token>" against the expected token.
export function authenticateBearer(event: IncomingHttpRequest, expectedToken: string): void {
    const header = event.headers?.authorization || event.headers?.Authorization;
    const m = header && /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!m)
        throw new InvalidAuthError('Missing bearer token');
    if (!expectedToken || !safeEqual(m[1], expectedToken))
        throw new InvalidAuthError('Invalid token');
}
