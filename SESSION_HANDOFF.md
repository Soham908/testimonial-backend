# Session handoff — 2026-08-13/14

Continuity doc for picking this up on a different laptop. This is a snapshot of
one chat session's discussion, not a permanent project doc — delete it once
you've absorbed it into wherever it belongs (or into a fresh session's
context), or keep updating it if you're bouncing between machines regularly.

Repo state at time of writing: all 9 `BUILD_STEPS.md` steps are done, working
tree clean, `master` up to date with `origin`. The full backend pipeline
(login → upload → confirm → transcribe → sentiment → render → read endpoints)
has been verified end-to-end against real video.

## 1. Mobile → backend context transfer (received this session)

A handoff summary came in from a separate mobile-app (`video_project`,
sibling repo — **note:** the user's IDE this session had a file open at
`C:\dev\video-testimonial\AppFlow.tsx`, a *different* path than what
CLAUDE.md documents as the mobile repo location (`C:/dev/video_project`) —
worth confirming with the user which path is current/correct before trusting
either blindly). Key points from that handoff:

- **Logout** — client-side only (clears stored JWT), no backend endpoint
  involved. No action needed unless server-side token revocation before the
  30-day JWT expiry becomes a requirement later.
- **Status quo confirmed** — mobile is still on 5 questions, still calling
  the exact documented endpoints (`/segments/upload-url`, `/segments/confirm`,
  the two read endpoints), no shape changes.
- **Pending, not decided — 7-question restructure.** Mobile side debating
  3 reel-eligible + 4 survey-only questions. Also unresolved: whether the 3
  reel-eligible answers become **one merged reel** (the boss's preference) or
  stay as **3 separate reels** (the user's own preference, since it matches
  how rendering already works). The merged-reel option would directly
  conflict with this repo's locked decision ("one branded reel per question,
  not one merged video" — render fires per-segment). **Do not build toward
  either variant until this is actually decided** — if/when it is, confirm
  which variant won before touching `render_segment`/job-pipeline trigger
  logic.
- **Pending — profile editing not persisted.** Name/business/years shown on
  rendered videos is mock-only on the mobile frontend. No backend
  persistence exists or has been requested. Don't assume it's wired if it
  comes up in a future task.

(Both of these were also saved to this Claude Code project's cross-session
memory, so a fresh session should already know them without this file.)

## 2. Full backend pending/deferred list (this repo's own, not mobile's)

Sourced from `CLAUDE.md`'s "note for me" section plus deviation notes in
`BUILD_STEPS.md` steps 6/7. Roughly in priority order as discussed this
session:

1. **Dynamic composition duration (highest severity, actively destroying
   content today).** The nexrender template's answer segment has a
   static/fixed duration — a real test render came out 30s despite a ~58s
   source clip, silently truncating the answer. Needs to be driven by actual
   footage length instead. User has already worked out an approach from
   prior testing, not yet implemented here.
2. **Crop/zoom on rendered output.** First real render came out zoomed in —
   answer footage got cropped/scaled to fill the template's expected frame
   rather than fitting cleanly. Root cause: different phones produce
   different native aspect ratios, and there's no normalization step before
   footage reaches the template. See §3 below — just discussed this session.
3. **Caption styling / branded template quality.** Both seeded clients
   currently share one rough, unbranded nexrender template — no real
   per-client branding yet.
4. **Gemini → Claude sentiment swap.** Step 6 used Gemini as a testing-phase
   stand-in (free org access); Claude was always the intended production
   model. `backend-plan.html` still documents Claude and needs a doc-accuracy
   pass once the actual swap happens.
5. **WhatsApp-servable video size.** Rendered reels are full-size (~45MB),
   not compressed/sized for messaging distribution. Not started.
6. **Admin dashboard.** Forgotten from scope entirely. `sentiment_results`
   (score, themes, summary, best quote, relevance/moderation/complaint flags)
   is being written correctly per segment but has no real admin-facing
   surface — only a temporary, undocumented test endpoint
   (`GET /segments/sentiment`). Needs to be designed and built once that
   phase starts.
7. **Caption burn-in double-read + extra S3 copy.** Deliberate speed-over-
   elegance tradeoff from step 7 — reads the segment video twice (audio
   extraction, then caption burn) and stores an extra full-size intermediate
   in S3. Fix direction already decided: burn captions on nexrender's *final*
   output instead, using fixed per-question time offsets (intro VO durations
   are static) — cuts it to one extra pass, no extra stored video.
8. **`render_segment` blocks a worker for the whole render** by polling
   nexrender-cloud synchronously instead of using a webhook. Real redesign
   (public HTTPS endpoint, signature verification, split submit/complete
   phases, fallback timeout). Explicitly deprioritized until concurrent
   render volume actually makes worker capacity the bottleneck — also,
   nexrender-cloud's webhook support isn't confirmed in their docs yet.
9. **Orphaned S3 objects on force-quit mid-upload.** If the mobile app is
   killed mid-upload, the PUT may never finish and `/segments/confirm` may
   never get called — no backend-side detection exists today (confirm is
   entirely client-driven). Standard fix: S3 `ObjectCreated` event → SQS/
   Lambda backstop. Whether it's worth building depends on whether the
   mobile app has real OS-level background transfer (iOS background
   URLSession / Android WorkManager) — **check that in `video_project`
   first**, don't build this blind.

## 3. Open design question — video normalization (discussed this session)

Asked: should normalizing video (fixing aspect ratio inconsistencies across
phones, WhatsApp-style) happen frontend (on-device, mobile) or backend?

**Recommendation given: backend.** Add it as an ffmpeg pass in this repo's
render pipeline, right before the video reaches nexrender — same stage that
already does caption burn-in. Reasoning: the ffmpeg pipeline/infra already
exists here; doing it server-side forces every device's footage to one fixed
target aspect/resolution deliberately and centrally, rather than letting
nexrender's template implicitly (and badly) crop it, which is the actual
cause of pending item #2 above. On-device normalization would mean real new
engineering in the separate mobile repo (ffmpeg-kit-react-native or similar),
battery/CPU cost during recording, and debugging across device fragmentation
instead of in one controlled place — and WhatsApp itself normalizes/
transcodes server-side for the same reason.

Tradeoff acknowledged: costs extra backend processing time per segment
(another ffmpeg pass) and doesn't reduce upload bandwidth from the phone —
but that's consistent with this repo's existing "handle everything once a
segment leaves the device" scope, not a fight against it.

**Not yet implemented** — this was a design recommendation only, no code
written this session.

## 4. Bigger open question — recording flow UX (already in CLAUDE.md, not new)

Not new this session, but still unresolved and worth knowing before doing
mobile-adjacent backend work: the user is weighing the current single-flow
"all 5 questions in one automated take" recording UX (which has real UX
problems — no per-answer review, no way to re-approach the screen naturally,
not truly automated) against a one-question-at-a-time flow with per-answer
review/retake before moving on. The user's own framing: since the end user
will likely only ever record once (no repeat campaigns in the common case),
optimize for output *quality* over recording *smoothness* — a little
friction per question is an acceptable tradeoff for a better result. This is
a live decision, not a task — no action needed here, but if it lands, it
would affect segment arrival timing on the backend side (still one segment
per question, so likely low backend impact either way, but confirm before
assuming that).

## 5. What to do first on the other laptop

- `git pull` — this file included once pushed (see note below).
- Re-read `CLAUDE.md` and `BUILD_STEPS.md` — both already contain everything
  in §2 in more detail; this file is a session-specific index into them, not
  a replacement.
- If picking up the video normalization work (§3): no code exists yet, start
  from scratch in `src/services/ffmpeg.ts` alongside the existing
  `burnCaptions` function, following the same existence-check idempotency
  pattern the rest of the pipeline uses.
- If picking up dynamic composition duration (#1 in §2, the highest-severity
  item): the user says they already have an approach worked out from prior
  testing — ask them for it rather than re-deriving one, before touching
  `src/services/nexrender.ts` or the template config.

---

## Session handoff — 2026-08-17: security/best-practices audit + fixes

Full pass over the whole repo (`git status` was clean going in — no other
work in flight): routes, middleware, services, jobs, worker, schema, and
every project doc, checking for setup problems, best-practices gaps, and
security issues, then fixing what was safe to fix directly. Not a
`BUILD_STEPS.md` step — general hardening, done as its own scoped task.

**Environment note**: `node_modules/` didn't exist in this checkout at all —
nothing here had ever actually been typechecked or built in this working
directory before today. Ran `npm install`, generated the Prisma client
(schema-only, no real DB connection needed for that), and confirmed `tsc
--noEmit` and `npm run build` both pass clean, before and after every change
below.

### Fixed — security

1. **IDOR in `POST /segments/confirm`** (`src/routes/segments.ts`) — the
   real finding. The route trusted a client-supplied `video_key` as-is.
   Since keys are fully predictable
   (`clients/{client_id}/distributors/{distributor_id}/segments/{n}.mp4`),
   any authenticated distributor could confirm a key belonging to a
   *different* distributor and have that video recorded as their own
   segment — cross-tenant data exposure. Fixed: `video_key` is now always
   derived server-side from the caller's own `req.auth` (`client_id` +
   `distributor_id` + `question_index`); the client-sent value is no longer
   read at all. `API_CONTRACT.md`'s `/segments/confirm` section updated to
   match — `video_key` is no longer part of the request body contract
   (still harmless if the mobile app keeps sending it, just ignored).
2. **JWT algorithm confusion** — `jwt.sign`/`jwt.verify`
   (`src/routes/login.ts`, `src/middleware/auth.ts`) didn't pin an
   algorithm. Both now explicitly use `HS256`.
3. **Login timing side-channel** (`src/routes/login.ts`) — requests for an
   unknown username skipped `bcrypt.compare` entirely, making them
   measurably faster than a wrong-password request for a real username —
   an attacker could use that timing gap to enumerate valid usernames.
   Fixed: always compares against a real hash, falling back to a fixed
   dummy hash (`DUMMY_HASH`, same cost factor as real accounts) when the
   account isn't found.
4. **No rate limiting anywhere** — added `express-rate-limit`: a strict
   limiter on `POST /login` (10 requests/15min/IP,
   `src/routes/login.ts`), and a general one across the whole API (300
   requests/15min/IP, `src/index.ts`). `API_CONTRACT.md` documents the new
   `429` response on `/login`.
5. **No security headers** — added `helmet()` in `src/index.ts`.
6. **Stack-trace leakage risk** — there was no error-handling middleware in
   `src/index.ts`, so an uncaught exception fell through to Express's
   *default* handler, which includes the stack trace in the response body
   unless `NODE_ENV` is exactly `"production"` — easy to forget on a real
   deploy. Added a proper error-handling middleware: logs server-side,
   returns a generic `{ error: "internal_server_error" }` (`500`), with a
   special case for malformed-JSON bodies (`400`, `invalid_json`) instead
   of masking those as server errors.
7. **Unvalidated `SESSION_SECRET` strength** — `src/config/env.ts` now
   fails fast at startup if it's under 32 characters (JWTs are the only
   thing gating `req.auth`, so a short/guessable secret makes every session
   forgeable). **This can break an existing local `.env` if that secret is
   shorter than 32 chars — check/regenerate it before assuming a "missing
   env var"-shaped startup failure is something else.**
8. Added `app.set("trust proxy", 1)` in `src/index.ts` — App Runner (the
   planned eventual host, per `CLAUDE.md`) terminates TLS and proxies in
   front of the app; trusting the first hop makes `req.ip` and the rate
   limiter above key on the real client IP instead of the proxy's. Harmless
   locally (no proxy in front in dev, so behavior is unchanged there).

### Fixed — correctness / cleanup

9. `duration` from the client (`src/routes/segments.ts`) was written
   straight into an `Int` column (`duration_seconds`) with no rounding or
   positivity check — a float duration from the mobile app would have
   thrown at the Prisma layer. Now validated as a positive finite number
   and rounded server-side before the write.
10. `.gitignore` listed `.env.example` as ignored, even though it's
    intentionally committed (confirmed via `git ls-files` — it was already
    tracked). Misleading, and would silently block re-adding it if it were
    ever deleted. Removed that line.
11. `.env.example`'s `NEXRENDER_SERVER_URL` default was missing the `/api`
    path segment — exactly the mistake `learnings.md` already documents
    costing real debugging time in step 7 ("easy to drop by mistake").
    Fixed the example value and added a comment explaining why it matters
    (the API responds just enough without `/api` to make the omission
    non-obvious until a real render call fails).
12. Added a JSON `404` handler in `src/index.ts` (previously fell through
    to Express's default HTML "Cannot GET ..." response).

### Flagged, not touched — needs a judgment call, not a mechanical fix

- **`GET /segments/sentiment`** (`src/routes/segments.ts`) — already
  commented in-code as temporary/test-only, but it's live and scoped only
  by `client_id`, so any distributor can currently see every *other*
  distributor's sentiment/moderation/complaint data under the same client.
  Fine for internal testing; not something to ship without real admin auth
  (same gap `CLAUDE.md`'s "admin dashboard was forgotten" note already
  tracks).
- **Seeded passwords** (`ramesh123` etc., `src/config/seedAccounts.ts`) are
  weak, but that's the documented, deliberate Phase-A tradeoff (replaced
  wholesale by invite-token exchange in Phase B) — not something to patch
  without changing the auth model itself.
- `npm audit` reports 6 vulnerabilities, all inside `prisma`'s own
  dev-tooling transitive deps (`@prisma/dev` → `@hono/node-server`,
  `fast-uri`, `hono`, `valibot`) — none of these are reachable at runtime
  through this app's own code paths. Didn't run `npm audit fix` since it
  could pull in a Prisma version bump; not worth that risk for
  non-runtime-reachable issues.
- No CORS setup — not needed yet since only the mobile app calls this API
  directly (no browser client). Revisit once/if a browser-based admin
  dashboard exists.

### New dependencies

`helmet` and `express-rate-limit` added to `package.json` dependencies (not
dev-only — both run in the request path). `package-lock.json` updated
accordingly.

### Files touched this session

`.env.example`, `.gitignore`, `API_CONTRACT.md`, `package.json`,
`package-lock.json`, `src/config/env.ts`, `src/index.ts`,
`src/middleware/auth.ts`, `src/routes/login.ts`, `src/routes/segments.ts`.

*(Stale note from when this section was written: it said these weren't
committed yet. They were — this is commit `248ff65 "rough audit done"`,
confirmed via `git log` in the next session below.)*

---

## Session handoff — 2026-08-31: video normalization, DB-driven questions,
## per-question sentiment extraction, real render test

Repo state at start: `git status` showed a working tree with several
uncommitted pieces already in flight from **outside this chat session**
(more on that below) plus this session's own new work. Everything described
here is now committed as `2dc91e0 "Move questions to DB, normalize video
orientation, gate dev endpoints"` — `master`, not pushed (never asked to).

### 1. Video normalization — §3 from the 2026-08-13/14 handoff, now DONE

That earlier handoff left this as a design recommendation only, no code.
It's implemented now: `burnCaptions` in `src/services/ffmpeg.ts` no longer
just burns captions — same ffmpeg pass now also normalizes every segment to
the canonical shape (1080×1920, scale-to-fit + pad, `setsar=1`, 30fps,
H.264 High/CRF20/yuv420p, AAC 128k/48kHz/stereo, `+faststart`), fixing the
real bug: source videos are stored landscape with a rotation flag that After
Effects ignores, causing the crop/zoom pending item (#2 in the old §2 list,
see the correction below). Deliberately relies on ffmpeg's automatic
rotation-at-decode (no `transpose`, no `-noautorotate`) so it's
orientation-agnostic across phones, not tuned to one device.

Also accepts `trim_start_ms`/`trim_end_ms` (new nullable columns on
`Segment`) via `-ss`/`-to`, ahead of the app actually sending them — matches
the "auto-suggest snipping the last 2s" idea already in `CLAUDE.md`. Open
design question flagged back to the user, not yet answered: should the
frontend send absolute start/end timestamps (what's implemented) or a
"snip N seconds" value? Recommended absolute start/end since the frontend
already knows its own recorded duration and can compute either shape
client-side, and absolute start/end generalizes to a future manual-trim UI
without a contract change.

Added `scripts/normalize-video.ts` (`npm run normalize-video`) — runs the
same `burnCaptions` command against a local file with no S3/DB/worker
needed, for exactly this kind of verification. Internally serves the local
file over a throwaway loopback HTTP server (with Range support) since
`burnCaptions`'s `-reconnect*` flags are HTTP-only and reject a bare local
path outright.

**Verified live**, not just compiled: ran it against a real phone clip in
`assets/` (1920×1080 container, 90° rotation stored as **Display Matrix
side data**, not the older `rotate` tag — this caught a real gap in the
ffprobe logging, which originally only checked the legacy tag; fixed to
check both). Confirmed output: correct upright portrait orientation,
1080×1920, rotation metadata gone, and a trim window landing exactly where
requested (matched a frame from the trimmed clip against the source at the
same timestamp).

### 2. Correction to old pending item #2 ("crop/zoom on rendered output")

The 2026-08-13/14 handoff's theory was that missing normalization
(different phone aspect ratios) caused nexrender/After Effects to crop
footage. Normalization above fixes that specific mechanism. But a live
render this session (see §5) surfaced a **different, still-open** distortion:
the *rendered output* comes out with correct pixel dimensions (1080×1920)
but tagged `sample_aspect_ratio: 4:3` instead of `1:1`, giving an effective
display aspect ratio of 3:4 instead of 9:16 — any standards-compliant
player will show it visibly squished. Confirmed via `ffprobe` that our own
captioned video (nexrender's *input*) is correctly `SAR 1:1`/`DAR 9:16`, so
this is introduced **inside nexrender's own template/render step**, not by
this repo's code. User's call this session: leave it for now, revisit
later. Whoever picks this up next: don't re-diagnose from scratch, start
from "it's in the After Effects template or nexrender's own encode, not our
ffmpeg pass" and check the template's composition settings first.

### 3. Question configuration moved to the database

New `Question` model (`prisma/schema.prisma`,
migration `20260831140000_add_questions`): per-`client_id`, `index`,
`is_branded`, `text_en`/`text_hi`/`text_mr`, `vo_key_en`/`vo_key_hi`/
`vo_key_mr`, nullable `extraction_spec` Json. Replaces the old hardcoded
`src/config/questions.ts` (deleted) which only had 3 of 5 questions
populated and hard-threw on indices 4/5 — a real problem given IFB's
upcoming engagement needs 7 different questions from the internal test
client's 5.

- `GET /distributors/me/questions` (new, `src/routes/distributors.ts`) —
  returns the caller's client's question set, already localized to the
  distributor's `language_pref` (optionally overridden per-call via
  `?language=en|hi|mr`, added later same session — see `API_CONTRACT.md`).
  Response includes a stable `id` per question (not just `index`) since
  `index` isn't guaranteed to stay a safe identity key if a question set is
  ever reordered.
- `src/routes/segments.ts`'s `question_index` validation changed from a
  hardcoded 1–5 bound to an existence check against the `questions` table
  (`questionExists()`) — otherwise IFB's future indices 6/7 would 400 even
  with valid `Question` rows. Verified live: index 5 now uploads fine,
  index 99 gets a clean 400, never a throw.
- `src/jobs/renderSegment.ts` now looks up `Question` by
  `(client_id, question_index)` instead of the old static maps; only
  throws on a genuinely missing DB row now, not on any index beyond 3.
- Seeded (`prisma/seed.ts`): both dummy clients (IFB, Voltas) get the same
  5 education questions, `is_branded: false`. **VO audio keys are seeded
  but nothing has been uploaded to them** — `static/question-vo/{client_id}/
  {lang}/{index}.mp3` is a real gap, confirmed live this session (§5) when
  a render failed because nexrender couldn't download the VO file. Needs
  real recorded audio per question per language before rendering works for
  real (test placeholders were uploaded and then are still sitting at
  those same S3 keys for the Voltas client, indices 1–2, English only —
  replace them, don't assume they're real).

### 4. Per-question sentiment extraction

New nullable `extracted` Json column on `SentimentResult`
(migration `20260831150000_add_sentiment_extracted`), alongside the
existing nine fixed columns (kept as real columns deliberately — reports
query them constantly). `src/services/gemini.ts`'s `analyzeSentiment` now
takes `(transcriptText, languageDetected, questionText, extractionSpec)`
and builds both the prompt and Gemini's `responseSchema` dynamically from
`extraction_spec` each call — the whole point being that adding a new
extracted field for a question is a `Question.extraction_spec` row edit,
never a migration or code change. Shape:
`{ name, type: "string"|"number"|"boolean", description, nullable? }[]`,
documented in the schema comment and `src/services/gemini.ts`. Malformed
entries are dropped rather than thrown on, so a typo in one question's spec
can't take down the nine core fields every report depends on.

**Verified against the real Gemini API** (key added mid-session): real
ElevenLabs transcript → real Gemini call with a non-null `extraction_spec`
(two test fields) → correct dynamic schema response. Hit a transient
Google-side 503 during testing (model overload, not a bug) — retried
successfully.

### 5. Real end-to-end pipeline test — what broke and why (all environment, not code)

User ran the real worker against a real uploaded video and asked to render
the first 2 segments. Nothing here was a code bug; all four issues were
**a long-running process holding a stale environment from before it was
started** — worth remembering as a pattern, it'll happen again:

1. `spawn ffmpeg ENOENT` in the worker — ffmpeg was installed via `winget`
   *after* the worker's terminal was already open. Fix: fully quit and
   reopen the terminal app (not just a new tab/window in an already-running
   app — notably, a VS Code-hosted terminal doesn't pick up a fresh PATH
   until VS Code itself is fully restarted, not just the terminal pane).
2. `401 Unauthorized - Invalid token` from nexrender-cloud — turned out to
   be two stacked issues: first the key really was wrong (hand-typed, not
   pasted), then after fixing it in `.env`, the *already-running* worker
   process still had the old key in memory (`--env-file` loads once at
   startup). Restarting the worker after any `.env` edit is required, not
   optional — confirmed by directly `curl`-ing nexrender-cloud with the
   current `.env` value to isolate that the key itself was fine before
   concluding the worker was stale.
3. Missing VO audio (see §3 above) — real gap, not an environment issue,
   worked around with test placeholders for this session only.
4. The `SAR 4:3` render distortion (see §2 above).

Once all four were resolved, both renders completed successfully end to
end and landed real files in S3 — confirms the full pipeline (login →
upload → confirm → transcribe → per-question sentiment → render → S3)
works with real credentials, real footage, real APIs.

**Current data state** (Voltas client, distributor "Kumar Sales Corp",
5 segments from this test): q2 and q4 fully transcribed with sentiment;
q1, q3, q5 have transcripts but never completed sentiment (stuck `failed`
from the ffmpeg-PATH/Gemini-503 issues above, before either was resolved).
q1 and q2 have been rendered (test placeholder VO, Voltas' shared rough
template). q3/q5's sentiment step and all of q3/q4/q5's rendering are still
outstanding — not done automatically, `render_segment` was queued manually
for q1/q2 this session rather than through the normal auto-queue trigger.

### 6. Dev-only routes, ownership tests, vitest — NOT this session's work, found already in progress

Partway through this session, `git status` showed additional
modifications/new files this chat never touched: `src/routes/dev.ts` (new),
`src/index.ts` and `src/config/env.ts` changes to mount it, `tests/`
(`dev-endpoints.test.ts`, `ownership.test.ts`, `setup.ts`), `vitest.config.mts`,
and `vitest`/`supertest` added to `package.json`. Investigated rather than
blindly committing or reverting: this is a real, well-reasoned security fix
— the old `GET /segments/sentiment` test endpoint (flagged as a known gap
in the 2026-08-17 audit above) returned client-wide sentiment/moderation/
complaint data to *any* distributor of that client, not scoped to the
caller. It's been moved off the app's normal routers into
`src/routes/dev.ts`, gated behind a new `ENABLE_DEV_ENDPOINTS` flag
(default off, `src/config/env.ts`) — off means the route is never
registered at all (plain 404), not merely rejected (which would leak that
it exists via a 403). Real regression tests cover both the ownership leak
class of bug generally (`tests/ownership.test.ts`) and this flag
specifically (`tests/dev-endpoints.test.ts`).

Found one unrelated stray line in the same working tree — a bare
`console.log('hello');` in `src/routes/login.ts`, inside the login handler,
not connected to any of the above. Removed before committing; not part of
the dev-endpoints work, looked like leftover manual debugging (matches an
IDE-file-open notification for that exact file earlier in this session).

Verified `tsc --noEmit` clean and `npx vitest run` (6/6 passing) with this
work integrated alongside this session's own changes before committing
everything together in one commit.

**If you're picking this up not knowing where this came from**: it's not
explained anywhere in this chat's history — either a parallel Claude Code
session, or the user's own direct edit. Worth asking the user directly
which it was if it matters for continuity (e.g. whether more is coming from
the same source).

### Environment gotchas worth remembering

- **`.env` now has real values** for `DATABASE_URL`, `SESSION_SECRET`,
  `AWS_REGION`/`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`S3_BUCKET_NAME`
  (real bucket, scoped IAM user), `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`,
  `NEXRENDER_SERVER_URL`/`NEXRENDER_API_KEY`, `ENABLE_REEL_RENDERING=true`.
  Local Postgres and ffmpeg (via `winget`) were also newly installed this
  session.
- **Restart the worker after any `.env` edit** — `tsx --env-file=.env`
  loads once at process start, not live. This bit us twice this session
  (see §5).
- **`npx prisma migrate dev` / `generate` may fail with
  `Cannot resolve environment variable: DATABASE_URL`** even with a
  correct `.env` present — Prisma 7's `prisma.config.ts`-based config
  loader doesn't auto-load `.env` the way older Prisma did. Workaround used
  all session: invoke via `node --env-file=.env node_modules/prisma/build/
  index.js migrate dev ...` instead of `npx prisma migrate dev`.
- `npm run test` now runs `vitest run` (was a placeholder before).

---
*Not pushed to `origin` — not asked to.*
