# Backend API Contract — for frontend integration

Scope: primarily the endpoints the mobile app actually needs to call (Auth
through Read endpoints below) — the health check is left out as trivial. The
internal admin/reporting surface (`GET /dashboard/*`) is documented
separately at the bottom, clearly marked — **the mobile app never calls any
of it and never should.** It's gated behind its own `ENABLE_DASHBOARD_ENDPOINTS`
(default off) and isn't registered at all unless that's explicitly set — see
that section for why it's a separate flag from `ENABLE_DEV_ENDPOINTS`.

Every shape below is copied directly from the real route handlers in the
backend repo (`src/routes/login.ts`, `src/routes/register.ts`,
`src/routes/loginPhone.ts`, `src/routes/me.ts`, `src/routes/segments.ts`,
`src/routes/distributors.ts`, `src/routes/dashboard.ts`) as of
**2026-09-16** — not guessed from the design doc or build notes. You don't
need that repo open to use this file. If the backend changes after this
date, this copy can go stale; re-pull it from the backend side rather than
editing it here from assumptions.

## Reaching the backend (current phase: same-network, not deployed)

The app and this backend are being tested on the same office wifi network,
not over the internet yet. Base URL is `http://<backend-machine's-LAN-IP>:<port>`
— find the IP by running `ipconfig` on the machine running the backend and
using its IPv4 address (not `127.0.0.1`/`localhost`, which the phone can't
reach). Port defaults to `3000` (`src/config/env.ts`) unless overridden by
`PORT` in that machine's `.env` — confirm with whoever's running the backend
rather than assuming. The server accepts connections on all network
interfaces by default, so no backend config change is needed for this — but
if the phone can't connect, the most likely cause is Windows Firewall
blocking inbound connections to `node.exe` on that port, not the app's code.

This will change to a real deployed URL later; nothing about the request/
response shapes below will change when that happens, only the base URL.

## Auth

`POST /login`
- No auth required (this is how you get one).
- Body: `{ "username": string, "password": string }` — one of the 5 seeded
  test accounts.
- Success `200`: `{ "token": string }` — a JWT, 30-day expiry.
- Failure `401`: `{ "error": "Invalid username or password" }`
- Failure `400` (missing/wrong-typed fields): `{ "error": "username and password are required" }`
- Failure `429` (rate-limited — more than 10 attempts from the same IP in 15
  minutes): `{ "error": "Too many login attempts, please try again later" }`

`POST /register` — self-registration for internal test participants, an
alternative to the 5 seeded accounts. Gated behind `ENABLE_SELF_REGISTRATION`
(default **off**, `src/config/env.ts`) — when off, this route isn't
registered at all, same treatment as the dev-only routes below (an
unauthenticated request to it then gets whatever the rest of the app does
with an unmatched path, in practice a `401` from the auth check that runs
right after this router — not a `404`, and never a `403` confirming the
route exists). Only ever enable this for an internal test round; it must
stay off once real IFB provisioning exists.
- No auth required (this is how you get one, same as `/login`).
- Body: `{ "name": string, "phone": string, "password": string }` — `name`
  is required (non-empty, up to 200 chars). `phone` is now **required**, not
  optional — it's the identifier `POST /login/phone` logs back in with, so
  an account with no phone would have no way back in. `password` is also
  required, minimum 6 characters, no complexity rules.
- `phone` is **unverified** — no OTP, no confirmation code, just format
  validation (must contain a valid 10-digit mobile number once formatting is
  stripped). It's normalized server-side before storage and before every
  login comparison: non-digit characters removed, then only the last 10
  digits kept. `+91 98765-43210`, `9876543210`, and `098765 43210` all
  normalize to the same stored value — send the number in whatever format
  the user typed it, don't pre-normalize on the frontend.
- There is no `client_id` field, and none is accepted if you send one — every
  self-registered row is created under a fixed internal-test client
  server-side, never client-supplied. Don't build any assumption elsewhere
  in the app around choosing/passing a client.
- Success `201`: `{ "token": string }` — same shape as `/login`'s success
  response, usable immediately with every route below.
- Failure `400`: `{ "error": "name is required and must be a non-empty string up to 200 characters" }`,
  `{ "error": "phone is required and must contain a valid 10-digit mobile number" }`,
  or `{ "error": "password is required and must be at least 6 characters" }`
- Failure `409` (phone already registered — a real, expected case, not a
  bug): `{ "error": "phone_already_registered", "message": "This phone number is already registered. Please log in instead." }`
  — the app should route the user to the login-by-phone screen on this
  response, not retry or treat it as a generic error.
- Failure `429` (rate-limited — more than 20 attempts from the same IP in 15
  minutes): `{ "error": "Too many registration attempts, please try again later" }`

`POST /login/phone` — login counterpart to `/register`, for distributors who
signed up that way (as opposed to the 5 seeded username/password accounts,
which still only work on `/login`). Gated behind the same
`ENABLE_SELF_REGISTRATION` flag, same "not registered at all when off"
treatment as `/register`.
- No auth required (this is how you get one, same as `/login`).
- Body: `{ "phone": string, "password": string }` — `phone` goes through the
  same normalization as `/register` (strip non-digits, keep last 10), so any
  format the user types is fine as long as it's the same number.
- Success `200`: `{ "token": string }` — same shape as `/login`'s success
  response.
- Failure `401`: `{ "error": "Invalid phone or password" }` — returned for
  both an unrecognized phone number and a correct-phone-wrong-password case.
  Deliberately the same message either way (same reasoning as `/login`'s
  own `401`) — don't build any UI copy that assumes which one happened, the
  backend won't tell you.
- Failure `400`: `{ "error": "phone and password are required" }`
- Failure `429` (rate-limited — more than 10 attempts from the same IP in 15
  minutes): `{ "error": "Too many login attempts, please try again later" }`
- No password-reset path exists anywhere in this flow (no SMS/OTP
  verification at any step) — explicitly out of scope for this internal
  test round. A forgotten password currently has no self-serve recovery;
  don't build a "forgot password" affordance pointing at a backend endpoint
  that doesn't exist.

Every request after login must include:
```
Authorization: Bearer <token>
```
Missing or invalid token on any route below → `401`, no data returned,
before any handler logic runs. The `error` code distinguishes *why*:
- `missing_token` — no `Authorization` header, or not in `Bearer <token>` form.
- `token_expired` — the token was valid but its 30-day expiry has passed
  (or, once a revocation mechanism exists, was revoked — same code, that
  doesn't exist yet). This is the one case worth handling specially: it
  means "the user needs to log in again," not "something is wrong with the
  request" — a good trigger for a silent re-login redirect rather than a
  generic error screen.
- `invalid_token` — anything else (malformed, wrong signature, tampered).
  Treat the same as `missing_token` for UI purposes; don't try to recover
  from this one.

Every 401 body is `{ "error": "missing_token" | "token_expired" | "invalid_token", "message": string }`.

`GET /me` — optional, useful only as a "is my token working" diagnostic.
- Success `200`: `{ "auth": { "distributor_id": string, "client_id": string } }`
  — note it's nested under `auth`, not flat.

## Profile

`GET /distributors/me`
- Requires auth. Scoped to the logged-in distributor automatically.
- Success `200`: `{ "distributor": { "id", "name", "phone", "business", "city", "years_as_distributor" } }`
- `name` and `phone` are real, always-populated data (existing columns).
- `business`, `city`, `years_as_distributor` are **internal-test-phase-only**
  fields — `string | null`, `string | null`, `number | null` respectively.
  There's no import/CRM-sync mechanism to populate these from real IFB
  distributor data yet, so today they only carry hand-seeded test values
  (`prisma/seed.ts`). Treat `null` as "not set," not an error — this will
  keep being `null` for any distributor added outside the seed script until
  a real provisioning flow exists.

## Questions

`GET /distributors/me/questions`
- Requires auth. Scoped to the logged-in distributor's client automatically.
- Optional query param `?language=en|hi|mr` — overrides the distributor's
  stored `language_pref` for this call only (nothing is written back to the
  distributor record). Omit it to get `language_pref`'s language, same as
  before this param existed. An unsupported/missing value falls back to
  English, same fallback `language_pref` itself already gets.
- Success `200`: `{ "questions": [ { "id", "index", "is_branded", "text", "talking_points", "vo_playback_url", "updated_at" }, ... ] }`
- Ordered by `index`. **Count and content vary per client** — no fixed
  number, no fixed text. Don't hardcode a question list or count in the app;
  always drive the recording flow off this response.
- **`id` is stable across reorders/edits** — use it to key anything that
  needs to survive the question set changing shape (e.g. bundled
  per-question audio keyed by id, not by `index` or array position).
  `index` is ordering/display only, not a safe identity key: it isn't
  guaranteed to stay 1-based/contiguous forever, even though it happens to
  be for every client seeded today.
- `text` and `vo_playback_url` are already localized server-side to the
  requested/stored language — the app doesn't need to handle language
  selection itself, just display/play what comes back.
- `talking_points` is `string[] | null` — a handful of short (2-4 word)
  on-screen nudges to show during recording, already localized the same way
  as `text`. It's `null` when the resolved language has no nudges yet (Hindi
  and Marathi today — English-only for now, translation is separate work)
  or when the question has none set at all. There's no fallback to English
  text when it's `null` — treat it as "nothing to show," not an error.
- `vo_playback_url` is a fresh presigned S3 URL (1-hour expiry), same
  caching rules as `playback_url` elsewhere in this doc (don't cache the URL
  itself).
- `updated_at` is per-question, bumped whenever that question's text,
  talking_points, or VO audio changes — same local-first pattern as
  `segments`/`rendered-videos` below: compare against your locally cached
  value, only re-sync (refetch text, get a fresh `vo_playback_url`,
  re-download the audio) the specific questions whose `updated_at` changed,
  skip the rest. There's no separate per-field timestamp — a text-only edit
  and a VO-only edit both bump the same field, so a mismatch just means
  "something on this question changed," not which part.
- Call this before starting the recording flow — `question_index` values
  used in the upload endpoints below must be one of the `index` values this
  returns for the current client, not an assumed 1–N range.

## Recording upload flow

Two-step: get a presigned URL, PUT the video to it directly, then tell the
backend it's done.

`POST /segments/upload-url`
- Requires auth.
- Body: `{ "question_index": number }` — must be an `index` value returned by
  `GET /distributors/me/questions` for this client (not an assumed range).
- Success `200`: `{ "upload_url": string, "video_key": string }`
- **Save `video_key` from this response** — it must be sent back unchanged
  in the `confirm` call below. It's an opaque string; don't try to construct
  or parse it.
- Failure `400`: `{ "error": "question_index must be a positive integer" }`
  (malformed) or `{ "error": "No question configured at index N for this client" }`
  (well-formed but not one of this client's questions).

Then: `PUT` the raw video file bytes directly to `upload_url` (this goes
straight to S3, not to this backend). No specific headers are required by
the signed URL itself.

`POST /segments/confirm`
- Requires auth.
- Body: `{ "question_index": number, "duration": number, "trim_start_ms"?: number|null, "trim_end_ms"?: number|null, "capture"?: object }`
  — `duration` is the clip length in seconds (a plain number, not a
  string), must be > 0. `capture` is optional and stored as-is, not
  validated field-by-field: `{ "file_size_bytes": number, "width":
  number|null, "height": number|null, "fps": number|null, "codec": string,
  "device_model": string, "os_version": string }` — what the device
  actually captured, kept for later analysis of real distributor phones. A
  missing or malformed `capture` never fails the confirm call.
- `trim_start_ms`/`trim_end_ms` are absolute offsets (ms) into the source
  clip, chosen in Review & Trim. The app sends both as `null` (not `0`/full
  duration) when the person never adjusted the trim, so `null` means
  "use the full clip," not "trim to nothing." Either may be omitted
  entirely instead of sent as `null` — omitted leaves whatever's already
  stored on the segment untouched (same convention as `capture`), `null`
  explicitly clears it to "full clip." Must be a non-negative number (or
  `null`/omitted); `trim_end_ms` must be greater than `trim_start_ms` when
  both are numbers.
- **`video_key` is no longer read from the request body** — the backend
  derives it itself from the token's `distributor_id`/`client_id` plus
  `question_index` (same value `upload-url` already returned you, just no
  longer trusted from the client). Still fine to send it, it's just ignored
  now — this was a security fix (a client could otherwise confirm a key
  belonging to a different distributor), not a shape change you need to act
  on.
- Success `200`: `{ "segment": { "id", "distributor_id", "question_index", "video_key", "status", "duration_seconds", "created_at", "updated_at" } }`
  — the app doesn't need to do anything with this beyond knowing it
  succeeded; the same data comes back (fresher) from the read endpoints
  below.
- Failure `400`: `{ "error": "question_index must be a positive integer" }`,
  `{ "error": "No question configured at index N for this client" }`,
  `{ "error": "duration must be a positive number" }`,
  `{ "error": "trim_start_ms/trim_end_ms must be a non-negative number or null" }`,
  or `{ "error": "trim_end_ms must be greater than trim_start_ms" }` depending
  on which field is missing/invalid.
- Failure `404` (upload didn't actually reach S3 — safe to retry, nothing
  was written): `{ "error": "video_not_found", "message": "The uploaded video could not be found in storage. Please retry the upload." }`
- Calling `confirm` again for the same `question_index` (a retake) updates
  the existing segment rather than creating a duplicate — safe to call more
  than once.

## Read endpoints (My Videos screen)

Both scoped to the logged-in distributor automatically (from the token) —
no ID needs to be passed in.

`GET /distributors/me/segments`
- Success `200`: `{ "segments": [ { "question_index", "status", "playback_url", "duration_seconds", "created_at", "updated_at" }, ... ] }`
- **This is an object with a `segments` key, not a bare array.**
- 0–5 entries — only for questions actually uploaded, no placeholder rows
  for ones not yet recorded.
- `status` is one of: `uploaded`, `transcribing`, `transcribed`, `failed`.
- `playback_url` is a fresh presigned S3 URL (1-hour expiry), regenerated
  on every call — don't cache the URL itself, only the video bytes.
- **Local-first pattern**: compare this response's `updated_at` per
  `question_index` against what you last synced. Match → play the local
  file, no network fetch needed. Mismatch, or no local file → use
  `playback_url`.
- **This is also the source of truth for "confirmed on the server" after a
  reinstall or cleared local storage**, where local state can't be trusted
  at all. A `question_index` present in this array means `POST
  /segments/confirm` has succeeded for it server-side (segments only ever
  appear here starting at `status: "uploaded"`, which only `confirm`
  produces — nothing shows up from an upload that only completed the `PUT`
  to S3). A `question_index` absent from this array means "not yet
  confirmed" — safe to treat as if recording hasn't happened, whether that's
  actually true or the confirm call just never landed. No separate endpoint
  or field is needed for this; diff this response's `question_index` set
  against `GET /distributors/me/questions`' full set to rebuild local
  recording-flow state from scratch.

`GET /distributors/me/rendered-videos`
- Success `200`: `{ "rendered_videos": [ { "question_index", "status", "playback_url", "updated_at" }, ... ] }`
- **Also an object wrapper, also plural/array** — a distributor can have
  multiple rendered reels (one per question), this is not a single object.
- `status` is one of: `rendering`, `rendered`, `failed`.
- `playback_url` is `null` until `status === "rendered"` — the file
  genuinely doesn't exist in S3 before that, this is not an error to
  surface to the user.
- Empty array `[]` is normal for a distributor with no completed renders
  yet — not an error state.
- Same local-first/`updated_at` caching pattern as segments, once a reel is
  downloaded.
- A question that was uploaded but has no entry here yet just means its
  render hasn't started/finished — check the `segments` response for that
  question's `status` to know if it's still processing.

## Known, deliberate constraints — not bugs, don't build around them differently

- **Questions are backend-configured per client now, not hardcoded in the
  app.** All questions returned by `GET /distributors/me/questions` are
  fully active — record and render for any of them. Don't port the app's
  old `PLACEHOLDER_QUESTIONS` list forward; drive the question set (text,
  count, order, VO audio) entirely from that endpoint's response.
- **Rendered reels currently come out at a fixed duration** regardless of
  the source clip's actual length — a known limitation being fixed on the
  backend, not something the frontend needs to account for.
- **Reel rendering is disabled for this build** (`ENABLE_REEL_RENDERING` env
  var — the branded template isn't ready yet). While it's off,
  `transcribe_segment` never queues `render_segment`, so
  `GET /distributors/me/rendered-videos` always returns
  `{ "rendered_videos": [] }` — expected, not a bug. `Segment.status` still
  reaches `transcribed` normally; there's no separate "render skipped"
  status. The frontend has its own independent
  `EXPO_PUBLIC_ENABLE_REEL_RENDERING` flag — keep both in sync.
- **Error responses are always `{ "error": string }`**, sometimes with an
  additional `message` field for user-facing detail (only currently true
  for the `video_not_found` case above).

---

## Internal admin/reporting surface — NOT for the mobile app

Everything below is gated behind `ENABLE_DASHBOARD_ENDPOINTS` (default
**off** — routes aren't registered at all when off, a request 404s the same
as any unknown path, never a 403 that would confirm they exist). This is its
own flag, separate from `ENABLE_DEV_ENDPOINTS` — the older, more generic
"internal/debug route" flag, which nothing is gated behind as of this
rewrite (its one route, `GET /segments/sentiment`, was removed now that the
routes below supersede it). `ENABLE_DEV_ENDPOINTS` is left in the codebase,
unused, for a future genuinely internal/debug-only route that isn't part of
this admin/reporting surface — don't repurpose it for a new dashboard route
instead of `ENABLE_DASHBOARD_ENDPOINTS`.

Scoped by `client_id`, not the caller's own `distributor_id` — same auth
(`Authorization: Bearer <token>`, any of that client's seeded distributor
accounts) as everything above, but every route here reads across **all**
distributors under that client, not just the caller. This is intentional
(see `src/routes/dashboard.ts`'s comment): it's internal/company data, no
distributor should see moderation/complaint judgements about themselves or
anyone else. Stand-in for `backend-plan.html`'s Phase 7 `GET /clients/:id/
insights` until real admin auth exists — not a permanent shape, don't build
a production admin frontend against this without checking it's still
current.

All routes here are **read-only, SQL-aggregated (except `GET /dashboard/
response/:segment_id` and `GET /dashboard/questions`, plain Prisma lookups —
not aggregates), no LLM call**. Every count-based stat returns the raw count
alongside any percentage — low-sample buckets (roughly under 10 segments)
are never hidden, just returned as-is so the frontend can decide whether to
flag them thin.

**Not built** (deliberately deprioritized this phase, ask before adding):
a completion-funnel-across-questions endpoint, city/tenure breakdowns, or
retake-frequency reporting.

**CORS**: this is the only part of the API a browser (as opposed to the
mobile app's native HTTP client, or server-to-server calls) is expected to
call cross-origin — the dashboard UI runs on its own origin/port. Gated by
`CORS_ALLOWED_ORIGINS` (`src/config/env.ts`), a comma-separated allowlist of
exact origins, applied globally in `src/index.ts` via the `cors` package —
**not** a wildcard, and defaults to an empty list (no origin allowed at all)
if unset, so an unset var fails closed rather than silently permitting
everything. No credentials (cookies) are used — the dashboard sends a static
`Authorization: Bearer` token — so `Access-Control-Allow-Credentials` is
never set. Internal-only, two known viewers, so an explicit-but-permissive
list (e.g. the dashboard's local Vite dev origin, `http://localhost:5173`,
plus its deployed origin once that exists) is judged fine for now — tighten,
or scope this to just `/dashboard/*` instead of every route, before this is
ever exposed more widely. Requests with no `Origin` header at all (curl, the
mobile app, server-to-server) are unaffected either way — CORS is a
browser-enforced restriction, not a server-side auth check, and every route
here still requires its own `Authorization: Bearer` token regardless of
origin.

`GET /dashboard/summary`
- Success `200`:
  ```json
  {
    "total_responses": number,
    "completion": {
      "completed": number,
      "rate": number,
      "by_status": { "uploaded"?: number, "transcribing"?: number, "transcribed"?: number, "failed"?: number }
    },
    "sentiment_split": {
      "total_analyzed": number,
      "thresholds": { "positive": ">= 0.3", "negative": "<= -0.3" },
      "positive": { "count": number, "percentage": number },
      "neutral": { "count": number, "percentage": number },
      "negative": { "count": number, "percentage": number }
    },
    "average_sentiment_by_question": [ { "question_index": number, "count": number, "average_sentiment_score": number|null }, ... ]
  }
  ```
- `total_responses` counts every `Segment` row for this client regardless of
  status. `completion.completed`/`rate` is the fraction that reached
  `status: "transcribed"` — the terminal successful state — **not** a
  per-distributor expected-question-count funnel (not computable, see
  `DASHBOARD_DATA_CONTRACT.md` §6).
- `sentiment_split` and `average_sentiment_by_question` are computed only
  over segments with a `sentiment_result` (`total_analyzed`, which is
  usually ≤ `completion.completed`).
- `positive`/`negative`/`neutral` thresholds are fixed cutoffs on
  `sentiment_score` (`src/routes/dashboard.ts`), not derived from the data.

`GET /dashboard/wordcloud?question_index=N&limit=100`
- Both query params optional. `question_index` must be a positive integer if
  given (`400` otherwise); omit it to pool every question. `limit` caps
  returned words (default 100, max 500).
- Success `200`: `{ "question_index": number|null, "transcript_count": number, "words": [ { "word": string, "count": number }, ... ] }`
  sorted by `count` descending.
- Code-only tokenization (no LLM) — Unicode letter-run matching (handles
  Devanagari as well as Latin script), lowercased, English/Hindi/Marathi
  stopwords stripped. All three languages' stopword lists are applied to
  every transcript regardless of its detected language, since real
  transcripts here are frequently code-mixed (see `src/services/
  wordFrequency.ts`) — a single-language list would silently under-filter
  the other two languages' function words.

`GET /dashboard/themes`
- Success `200`: `{ "themes": [ { "theme": string, "count": number }, ... ], "themes_with_complaint": [ same shape, filtered to contains_complaint: true segments ] }`
- `theme` values come from the fixed 11-item vocabulary in
  `src/services/gemini.ts` (`THEME_VALUES`) for any segment analyzed after
  the 2026-09-16 prompt rewrite — segments analyzed before that date may
  still carry old free-text theme strings (that prompt had no fixed list).

`GET /dashboard/theme-sentiment`
- Success `200`: `{ "themes": [ { "theme": string, "count": number, "average_sentiment_score": number }, ... ] }`
- Per-theme average `sentiment_score`, across segments where that theme
  appears — the positive/negative lean per theme, computed from existing
  data (no separate valence field).

`GET /dashboard/highlights?question_index=N&limit=10`
- `question_index` is **required** — `400` if missing or not a positive
  integer. `limit` optional (default 10, max 50).
- Success `200`: `{ "question_index": number, "highlights": [ { "segment_id": string, "best_quote": string, "highlight_score": number, "sentiment_score": number, "language": string|null, "distributor_name": string, "actionable_feedback": string|null }, ... ] }`
  ordered by `highlight_score` descending.
- **`segment_id`** (added 2026-09-17) — pass it to `GET /dashboard/
  response/:segment_id` below to open that segment's full detail.
- **`distributor_name` is a deliberate, endpoint-specific exception to this
  surface's otherwise "no identity" design** (added 2026-09-17) — this
  dashboard is viewed only internally by two known people, never published
  to IFB or any external audience, and most dry-run participants are staff/
  friends/family the viewers already know personally, so withholding the
  name here served no purpose. **This does not extend to any other endpoint
  or any future client-facing surface** — a fresh decision is needed before
  carrying name exposure anywhere else.
- **`actionable_feedback`** is `null` unless `contains_complaint` was true
  for that segment (same population rule as the `SentimentResult` column
  itself, §2/DASHBOARD_DATA_CONTRACT.md) — added for a complaints-register
  UI, not filtered to complaint segments only (a highlight can have a
  populated `actionable_feedback` alongside an overall-positive
  `sentiment_score`, same as the underlying column allows).
- **Excludes `moderation_flag: true` segments** — this endpoint surfaces
  quotable highlights, which is exactly what `moderation_flag` gates
  (unsuitable for external/client-facing use). Segments analyzed before the
  2026-09-16 prompt rewrite have that field under the *old, inverted*
  meaning (`true` used to mean "safe to publish") — until those rows are
  reprocessed, this filter will incorrectly exclude old safe content and
  never incorrectly include old unsafe content (the failure mode is
  under-inclusion, not a moderation leak).

`GET /dashboard/response/:segment_id`
- Single-segment lookup, not a list — full transcript text plus the
  complete `sentiment_result` record for one specific segment, for drilling
  into one individual response's full detail from the UI (e.g. clicking
  through from `/dashboard/highlights` or `/dashboard/wordcloud`).
- `segment_id` (path param) must be a well-formed UUID — `400`
  `{ "error": "segment_id must be a valid UUID" }` otherwise.
- Scoped by the caller's `client_id`, same as every other `/dashboard/*`
  route — a `segment_id` that exists but belongs to a different client is
  indistinguishable from one that doesn't exist at all (both `404`).
- Failure `404`: `{ "error": "segment_not_found" }` — no `sentiment_result`/
  `transcript` existing yet for an otherwise-valid, in-scope segment is
  **not** a 404: `transcript`/`sentiment` are simply `null` in that case,
  so the UI can show "not yet analyzed" rather than treating it as an error.
- Success `200`:
  ```json
  {
    "segment_id": string,
    "question_index": number,
    "transcript": { "text": string, "language_detected": string, "language_probability": number|null } | null,
    "sentiment": {
      "sentiment_score": number, "themes": string[], "emotional_tone": string|null,
      "summary": string, "best_quote": string, "is_relevant": boolean,
      "moderation_flag": boolean, "contains_profanity": boolean|null,
      "contains_complaint": boolean, "actionable_feedback": string|null,
      "highlight_score": number, "extracted": object|null
    } | null
  }
  ```
- No distributor identity field on this one — unlike `/dashboard/highlights`
  above, exposing a name here wasn't asked for and isn't assumed; the UI is
  expected to already know which distributor/segment it's drilling into
  from wherever it linked in from.

`GET /dashboard/questions` (added 2026-09-17)
- Per-client question list — replaces a raw "type a question number" input
  with real labeled data for any UI that needs to pick a `question_index`
  (e.g. for `/dashboard/wordcloud` or `/dashboard/highlights` above).
- Success `200`: `{ "questions": [ { "index": number, "text": { "en": string, "hi": string, "mr": string } }, ... ] }`
  ordered by `index`.
- **Not localized** to one language like `GET /distributors/me/questions`
  is (that endpoint is for the recording app — it picks one language for
  the requesting distributor). This one always returns all three, so the
  dashboard can label a question correctly regardless of which language a
  given response happens to be in.
- No `id`, `talking_points`, or VO fields — this endpoint is deliberately
  minimal (just enough to label a question picker), not a mirror of
  `GET /distributors/me/questions`.

`GET /dashboard/teacher-impact`
- Success `200`: `{ "total_analyzed": number, "mentions_teacher": { "count": number, "percentage": number }, "teacher_contribution": [ { "teacher_contribution": string, "count": number, "percentage": number }, ... ] }`
- `teacher_contribution` percentages are of `mentions_teacher.count`, not
  `total_analyzed`. Only populated for segments analyzed after the
  2026-09-16 prompt rewrite (`extracted.mentions_teacher` didn't exist
  before then).

`GET /dashboard/technical`
- Internal/QA use — not participant-facing content.
- Success `200`:
  ```json
  {
    "devices": [ { "device_model": string|null, "os_version": string|null, "count": number }, ... ],
    "resolutions": [ { "width": number|null, "height": number|null, "count": number }, ... ],
    "average_duration_by_question": [ { "question_index": number, "average_duration_seconds": number, "count": number }, ... ]
  }
  ```
- `devices`/`resolutions` only cover segments with a non-null
  `capture_metadata` (best-effort, client-reported — see `POST /segments/
  confirm` above); a segment recorded before that field existed, or whose
  client omitted it, isn't counted in either breakdown.

`GET /dashboard/extraction-quality`
- A meta-view of the pipeline itself (is the model producing usable output),
  not the testimonial content.
- Success `200`:
  ```json
  {
    "total_analyzed": number,
    "is_relevant": { "count": number, "percentage": number },
    "contains_profanity": { "known_count": number, "count": number, "percentage": number },
    "highlight_score_distribution": {
      "thresholds": { "high": ">= 0.85", "mid": ">= 0.4", "low": "< 0.4" },
      "high": { "count": number, "percentage": number },
      "mid": { "count": number, "percentage": number },
      "low": { "count": number, "percentage": number }
    }
  }
  ```
- `contains_profanity.percentage` is `count / known_count`, not
  `total_analyzed` — `known_count` excludes segments analyzed before this
  column existed (nullable) so their absence doesn't dilute the rate.
