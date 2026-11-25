// Demo-only plumbing: serves the demo page, its client script and the built `webview-lens/rum`.

import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist');

const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
};

/** True when the module at `moduleUrl` is the script Node was started with. */
export const isMainModule = (moduleUrl: string): boolean =>
    process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);

const resolveAsset = (pathname: string): string | undefined => {
    if (pathname === '/') return path.join(here, 'index.html');
    if (pathname === '/client.js') return path.join(here, 'client.js');
    if (!pathname.startsWith('/lib/') || !pathname.endsWith('.js')) return undefined;

    const file = path.resolve(dist, `.${pathname.slice('/lib'.length)}`);

    return file.startsWith(dist + path.sep) ? file : undefined;
};

/** Serves a demo asset; false when the path is not one (the caller answers 404). */
export const serveDemoAsset = (req: http.IncomingMessage, res: http.ServerResponse): boolean => {
    if (req.method !== 'GET') return false;

    const file = resolveAsset(new URL(req.url ?? '/', 'http://localhost').pathname);

    if (!file) return false;

    try {
        const body = fs.readFileSync(file);

        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'text/plain' });
        res.end(body);
    } catch {
        res.writeHead(file.startsWith(dist) ? 503 : 404, { 'content-type': 'text/plain' });
        res.end(
            file.startsWith(dist) ? 'Run `npm run build` first: dist/ is missing' : 'Not found',
        );
    }

    return true;
};
