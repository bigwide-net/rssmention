// Minimal stand-in for t-lib-hyperlog: the same call shape (sub/info/warning/error/exception/close),
// writing to the console. Messages use {0}, {1}... placeholders like hyperlog.

import { escapeForLog } from './sanitize';

export interface LogContext {
    sub(name: string): LogContext;
    info(message: string, ...args: any[]): void;
    warning(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
    exception(err: any): void;
    close(): void;
}

let silent = process.env.RSSMENTION_LOG == 'silent' || process.env.JEST_WORKER_ID !== undefined;

export function setLogSilent(value: boolean) {
    silent = value;
}

function format(message: string, args: any[]): string {
    // Arguments may contain untrusted input: escape line breaks and invisible characters, so they can't forge log lines.
    const text = message.replace(/\{(\d+)\}/g, (_m, i) => escapeForLog(String(args[Number(i)])));
    const extra = args.filter(a => a && typeof a == 'object');
    return extra.length && !/\{\d+\}/.test(message) ? text + ' ' + escapeForLog(JSON.stringify(extra[0])) : text;
}

export function createLog(name: string): LogContext {
    const prefix = `[${name}]`;
    return {
        sub: (subName: string) => createLog(`${name}/${subName}`),
        info: (message, ...args) => { if (!silent) console.log(prefix, format(message, args)); },
        warning: (message, ...args) => { if (!silent) console.warn(prefix, 'WARNING', format(message, args)); },
        error: (message, ...args) => { if (!silent) console.error(prefix, 'ERROR', format(message, args)); },
        exception: (err: any) => { if (!silent) console.error(prefix, 'EXCEPTION', err?.stack || err); },
        close: () => {},
    };
}

export const log = createLog('rssmention');
