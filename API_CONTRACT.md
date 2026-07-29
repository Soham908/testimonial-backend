# Backend API Contract — for frontend integration

Scope: only the endpoints the mobile app actually needs to call. The backend
has other routes (a temporary admin/test-only sentiment endpoint, a health
check) that are deliberately left out — not part of this contract.

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

Every request after login must include:
```
Authorization: Bearer <token>
```
Missing or invalid token on any route below → `401`, no data returned,
before any handler logic runs.

`GET /me` — optional, useful only as a "is my token working" diagnostic.
- Success `200`: `{ "auth": { "distributor_id": string, "client_id": string } }`
  — note it's nested under `auth`, not flat.

## Recording upload flow

Two-step: get a presigned URL, PUT the video to it directly, then tell the
backend it's done.

`POST /segments/upload-url`
- Requires auth.
- Body: `{ "question_index": number }` — integer 1–5.
- Success `200`: `{ "upload_url": string, "video_key": string }`
- **Save `video_key` from this response** — it must be sent back unchanged
  in the `confirm` call below. It's an opaque string; don't try to construct
  or parse it.
- Failure `400`: `{ "error": "question_index must be an integer between 1 and 5" }`

Then: `PUT` the raw video file bytes directly to `upload_url` (this goes
straight to S3, not to this backend). No specific headers are required by
the signed URL itself.

`POST /segments/confirm`
- Requires auth.
- Body: `{ "question_index": number, "video_key": string, "duration": number }`
  — `video_key` is exactly what `upload-url` returned; `duration` is the
  clip length in seconds (a plain number, not a string).
- Success `200`: `{ "segment": { "id", "distributor_id", "question_index", "video_key", "status", "duration_seconds", "created_at", "updated_at" } }`
  — the app doesn't need to do anything with this beyond knowing it
  succeeded; the same data comes back (fresher) from the read endpoints
  below.
- Failure `400`: `{ "error": "question_index must be an integer between 1 and 5" }`,
  `{ "error": "video_key is required" }`, or `{ "error": "duration is required" }`
  depending on which field is missing/wrong-typed.
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

- **Only question indices 1–3 are active right now.** `upload-url` and
  `confirm` will accept any integer 1–5, but questions 4 and 5 have no
  render configuration yet and will fail at the render step if used — this
  matches the app's own `PLACEHOLDER_QUESTIONS`, where 4 and 5 are already
  commented out. Keep both sides in sync if either changes.
- **Rendered reels currently come out at a fixed duration** regardless of
  the source clip's actual length — a known limitation being fixed on the
  backend, not something the frontend needs to account for.
- **Error responses are always `{ "error": string }`**, sometimes with an
  additional `message` field for user-facing detail (only currently true
  for the `video_not_found` case above).
