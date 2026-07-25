# Backend build steps

Companion to `docs/backend-plan.html`. Run one step at a time as its own `/goal`,
inside `/sandbox` + auto mode, scoped to this project folder. Review the diff and
commit before starting the next step — don't chain these into one run.

Each `/goal` condition below is phrased as an observable, checkable state (per
Claude Code's own guidance: a goal needs something Claude can verify itself, not
a description of effort). Turn caps are included so a step that can't complete
stops and reports rather than running indefinitely.

As each step finishes, check it off here and note anything that deviated from
plan — this file should stay accurate across sessions, the same way CLAUDE.md does.

---

## 0 — Scaffold
- [x] Done

```
/goal package.json exists with Express + TypeScript configured, the folder 
structure (routes/, middleware/, services/, jobs/, db/, config/) exists, 
.env.example lists every variable named in backend-plan.html, .env is listed in 
.gitignore before any commit is made, CLAUDE.md exists summarizing the 
architecture from backend-plan.html, and git is initialized with an initial 
commit — or stop after 10 turns and report what's incomplete.
```

## 1 — Schema
- [x] Done

```
/goal prisma/schema.prisma matches all 7 tables in backend-plan.html exactly — 
fields, types, relations, the unique constraint on (distributor_id, 
question_index) for segments, and segment_id (not distributor_id) as the key on 
rendered_videos — the initial migration applies cleanly to the local Postgres 
database, and npx prisma validate passes — or stop after 10 turns and report the 
blocker.
```

Deviations: Prisma 7 dropped `datasource.url` from `schema.prisma` — connection
config now lives in `prisma.config.ts` (datasource.url + migrations.seed), and
`PrismaClient` now requires an explicit driver adapter (`@prisma/adapter-pg`)
rather than reading `DATABASE_URL` implicitly. The jobs table's render job type
is named `render_segment`, not `render_distributor` — backend-plan.html uses
both names inconsistently; `render_segment` matches the per-segment-render
decision in CLAUDE.md and this file's own step 4 wording.

## 2 — Seed data
- [x] Done

```
/goal prisma/seed.ts creates 2 dummy clients and 5 dummy distributors split 
across them (not all 5 under one client), running the seed script populates the 
database with exactly these rows, and a query confirms all 7 rows exist — or 
stop after 8 turns and report the blocker.
```

Seeded: IFB Appliances (Ramesh Traders, Suresh Electronics, Patel Home
Appliances) and Voltas (Sharma Cooling Solutions, Kumar Sales Corp) — a 3/2
split. Seed command wired via `prisma.config.ts`'s `migrations.seed` (Prisma 7
moved this out of `package.json`).

## 3 — Auth
- [x] Done

```
/goal POST /login authenticates against the seeded accounts and returns a 
session token, the auth middleware resolves that token into 
{ distributor_id, client_id } on every request, and a request with a missing or 
invalid token demonstrably fails rather than returning data — or stop after 12 
turns and report the blocker.
```

Deviations: backend-plan.html's schema section for `distributors` has no
username/password columns (only `invite_token`, meant for Phase B), so Phase A
credentials live outside the DB — `src/config/seedAccounts.ts` is a hardcoded
array of the 5 usernames/bcrypt-hashed passwords, each keyed to a seeded
distributor's `invite_token`. `POST /login` checks that array, then looks up
the matching distributor row for `{ id, client_id }` and signs a JWT (30d
expiry, `SESSION_SECRET`) as the session token — stateless, since no sessions
table exists in the 7-table schema. `src/middleware/auth.ts` verifies the
`Authorization: Bearer` header on every request and attaches
`req.auth = { distributor_id, client_id }`; missing/invalid tokens get a 401
before any handler runs. Verified live: valid login → token; wrong password →
401; `GET /me` (new minimal protected demo route) with valid token returns the
exact `distributor_id`/`client_id` matching the DB row; missing or garbage
token on `/me` → 401 with no data leaked. `tsconfig.json` gained an explicit
`"include": ["src/**/*"]` — `prisma.config.ts`/`prisma/seed.ts` were tripping
`rootDir` checks in `tsc --noEmit`, unrelated to this step but blocking it.

## 4 — Upload flow
- [x] Done

```
/goal POST /segments/upload-url returns a valid presigned S3 URL scoped to one 
object key, POST /segments/confirm upserts the segment row respecting the 
(distributor_id, question_index) uniqueness, and confirming a segment queues 
both a transcribe_segment job and a render_segment job in the jobs table — or 
stop after 12 turns and report the blocker.
```

`src/services/s3.ts` builds the key as
`clients/{client_id}/distributors/{distributor_id}/segments/{question_index}.mp4`
per the naming convention in backend-plan.html's open items, and signs a PUT
URL with a 15-minute expiry (also per that section). Both routes require auth
and pull `distributor_id`/`client_id` from `req.auth`, never the request body.
`POST /segments/confirm` upserts on the `distributor_id_question_index`
compound key inside a `$transaction` alongside the two job inserts, so a
retake updates the existing row and both jobs are only ever queued together.
Verified live: first confirm creates a segment + 2 jobs; confirming the same
question_index again updates the same row (same id, new video_key/duration,
`created_at` unchanged) instead of duplicating; a second question_index
creates a second row. `psql` confirmed exactly one `transcribe_segment` and
one `render_segment` job per confirm call, all `pending`, correctly keyed to
`segment_id` in `payload`.

**Post-step-6 hardening**: `POST /segments/confirm` previously trusted the
client's claim that the upload succeeded — the only way we'd ever find out
otherwise was a worker job failing much later on a nonexistent file. Added
`objectExists()` (`src/services/s3.ts`, `HeadObjectCommand`) as a check before
the upsert/job-queue transaction; a missing object now returns
`404 { error: "video_not_found" }` immediately and touches nothing in the DB
(so a failed retake can't clobber a previous good upload). Non-obvious bug hit
building this: our IAM user is scoped to `GetObject`/`PutObject` only (no
`ListBucket`, deliberately least-privilege), and S3's `HeadObject` returns
**403, not 404**, for a nonexistent key when the caller lacks `ListBucket` — it
won't confirm-or-deny existence without list permission. Handled in code
(treat 403 as not-found, since every key checked here is one we generated
ourselves) rather than widening the IAM policy; `ListBucket` would make this
more precise (a real 404) but wasn't judged worth loosening the policy for.
Verified live: confirm with a nonexistent `video_key` → 404, zero DB rows
created; confirm with a real just-uploaded video → unchanged 200 happy path.

## 5 — Worker skeleton
- [x] Done

```
/goal worker.ts runs as an independent process from the API, polls the jobs 
table using SELECT ... FOR UPDATE SKIP LOCKED, successfully claims a pending 
job and marks it processing then done, and two worker instances running at the 
same time never claim the same job — or stop after 10 turns and report the 
blocker.
```

`src/worker.ts` is a standalone entry point (`npm run worker`), separate from
`src/index.ts` — no Express involved. Claiming uses the exact
`UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *`
pattern from backend-plan.html's pipeline section via `$queryRaw`; completion
goes through the typed Prisma client. Handler dispatch is a `Record<type,
handler>` map, currently empty — steps 6/7 plug in real
`transcribe_segment`/`render_segment` handlers there, and a job with no
handler just gets marked done (no work defined yet).

Verified live: single worker correctly moved one job pending → processing →
done (checked the raw claim SQL in isolation via `psql` first, then the full
worker). For the concurrency requirement, seeded 1500 pending jobs and ran two
worker processes at once (`worker-A`, `worker-B`) — both claimed jobs
throughout the run (738 vs. 762), all 1500 ended `done` with zero retries, and
diffing each worker's claimed-job-id log showed **zero overlap**, confirming
`SKIP LOCKED` held under real concurrent load rather than one worker just
finishing before the other started (an earlier 40-job run wasn't a valid
test — worker A drained the whole queue before worker B's process finished
cold-starting).

## 6 — Transcription pipeline
- [x] Done

```
/goal the transcribe_segment job handler extracts audio via ffmpeg, sends it to 
ElevenLabs Scribe, writes the transcript and SRT/VTT keys to the transcripts 
table, sends the transcript to the Claude API for sentiment and theme 
extraction and writes sentiment_results, and re-running the job when a result 
already exists does not call either paid API again — or stop after 15 turns and 
report the blocker.
```

Deviations: **Gemini, not Claude** — testing-phase call by the user (org has free
Gemini access; Claude is the intended post-testing swap). `src/services/gemini.ts`
uses `@google/genai` with `responseMimeType: "application/json"` +
`responseSchema` for structured `{ sentiment_score, themes, summary }` output.
Model is `gemini-flash-latest` (the version-pinned `gemini-2.5-flash` returned a
404 — retired for new API keys — so the auto-updating alias was used instead to
avoid repeating this when models rotate). `env.ts`'s required var is now
`GEMINI_API_KEY`, not `ANTHROPIC_API_KEY`; `backend-plan.html` still says Claude
and needs a follow-up doc pass (user-deferred, not done here). `NEXRENDER_*` vars
were downgraded from required to optional in `env.ts` since step 7 hasn't wired
them in yet — the fail-fast startup check would otherwise block steps 6/8/9 on
render-server config that isn't used yet.

`src/services/ffmpeg.ts` shells out to `ffmpeg -vn -acodec libmp3lame` to pull
audio directly from a presigned S3 GET URL (ffmpeg's HTTP demuxer range-requests
only the bytes it needs — S3 supports that) rather than downloading the full
video to local disk first via the SDK. First version did the SDK download, which
duplicated the client's own upload transfer (~10s combined on a 100MB/58s test
video, more than either paid API call) for no benefit; switched after stage
timing (added as permanent structured logging, `stage=X ms=Y` per segment) made
the waste visible. Verified: same output audio duration as the source
(58.28s vs 58.33s — range-seeking didn't truncate), ~22% faster than the
download-then-extract sequence it replaced. `src/services/elevenlabs.ts` posts
multipart form data (`scribe_v1`, `timestamps_granularity: word`) via native
`fetch`/`FormData`/`Blob` — no extra SDK needed. `src/services/captions.ts`
groups word-level timestamps into ~10-word cues to build SRT/VTT text, uploaded
to S3 alongside the transcript row. Idempotency is per-result, not per-job: the
handler checks `transcripts` and `sentiment_results` independently, so a job
that has a transcript but no sentiment yet (e.g. a previous run failed after
ElevenLabs succeeded) skips ElevenLabs and only calls Gemini.

Verified live end-to-end on 3 real videos (`assets/question_{1,2,3}.mp4`,
Hindi/English testimonials, ~60s each) driven through the actual
login → upload-url → S3 PUT → confirm → worker flow, not synthetic data. All 3
transcribed correctly (Hindi detected, code-mixed text preserved), SRT/VTT
confirmed present in S3 via `HeadObject`, sentiment scores + themes + summaries
came back coherent and specific to each transcript's content, segment status
reached `transcribed` in all 3 cases. Idempotency verified directly: re-queuing
a `transcribe_segment` job for an already-fully-processed segment completed in
546ms (vs. the original multi-second real-API run) with no duplicate
`sentiment_results` row — confirming both paid APIs were actually skipped, not
just fast. Two live env bugs were caught and fixed in the process, not just
code: `AWS_REGION` was set to a full endpoint URL instead of a bare region code,
and the Gemini model name needed the `-latest` alias swap above.

## 7 — Render pipeline
- [x] Done

```
/goal the render_segment job handler calls nexrender with the segment's clip 
and the client's branding config, uploads the rendered output to S3, and writes 
the resulting row to rendered_videos — or stop after 15 turns and report the 
blocker.
```

Deviations: **caption burn-in happens before nexrender, not after** — the
opposite order from the original plan note below (kept for history). Reasoning
changed twice: first for correctness (burning on the final composited output
would misalign captions by the intro segment's duration — no offset math
needed if it's burned onto the raw answer clip first, since burned-in text is
locked to that clip's own timeline regardless of where nexrender places it).
Then the user explicitly deprioritized the resulting cost (segment video read
twice, one extra S3 object) in favor of shipping — noted as a deliberate
speed-over-elegance tradeoff in `CLAUDE.md`'s future-work section, not
forgotten. `transcribeSegmentHandler` (step 6) now has a third independent
idempotent stage — `ffmpeg_burn_captions` — that burns the segment's own
`.srt` onto the raw video via `ffmpeg`'s `subtitles` filter and uploads the
result to a deterministic `.captioned.mp4` key (`buildCaptionedVideoKey`,
`src/services/s3.ts`); no new DB column, existence-check is the idempotency
guard, same pattern as everything else in this pipeline.

This introduced a real dependency that didn't exist before: `render_segment`
needs that captioned video, which only exists once `transcribe_segment`
finishes. So `render_segment` is **no longer queued at confirm-time**
(`POST /segments/confirm` in `segments.ts` now only queues
`transcribe_segment`) — `transcribeSegmentHandler` queues `render_segment`
itself at the end, guarded against duplicate queuing via a JSON-path lookup
on existing jobs for that `segment_id`. Still fires per-segment, just
triggered by that segment's transcription finishing rather than by upload
confirm — not a violation of "render fires the same point as transcription,
not gated on all 5" from backend-plan.html.

Real template info came from the user's own nexrender-cloud dashboard testing,
not guesswork: template id `01KY9MN1XA629BAZYSV18G69HQ`, composition
`MainComp`, two sub-segments — intro (`Question_VO_Place` audio, drives
segment duration; `Question_Text_Place` text) and answer
(`Answer_Video_Place` video; `Distributor_Name` text). `Question_VO_Place` is
a **static, pre-recorded per-question asset** (5 AI-generated voiceover
files, reused across every distributor for that question), not derived per
segment — uploaded once to `static/question-vo/{n}.mp3` in our own bucket;
`src/config/questions.ts` maps `question_index` to both the question text and
this VO key. `prisma/seed.ts`'s `branding_config.nexrender_template` and the
already-seeded DB rows were updated from placeholder names to this real ID
(both clients share it for now — one rough shared template, not yet
per-client branded).

`src/services/nexrender.ts`: `createJob`/`getJob`/`pollJobUntilDone` against
nexrender-cloud's REST API, confirmed via their docs (`POST /v2/jobs`,
`GET /v2/jobs/{id}`, statuses `queued`→`render:dorender`→`finished`/`error`).
S3 push-upload credentials registered once via their secrets API
(`PUT /v2/secrets`, names `S3_ACCESS_KEY_ID`/`S3_ACCESS_KEY_SECRET`),
referenced in job payloads as `${secrets.*}` rather than embedded raw.
`rendered_videos` gets an early `status: "rendering"` row (video_key already
known from the job-creation response's `outputUrl`, not just at completion) —
`renderSegmentHandler` polls synchronously to completion, blocking that
worker for the render's duration; accepted for now (matches the "ship first"
call above), same kind of future-optimization item as the double video read.

Two real bugs, not just config, caught by testing against the live API:
1. ffmpeg's `subtitles` filter cannot be made to accept an absolute Windows
   path via colon-escaping — tested single- and double-backslash escapes,
   both failed the same way (`Unable to parse ... as image size`). Fixed by
   running ffmpeg with `cwd` set to the working directory and passing bare
   relative filenames instead of fighting the escaping (`burnCaptions` in
   `src/services/ffmpeg.ts`).
2. nexrender's S3 upload step failed twice with "bucket must be addressed
   using the specified endpoint" — first guess (fixing `outputUrl` to a
   region-specific host) was wrong and didn't fix it; the actual cause was a
   separate `upload.params.endpoint` field that silently defaults to the
   generic `https://s3.amazonaws.com` (us-east-1) unless set explicitly,
   which breaks for any other region including ours (`ap-south-1`). Fixed by
   setting `endpoint` explicitly in `renderSegmentHandler`.

Verified live end-to-end against a real previously-uploaded segment (not
synthetic): caption burn-in produced a real captioned `.mp4` in S3, confirmed
via `HeadObject`; the render job submitted, rendered on nexrender-cloud's
infrastructure, pushed a real 45MB `.mp4` to our bucket; `rendered_videos`
reached `status: "rendered"` with the correct `video_key`; `ffprobe` against
a presigned URL for it confirmed a valid h264/aac 1080×1920 file. One
observation, not a bug: the rendered output is 30s despite the source answer
clip being ~58s — the template's answer segment appears to have a
fixed/trimmed duration rather than adapting to source length, directly
relevant to the "people talking too much" item already in `CLAUDE.md`.

Plan note from before implementation (kept for history, superseded by the
deviations above): this was originally going to be a two-stage render with
captions burned *after* nexrender's output. Base URL fix
(`https://api.nexrender.com/api`) and the general API shape (job creation,
template upload mirroring our own S3 presigned-URL pattern, secrets) were
confirmed via docs research before any of this was built.

## 8 — Read endpoints
- [x] Done

```
/goal GET /distributors/me/segments returns all 5 segments with status and a 
valid presigned playback URL for each, GET /distributors/me/rendered-video 
returns the reel's status and presigned URL once ready, and both responses 
include each row's updated_at — or stop after 10 turns and report the blocker.
```

Deviations: **`GET /distributors/me/rendered-videos` (plural), returning an
array — not the singular object both this goal and backend-plan.html's API
surface section describe.** `rendered_videos` is keyed on `segment_id`, not
`distributor_id` (per CLAUDE.md's locked "one branded reel per question, not
one merged video" decision), so a distributor with multiple rendered
questions has multiple rows — a singular response can't represent that
without silently dropping data. Confirmed with the user before building
rather than guessing; the doc's wording predates that schema consequence
being fully carried through. `src/routes/distributors.ts` holds both routes,
registered in `index.ts` behind the existing `authMiddleware`, scoped by
`req.auth.distributor_id` — no route param, matching the "me" convention
`meRouter`/`segmentsRouter` already use.

`GET /distributors/me/segments` returns whatever segment rows exist for the
distributor (0–5, ordered by `question_index`), not synthesized placeholder
entries for questions never recorded — nothing in the plan doc calls for
placeholders, and the mobile app's local-first playback logic (per
backend-plan.html's "Playback source" note) only needs `updated_at` for
segments it already has a local file for.

Added `getPlaybackUrl` to `src/services/s3.ts` — a 1-hour-expiry presigned
GET, separate from the existing 15-minute `getDownloadUrl` used internally by
the worker for its own short-lived fetches. The plan only says playback URLs
should be "longer-lived" without pinning a number; 1 hour was my own call,
generated fresh on every request per the doc's explicit "not cached"
instruction (confirmed live: repeated calls return different signatures).

For `rendered_videos`, `video_key` is written (and non-null) as soon as
nexrender accepts the job — before the file exists in S3 — so
`playback_url` is only populated once `status === "rendered"`; `null`
otherwise, rather than a URL that would 404.

Unrelated one-line fix needed to run the server for verification:
`package.json`'s `dev` script was `tsx --env-file=.env watch src/index.ts` —
tsx's CLI only recognizes `watch` as a subcommand as the first argument, so
with a flag ahead of it, `watch` was being parsed as the entry script instead
(`Cannot find module '.../watch'`). Reordered to
`tsx watch --env-file=.env src/index.ts`, confirmed via `tsx --help`'s
documented `tsx [flags...] [script path]` / `tsx <command>` usage forms.

Verified live end-to-end against real data from steps 6/7 (not synthetic):
logged in as `ramesh` (3 transcribed segments, 1 rendered video) — both
routes returned correctly shaped JSON scoped to just that distributor;
fetched the returned `playback_url` directly and got a real 103MB video back
(`HTTP 200`). Logged in as `kumar` (different distributor, different
client) — `segments` returned only his own single uploaded segment, and
`rendered-videos` returned `[]` (not an error) since no render has completed
for him yet, confirming cross-distributor scoping and the empty-array case
both work. A request with no `Authorization` header got a 401 with no data,
same as the existing auth middleware guarantees on every other route.

## 9 — End-to-end smoke test
- [x] Done

```
/goal a single real test video, pushed through the full flow, results in a 
segment row, a transcript, a sentiment result, and a rendered reel, all 
retrievable through the read endpoints with correct URLs — or stop after 15 
turns and report exactly which stage broke.
```

Ran 3 real, previously-unseen videos (`assets/goal_9_question_{2,3,4}.mp4`,
~35–37s each, distinct real content), not just the one the goal asked for —
against a completely untouched distributor (`sharma`, Voltas) so timing and
idempotency behavior reflected true cold-path processing, not partial/
already-processed data from earlier sessions. Added matching `stage=X ms=Y`
+ `TOTAL` timing to `renderSegment.ts` (`nexrender_submit`,
`nexrender_poll_until_done`) before running, mirroring the logging
`transcribeSegment.ts` already had — needed to answer the user's explicit
ask for per-stage timing across the whole pipeline, not just transcription.

**One real finding, not a bug**: the video confirmed at `question_index: 4`
transcribed and got sentiment-analyzed fine, but failed at render with
`No question config for question_index 4` — `src/config/questions.ts` only
has entries for questions 1–3 (4/5 deliberately commented out, matching the
mobile app's `AppFlow.tsx` where the same two questions are commented out of
`PLACEHOLDER_QUESTIONS`). Confirmed with the user this is a real
active-question-set mismatch, not something to route around silently — user
chose to re-point that same video to `question_index: 1` (unused for
`sharma`) rather than activate question 4 as a side effect of a smoke test.
That re-run succeeded fully. Net result: **3 full successes** (question
indices 1, 2, 3 for `sharma`) plus one correctly-failed render on an
inactive question index, which is itself useful signal — the render guard
fails clean with no partial `rendered_videos` row, no crash, no orphaned
render job.

Verified for all 3 successful segments: `segments` table status
`transcribed`, `transcripts` row present (distinct, coherent English text
per video — confirmed content actually differs, not a copy-paste artifact),
`sentiment_results` row present (score 0.85–0.9, `is_relevant: true`,
distinct summaries matching each transcript), `rendered_videos` row at
`status: rendered`. All retrieved through `GET /distributors/me/segments`
and `GET /distributors/me/rendered-videos` (both built in step 8) — every
`playback_url` fetched directly and confirmed real (`HTTP 200`, ~45MB per
rendered reel, matching the raw ~8MB inputs post-branding). The
question-4-shaped gap (segment exists, transcript/sentiment exist, no
`rendered_video` row) is exactly what `GET /distributors/me/rendered-videos`
was designed to represent — confirmed live, not just in theory.

Full per-stage timing (3 successful runs, `sharma`/Voltas, single worker
process, no concurrency):

| stage | q1 (re-pointed) | q2 | q3 | avg |
|---|---|---|---|---|
| upload (client PUT) | 1614ms | 1594ms | 1795ms | ~1.7s |
| confirm (incl. S3 HeadObject + DB) | 132ms | 276ms | 142ms | ~0.18s |
| ffmpeg_extract_audio | 1476ms | 2213ms | 1678ms | ~1.8s |
| elevenlabs_transcribe | 3161ms | 4637ms | 3457ms | ~3.8s |
| s3_upload_captions | 174ms | 154ms | 167ms | ~0.16s |
| ffmpeg_burn_captions | 7446ms | 7963ms | 9312ms | ~8.2s |
| gemini_analyze_sentiment | 9254ms | 10438ms | 5903ms | ~8.5s |
| **transcribe_segment TOTAL** | 21562ms | 25611ms | 20595ms | **~22.6s** |
| nexrender_submit | 871ms | 889ms | 303ms | ~0.7s |
| nexrender_poll_until_done | 40248ms | 33743ms | 40418ms | ~38.1s |
| **render_segment TOTAL** | 41174ms | 34752ms | 40816ms | **~38.9s** |
| **upload → fully rendered, wall clock** | ~64.5s | ~62.2s | ~63.3s | **~63.3s** |

For a ~35s source clip, end-to-end wall time (single worker, no queueing
delay) runs ~1.8x the clip's own length — dominated by nexrender's actual
render time (~60% of total), then Gemini sentiment (~14%) and the ffmpeg
caption-burn pass (~13%, the known double-read cost already flagged in
`CLAUDE.md`'s future-work notes). Rough cost estimate deferred to
`learnings.md` per the user's request — computed once, after the test, not
per-step.
