// HTML the iOS MITM proxy serves to the iPhone: the setup page and the two self-checks.

/** Host answered by the proxy itself: it only opens when the iPhone really uses the proxy. */
export const PROXY_CHECK_HOST = 'webview-lens.check';

/** Path answered inside the intercepted TLS session: it only opens when the CA is trusted. */
export const INTERCEPT_CHECK_PATH = '/__webview-lens/ok';

export const page = (title: string, body: string): string => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>webview-lens · ${title}</title>
<body style="font:16px/1.5 system-ui;max-width:560px;margin:32px auto;padding:0 16px">${body}`;

export const certLandingPage = (
    hostHint: string,
    proxyPort: number,
    targetOrigin: string,
): string =>
    page(
        'iOS setup',
        `<h1>webview-lens iOS setup</h1>
<p>Open this page as <b>http://</b>${hostHint}:${proxyPort}/ (not https: the proxy port speaks plain HTTP).</p>
<p><a href="/webview-lens.mobileconfig" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:8px">Download iOS Profile (.mobileconfig)</a></p>
<ol>
  <li>Tap <b>Download iOS Profile</b> in Safari and allow it.</li>
  <li>Open <b>Settings → General → VPN &amp; Device Management</b> and install <i>webview-lens Local CA</i>.</li>
  <li>Open <b>Settings → General → About → Certificate Trust Settings</b> and enable full trust for <i>webview-lens Local CA</i>.</li>
  <li>In <b>Settings → Wi-Fi → (i) → Configure Proxy → Manual</b>, set Server <code>${hostHint}</code> and Port <code>${proxyPort}</code>.</li>
  <li>Check the proxy: <a href="http://${PROXY_CHECK_HOST}/">http://${PROXY_CHECK_HOST}/</a> must say <b>Proxy: OK</b>.</li>
  <li>Check the CA and interception: <a href="${targetOrigin}${INTERCEPT_CHECK_PATH}">${targetOrigin}${INTERCEPT_CHECK_PATH}</a> must say <b>Interception: OK</b>.</li>
</ol>
<p>When you are done, set the Wi-Fi proxy back to <b>Off</b>: without this Mac running, the iPhone has no internet through it.</p>
<p><small>Raw PEM certificate: <a href="/ca.cer">/ca.cer</a></small></p>`,
    );
