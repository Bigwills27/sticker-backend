# WhatsApp administration

The admin UI is at `/admin`. There is one seeded administrator and no public registration. The frontend uses the existing forest green, cream and lime design. WhatsApp is connected by the backend as a linked device; visitors never pair their accounts.

## Local setup

The generated `backend/.env` contains the database URLs, admin email/password hash, JWT signing secret and WhatsApp encryption key. It is ignored by Git and has owner-only filesystem permissions. The original local converter settings are preserved. JWT access tokens are generated when you log in, expire after eight hours and are sent as HttpOnly cookies. Logout revokes their database session.

From `backend`:

```sh
npm install
npm run db:setup
npm run dev
```

From `frontend`:

```sh
npm install
npm run dev
```

Open `http://localhost:5173/admin`. The requested login details are supplied privately in the implementation handoff; passwords are not embedded in source files.

`npm run setup:admin` imports missing database URLs from the root `.env.local` created by `neon deploy` and generates missing signing/encryption secrets. It preserves existing secrets. For a new installation, provide `ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD` as process environment variables when running that command; it saves only a scrypt hash of the password. `npm run db:setup` is idempotent and preserves an existing admin password.

## Render and Vercel

1. Commit the backend changes in the backend repository and the frontend changes in the frontend repository, then merge/push to the branch watched by each deployment. The local feature branch in both is `feat/whatsapp-admin`; changes have been left uncommitted for review.
2. In Render → backend service → Environment, use **Add from .env** to import the contents of the ignored `backend/.env.render`. It contains the production origin `https://sticker-studio-lac.vercel.app`, both Neon URLs, generated secrets, admin seed hash, `WHATSAPP_ENABLED=1`, `NODE_ENV=production`, and `HOST=0.0.0.0`. Keep Render's own `PORT`; do not import your local `PORT=8080` or `HOST=127.0.0.1`. Preserve any unrelated existing Render environment settings.
3. Use `npm install` as the backend build command and `npm start` as its start command. Startup applies migrations and seeds the admin idempotently, so no paid Render shell is needed.
4. Keep the frontend's production `VITE_API_URL=https://sticker-backend-9ty9.onrender.com`. `frontend/vercel.json` additionally proxies `/api` and `/files` to Render and enables `/admin` deep links. Admin calls always use this same-origin proxy so the HttpOnly cookie works on iPhone without depending on third-party cookies.
5. Open `https://sticker-studio-lac.vercel.app/admin`, sign in, and choose QR pairing or phone-number pairing. Pair using the dedicated account's WhatsApp **Linked devices** settings. Test delivery with **Send test to myself**. The session will appear as a linked device on your phone and can be revoked there as well.

Use a continuously running backend for WhatsApp. A free Render web service can sleep, which interrupts the linked-device connection and incoming sticker requests. Neon preserves the credentials through restarts, but the database cannot keep a sleeping backend online. A persistent Render disk is unnecessary for the WhatsApp session; Postgres holds it. Existing converter files still expire in temporary local storage.

Stop a locally connected bot backend when moving the same session to Render. The connection lease permits one active runtime per dedicated account.

The encryption key must stay the same across deploys. Changing or losing it makes existing encrypted WhatsApp credentials unreadable. Keep a secure backup of the Render settings. Keep the signing secret stable too; changing it invalidates existing admin logins.

Reconnect preserves the account's credentials and Signal keys. The runtime saves current credentials before sealing the old auth adapter, drains pending writes, closes the socket and reloads the saved session for the replacement. WhatsApp's post-pairing restart (515) uses this same path. A silent connection with registered credentials retries with exponential backoff, up to six retries; it does not delete the account. A new runtime automatically loads saved authentication on startup. Storage or ownership failures stop safely and expose recovery controls.

Signal reads use a fresh per-socket Baileys cache. Writes still await encrypted database persistence; queued updates share batches and repeated updates retain the latest snapshot. A failed key write stops the socket, so unsaved cached keys cannot silently keep the account running. The cache is discarded on replacement/reset.

A transient heartbeat error produces a storage warning and retries on the next heartbeat instead of immediately dropping the account. Test/public delivery pauses during the warning. A separate watchdog stops the socket 50 seconds after the last confirmed lease request began, leaving a safety margin before the database's 60-second lease expires. A definitive ownership rejection still stops immediately. Safe diagnostic events include the failure's code without raw database messages or credentials. libsignal's direct console session-object dumps are redacted while ordinary diagnostic logging remains available.

Initial pairing creates 812 pre-keys in the installed Baileys version. The auth adapter encrypts them before opening a transaction and writes the batch with one SQL upsert, retaining ownership checks and transactional deletion. Per-key SQL inserts can hold the lease lock for minutes over a remote connection, causing authentication, renewal and reconnect timeouts while dashboard reads still succeed. Auth writes use transaction-local 5-second lock and 10-second statement limits. After updating an older backend with this fix, restart that backend before resetting: an already-running old writer will otherwise continue holding its transaction lock.

The connection lifecycle was compared with `/Users/Wills/Desktop/projects/whatsapp-bot/src/services/BaileysBotClient.js` and `botInstanceManager.js`: preserve-on-reconnect, save-before-close, controlled post-pairing restart, QR readiness before phone pairing, and retiring old instances before reset. This app keeps encrypted Neon persistence rather than local session files. Baileys already supplies its WebSocket keep-alive; extra presence traffic is unnecessary. Session persistence cannot keep a stopped host running: [Render free web services can spin down after 15 minutes without inbound traffic](https://render.com/docs/free#spinning-down-on-idle). Continuous delivery needs an always-running backend.

## Recover a failed or stuck WhatsApp connection

Open `/admin` and choose **Reset session → Reset and get new QR**. This stops the old socket, deletes the WhatsApp credentials and Signal keys stored in Neon, and starts a fresh QR connection. There are no session files to remove on Render. Your admin account and login remain available. No shell or new environment variable is required.

Reset changes the connection owner in the same database transaction as deletion, so delayed writes from the old connection cannot recreate its keys. If another backend actively owns the session, stop that backend or wait for its lease to expire before resetting. Reset does not erase a different active owner's session.

If the old device remains listed on your phone after a reset, remove that entry under WhatsApp **Linked devices** before linking the new QR.

The dashboard shows connection phases, elapsed time, deadlines, retry countdowns, QR/code expiry and safe failure codes. A connection that never returns a QR or finishes linking times out after 45 seconds. Pairing material expires after 60 seconds unless WhatsApp supplies a replacement. A reset control remains available in failed/stuck states, and **Cancel connection** can stop an attempt. Browser requests time out rather than leaving the action spinner active forever. Offline status is explicitly stale and disables test delivery.

If a fresh QR still fails, check the displayed reason and last WhatsApp disconnect code. Render logs also include sanitized `[whatsapp]` events with those codes; they exclude QR values, pairing codes, phone numbers and credential contents. Actual WhatsApp-side rejection, network problems and expired accounts still require a successful connection to the service.

## Visitor delivery

After conversion, **Send to WhatsApp** opens a country/phone modal. Nigeria is the default; countries can be searched by name or calling code, with flags and automatic international-prefix detection. A preview shows the international number understood from local, international, spaced or pasted input. **Send sticker** validates the number again on the backend, checks registration with Baileys `onWhatsApp`, and sends the converted WebP directly from the connected account. Animated WebP keeps its animation metadata. The page shows success or an actionable error without opening WhatsApp Web. Phone metadata loads with the send component.

Each attempt has a random request identifier bound to its sticker and normalized recipient. A repeated request checks the existing delivery status rather than sending twice. The validated sticker is encrypted while pending and removed after delivery/failure. Recipient numbers are stored as keyed hashes, not plaintext. Requests are limited by IP, globally and per recipient. Registration checks happen on submission; typing only parses/formats locally. The visitor should enter their own WhatsApp number. Existing chat-command links issued by older frontend versions remain supported.

The button remains visible for converted stickers while the service is checking or offline, with a disabled state and explanation. Availability refreshes every 15 seconds while visible and when the visitor returns to the tab or regains connectivity. A sticker already open on screen becomes sendable without reloading once the admin connection is ready. Download and Share remain available.

### Bulk delivery and shareable links

The gallery offers **Send all to WhatsApp** or **Send selected to WhatsApp**, with a maximum of 10 available stickers per batch. Bulk download/share buttons are hidden. Photos and unavailable stickers cannot be selected for WhatsApp. A result with more than 10 stickers requires a selection; **Select first 10** is explicit and does not silently trim a send request.

Migration `002_whatsapp_batches.sql` adds batch progress, encrypted source references and a worker lease. Startup applies numbered migrations automatically; no new environment values or paid Render shell are required. Deploy both backend and frontend. Global admission is capped at 100 pending items; batches reserve the existing 10-sticker/IP/10-minute and 200-sticker/global/hour allowances, plus a 10-sticker/recipient/10-minute allowance. All outgoing sticker transport calls, including single sends, run serially with at least 1.5 seconds between messages.

The queue displays per-item progress and supports stopping items that have not started. Its opaque ID is the only queue data saved in browser storage. Form destination numbers remain in server memory and are never written to delivery records or browser storage; those records use keyed recipient hashes. Baileys separately persists encryption-session identifiers and sealed protocol data, which can include recipient identifiers. The UI therefore promises no phone numbers in delivery history and re-entry for future sends, rather than absolute non-storage across the WhatsApp protocol. Refreshing the page restores progress; after a backend restart, visitors re-enter the same number to continue pending items. A delivery with uncertain outcome is not automatically resent. Pending batches expire after 30 minutes and batch records are removed after another day.

The address bar holds a fragment such as `/#tiktok=<encoded TikTok URL>&scope=video`. Opening it fetches fresh results automatically. Opening one gallery item writes its canonical comment link; **Browse this video** stores video mode. Browser Back/Forward restores those views. Reset clears the fragment. Links contain no phone numbers, converted files, queue IDs or temporary backend job IDs.

The backend ignores group messages, history messages, old commands and unrelated chats. It claims codes atomically, refuses expired or reused codes and limits creation and delivery rates. Delivery is not retried automatically after an uncertain transport failure to avoid duplicate sends; visitors can create a fresh code. If WhatsApp is disconnected, downloads and regular sharing remain available.

## Data stored

- `ss_admins`: admin email, salted scrypt password hash and enabled state.
- `ss_admin_sessions`: hashed JWT session ID, admin reference, expiry and revocation.
- `ss_whatsapp_auth`: separately encrypted credentials and Signal keys; BufferJSON preserves binary values.
- `ss_whatsapp_leases`: one expiring connection-owner lease, avoiding two bot connections during deploys.
- `ss_sticker_requests`: hashed request code, encrypted WebP, expiry and delivery status. Recipient identifiers use a keyed hash. Encrypted media is removed after delivery, failure or expiry.
- `ss_admin_events`: generic operational events and timestamps, retained for seven days.
- `ss_rate_limits` and `ss_migrations`: persistent rate counters and migration history.

QR codes, pairing codes, contact lists, chat history and plaintext passwords are not stored. Baileys may perform its limited initial synchronization in memory to establish encryption mappings; the application does not persist that history. Pairing material is authenticated, uncached, expires after 60 seconds locally, and is cleared on connection.

## Checks

From the project root, `npm run build` checks backend JavaScript and builds the Vite frontend. From `backend`, `npm test` runs conversion, API, authentication, crypto, embedded Postgres and runtime tests. These tests work without a live Neon connection. `npm run test:admin-ui:local` checks the complete browser → HTTP → embedded Postgres flow without external networking.

`npm run test:neon` and `npm run test:admin-ui` require `NEON_TEST_DATABASE_URL` pointing to a separate temporary Neon branch. They refuse the production endpoint and reset only their test branch's `ss_` tables. The tests use real Postgres and HTTP but a simulated WhatsApp socket; they never send real WhatsApp messages. Browser reports and screenshots are saved under `qa/`. Actual WhatsApp linking and iPhone delivery require the dedicated phone and must be checked after deployment.

Neon CLI setup created root `neon.ts` and `.neon`, and `neon deploy` pulled credentials into the ignored root `.env.local`. Postgres is the only enabled Neon service; admin login is implemented in the existing backend. No Neon Auth signup endpoints are provisioned.
