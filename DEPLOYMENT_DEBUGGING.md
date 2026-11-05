# TikTok comment media on Render

## Confirmed cause and fix

The subsequent Render diagnostic showed that TikTok returned sticker URLs on
`p16-tiktok-dm-sticker-sign.tiktokcdn-us.com`. The payload contained the expected
animation fields, but each URL had `accepted: false`: our media domain allowlist
omitted `tiktokcdn-us.com`. This was an application validation bug, not evidence
that Render was blocked or that TikTok withheld the file.

`src/media.js` now accepts subdomains of that regional CDN. Regression tests
cover the reported response structure and reject lookalike hosts, insecure
URLs, credentials, and custom ports. Push and redeploy the backend, retry the
comment, then disable `DISCOVERY_DEBUG` after confirming the deployed download.
The historical probes below explain how this was isolated; regional CDN
download from Render still requires verification after deployment.

The reported link was tested against both local discovery and
`https://sticker-backend-9ty9.onrender.com` on 2026-11-05.

Video: `7704392415708187935`. Comment: `7704397626653606676`.

| Probe | Observed result |
| --- | --- |
| Local discovery | Exact comment matched; animated sticker URL found |
| Render extraction of the same comment | Exact comment matched; `media_unavailable` |
| Render extraction using the locally discovered CDN URL | Succeeded: 40 frames, 2,500 ms, 512 × 512 WebP, 446,200 bytes |

This isolates the observed failure to comment media discovery. Render could
reach the sticker CDN, download the file, and convert it. This does not prove
why discovery differs: the deployed revision and the raw TikTok response from
Render still need comparison. Do not assume that a host change or extra browser
headers will fix the issue.

## Compare the deployed code and upstream payload

### Without Render Shell (including free services)

Deploy the backend changes, then set `DISCOVERY_DEBUG=1` under the service's
Environment settings and apply the change. Keep the normal start command
`npm start`. Submit the failing comment through the website, then open the
service's normal Logs view and look for a line beginning
`[sticker-discovery]`. This logs the matched comment's missing-media structure
from the real extraction request, including `renderCommit`, `stickerPresent`,
field names, and CDN hosts with their allowlist result. It does not log comment
text, usernames, signed URL paths or query strings, cookies, or environment
secrets. Send that diagnostic line for comparison, then remove the variable or
set it to `0` when finished. This is diagnostic instrumentation, not a fix for
TikTok withholding a URL.

### With Render Shell

First check Render's deployed commit against the backend repository. The
baseline tested locally was `d50dc67c47607d104e3735fb09911e93857b0768`, which
already includes mobile request parameters, browser headers, and nested media
URL extraction. These changes alone do not establish a fix for Render.

The diagnostic script added with this document makes the actual discovery
requests and reports the source fingerprint, Render commit, response status,
and the matched comment's sticker structure. It omits signed URLs, user
information, comment text, cookies, and environment secrets.

After deploying the diagnostic files, run this from the backend directory
locally and in Render Shell, if Shell is available for the service:

```sh
npm run diagnose -- 'https://vt.tiktok.com/ZS9yEhAjQTmLm-dF9mB/'
```

Compare:

- Different `discoverySha256`: the deployed discovery code differs. Deploy the
  intended backend revision and retest before investigating hosting.
- Matching fingerprints, but missing `stickerPresent` or empty `mediaFields`
  only on Render: TikTok is withholding media in that environment. A parser
  change cannot recover an absent URL. Investigate an authorized upstream
  provider or an extraction worker with a network location verified to return
  media. Test before paying for or migrating hosting.
- `mediaFields` contains URLs with `accepted: false`: inspect the returned CDN
  host and add a narrowly scoped, verified domain only if appropriate. Keep
  URL validation; do not accept arbitrary hosts.
- Accepted URLs exist but extraction remains unavailable: preserve that
  response structure as a regression fixture and fix the parser against it.
- Empty/non-JSON or unsuccessful upstream responses: this is a comment API
  access failure, distinct from a matched comment with missing media.

If Shell is unavailable, use the Environment/Logs method above. Do not share
`.env` contents or TikTok cookies.

The successful direct-CDN probe is a temporary workaround: a current media URL
found locally can be pasted into the existing application. Signed CDN URLs
expire, and this route does not claim exact-comment provenance.
