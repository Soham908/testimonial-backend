# Backend API Contract — for frontend integration

Scope: only the endpoints the mobile app actually needs to call. The backend
has other routes (a temporary admin/test-only sentiment endpoint, a health
check) that are deliberately left out — not part of this contract. The
sentiment endpoint (`src/routes/dev.ts`) is gated behind `ENABLE_DEV_ENDPOINTS`
(default off) and isn't registered at all unless that's explicitly set —
the mobile app never calls it and never should.

Every shape below is copied directly from the real route handlers in the
backend repo (`src/routes/login.ts`, `src/routes/me.ts`,
`src/routes/segments.ts`, `src/routes/distributors.ts`) as of **2026-07-27**
— not guessed from the design doc or build notes. You don't need that repo
open to use this file. If the backend changes after this date, this copy can
go stale; re-pull it from the backend side rather than editing it here from
assumptions.

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

Every request after login must include:
```
Authorization: Bearer <token>
```
Missing or invalid token on any route below → `401`, no data returned,
before any handler logic runs.

`GET /me` — optional, useful only as a "is my token working" diagnostic.
- Success `200`: `{ "auth": { "distributor_id": string, "client_id": string } }`
  — note it's nested under `auth`, not flat.

## Questions

`GET /distributors/me/questions`
- Requires auth. Scoped to the logged-in distributor's client automatically.
- Optional query param `?language=en|hi|mr` — overrides the distributor's
  stored `language_pref` for this call only (nothing is written back to the
  distributor record). Omit it to get `language_pref`'s language, same as
  before this param existed. An unsupported/missing value falls back to
  English, same fallback `language_pref` itself already gets.
- Success `200`: `{ "questions": [ { "id", "index", "is_branded", "text", "vo_playback_url" }, ... ] }`
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
- `vo_playback_url` is a fresh presigned S3 URL (1-hour expiry), same
  caching rules as `playback_url` elsewhere in this doc (don't cache the URL
  itself).
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
- Body: `{ "question_index": number, "duration": number, "capture"?: object }`
  — `duration` is the clip length in seconds (a plain number, not a
  string), must be > 0. `capture` is optional and stored as-is, not
  validated field-by-field: `{ "file_size_bytes": number, "width":
  number|null, "height": number|null, "fps": number|null, "codec": string,
  "device_model": string, "os_version": string }` — what the device
  actually captured, kept for later analysis of real distributor phones. A
  missing or malformed `capture` never fails the confirm call.
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
  `{ "error": "No question configured at index N for this client" }`, or
  `{ "error": "duration must be a positive number" }` depending on which
  field is missing/invalid.
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
