// After a deploy: tell IndexNow search engines (Bing, Yandex, Seznam, Naver…) which pages exist, so
// changes are recrawled in hours instead of weeks. Google does not take IndexNow: it reads the
// sitemap (submit it once in Search Console). Run by the Pages workflow; `--dry-run` prints the call.
// The key is public by design: IndexNow checks that the site serves it at `keyLocation`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://damilurg.github.io/webview-lens';
const here = path.dirname(fileURLToPath(import.meta.url));
const keyFile = fs
    .readdirSync(path.join(here, 'public'))
    .find((file) => /^[0-9a-f]{32}\.txt$/.test(file));

if (!keyFile) throw new Error('No IndexNow key file in site/public');

const key = keyFile.replace(/\.txt$/, '');
const sitemap = await (await fetch(`${SITE}/sitemap.xml`)).text();
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');
const body = {
    host: new URL(SITE).host,
    key,
    keyLocation: `${SITE}/${keyFile}`,
    urlList: urlList.filter((url) => url.startsWith(`${SITE}/`)),
};

if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ ...body, urlList: `${body.urlList.length} URLs` }));
    process.exit(0);
}

const response = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
});

// 200 or 202: accepted. 403: the key file is not live yet (first deploy), 422: URLs outside the host.
console.log(`IndexNow: ${response.status} for ${body.urlList.length} URLs`);
if (!response.ok) process.exitCode = 1;
