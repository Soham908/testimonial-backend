# Session learnings & handoff

Written to let a fresh chat pick up where this one left off, without re-reading
the full conversation history. `BUILD_STEPS.md` has the authoritative per-step
deviation notes — this file is the higher-level "things you'd otherwise have
to rediscover" summary: API details, real bugs hit, gotchas, and open items.

## Where things stand

Steps 0–8 committed (log below). **Step 9 (end-to-end smoke test) is done and
verified live, not yet committed** — modified: `BUILD_STEPS.md`, this file,
`src/jobs/renderSegment.ts` (added timing instrumentation). No new files this
step. All 10 build steps are now functionally complete; only the commit is
outstanding.

```
64b25f2 Implement read endpoints for My Videos (build step 8)
102f901 Implement render pipeline with nexrender-cloud (build step 7)
a8061b9 Extend sentiment analysis with quote, relevance, moderation, and complaint signals
9902d87 Implement transcription pipeline with Gemini sentiment analysis (build step 6)
db5c904 Add worker skeleton with SKIP LOCKED job claiming (build step 5)
6dc3a1d Implement schema, seed data, auth, and upload flow (build steps 1-4)
36b0f6c Scaffold Express + TypeScript backend
```

Remaining: nothing build-step-wise — all 10 steps (0–9) in `BUILD_STEPS.md`
are checked off. Next work is either polish on the flagged future items, or
whatever the user directs next.

## Architecture decisions made this session (not in the original plan doc)

- **Gemini stands in for Claude** during the testing phase — org has free Gemini
  access, Claude is the intended post-testing swap. `backend-plan.html` still
  says Claude; that doc needs a pass once the swap actually happens (user-
  deferred, not done). `GEMINI_API_KEY` is the required env var, not
  `ANTHROPIC_API_KEY`.
- **Sentiment/theme data is admin/company-facing only, never distributor-
  facing.** This matters for step 8 — do **not** fold `sentiment_results` into
  `GET /distributors/me/segments`. The real place for it is
  `backend-plan.html`'s `GET /clients/:id/insights` (Phase 7, needs admin auth
  that doesn't exist in Phase A yet). There's a temporary test-only endpoint,
  `GET /segments/sentiment`, scoped by `client_id`, in `src/routes/segments.ts`
  — clearly commented as temporary, not part of the documented API surface.
- **Caption burn-in happens before nexrender, not after.** Burning onto
  nexrender's *final* composited output would misalign captions by the intro
  segment's duration (captions are timed against the raw answer clip alone).
  Burning onto the raw clip first avoids that entirely — burned-in text is
  locked to that clip's own timeline regardless of where nexrender places it
  later. This was a deliberate, explicit tradeoff: it costs an extra full
  video read + one extra S3 object (see "Deferred/future items" below), but
  the user explicitly deprioritized that cost in favor of shipping.
- **`render_segment` is queued by `transcribe_segment`'s completion, not at
  confirm-time.** It depends on the captioned video only `transcribe_segment`
  produces. `POST /segments/confirm` now only queues `transcribe_segment`.
  Still fires per-segment, just triggered differently — not a violation of
  "render fires at the same point as transcription" from `backend-plan.html`.
- **`Question_VO_Place` is a static, pre-recorded asset per question**, not
  derived per segment — 5 AI-generated voiceover files, reused across every
  distributor for that question. Mapped in `src/config/questions.ts` alongside
  the question text.
- **Step 8: `GET /distributors/me/rendered-videos` is plural, returns an
  array** — not the singular object both `BUILD_STEPS.md`'s original goal
  text and `backend-plan.html`'s API surface section describe.
  `rendered_videos` is keyed on `segment_id`, so a distributor with multiple
  rendered questions has multiple rows; a singular response would silently
  drop data. Confirmed with the user before building, not guessed. Both new
  routes live in `src/routes/distributors.ts`, scoped by
  `req.auth.distributor_id`, no route param — matches the existing `/me`
  convention.
- **Playback URLs use a new 1-hour-expiry presigned GET**
  (`getPlaybackUrl` in `s3.ts`), separate from the existing 15-min
  `getDownloadUrl` the worker uses internally. The plan doc only says
  playback URLs should be "longer-lived" without a number — 1 hour was my
  own call. Generated fresh on every request, never cached, per the doc's
  explicit instruction (confirmed live: repeated calls return different
  signatures).
- **`rendered_videos.video_key` is written as soon as nexrender *accepts*
  the job** (from `outputUrl` in the create-job response), before the file
  actually exists in S3 — the row sits at `status: "rendering"` in the
  meantime. `GET /distributors/me/rendered-videos` only returns a
  `playback_url` once `status === "rendered"`; `null` otherwise, since a URL
  to a not-yet-existent object would just 404.
- **`GET /distributors/me/segments` returns whatever rows exist (0–5),
  not synthesized placeholders** for questions never recorded — nothing in
  the plan calls for placeholder entries, and the mobile app's local-first
  logic only needs `updated_at` for segments it already has a local file
  for.

## Pipeline flow and sync design — clarified this session (Q&A, no code change)

Came up while walking through the full pipeline end to end and discussing
what step 8's endpoints are actually for. Nothing here changed code; worth
keeping so it doesn't have to be re-derived.

- **How "upload complete" is actually detected**: no S3 event/webhook — it's
  a client-driven handshake. Mobile app PUTs directly to S3 with a presigned
  URL, then calls `POST /segments/confirm`; the backend verifies the object
  really exists via `HeadObject` (`objectExists()`) before writing anything.
  "Complete" = the client telling the server to go check, not the server
  being told by S3.
- **The pipeline is sequential, not two parallel branches off of
  transcription.** `transcribe_segment` runs three stages inline in one job
  (audio extraction + ElevenLabs transcript, Gemini sentiment analysis,
  caption burn-in) and only *then* queues `render_segment` itself, because
  render needs the captioned video that job just produced. Render literally
  cannot start until transcription finishes — it's a dependency, not a fork.
- **`GET /distributors/me/segments`'s purpose**: lets the app check whether
  its local recording is still current, by comparing cached `updated_at`
  against the server's — match → play local, mismatch/missing → fall back to
  `playback_url`. Confirmed this is the whole point, per
  `backend-plan.html`'s "Playback source" note.
- **`GET /distributors/me/rendered-videos`'s purpose**: returns URLs only,
  never video bytes — downloading/caching the actual reel is entirely a
  mobile-side responsibility.
- **Completeness check (recorded count == rendered count) doesn't need a new
  backend endpoint.** Both existing endpoints already carry what's needed —
  `segments` gives recorded/uploaded count, `rendered-videos` gives rendered
  count/status per question. A client-side sync function that calls both and
  diffs is enough; a dedicated aggregate/summary endpoint would just
  duplicate what two small calls already give for free. Recommended against
  building one now.
- **Where to cache "what the app already has" locally**: reuse the exact
  same local-first pattern already specified for segments
  (`backend-plan.html`'s "Playback source" note, which explicitly says
  rendered videos should get "the same local-first-with-`updated_at`-check
  pattern... once downloaded") — one cache shape, keyed per
  `question_index`, storing local file path + last-synced `updated_at`, for
  both segments and rendered videos. Not a new mechanism, just applying the
  existing one to both endpoints.

## Nexrender-cloud API reference (confirmed via their docs + live testing)

Using **nexrender-cloud** (hosted SaaS), *not* self-hosted `nexrender-server` +
local After Effects — no AE install or render machine of our own needed.

- Base URL: `https://api.nexrender.com/api` — note the `/api` segment; easy to
  drop by mistake (happened once this session).
- Auth: `Authorization: Bearer <token>` header, token from
  `https://app.nexrender.com/settings/api-tokens`.
- Versioning is genuinely mixed, not just old-vs-new: job creation, template
  creation/upload, and secrets are all `v2`; template *listing/metadata* is
  `v3`. Not a mistake if you see both in the same codebase.

Endpoints actually used:
- `POST /v2/jobs` — create a render job. Body: `{ template: { id, composition
  }, assets: [...], upload: {...} }`. Response includes `id`, `status`
  (`queued`/`pending`), and **`outputUrl` immediately** — the eventual output
  key is known right away, before rendering even starts, so a `rendered_videos`
  row can be created early with `status: "rendering"`.
- `GET /v2/jobs/{id}` — poll status. Values: `queued` → `render:dorender` →
  `finished`/`error`/`manually_cancelled`. No webhook support used (would need
  a publicly reachable endpoint; local dev doesn't have one) — polling only,
  3s interval, 10 min timeout in `src/services/nexrender.ts`.
- `PUT /v2/secrets` — register a secret (`{ name, value }`). Used once to
  register our own S3 credentials as `S3_ACCESS_KEY_ID` /
  `S3_ACCESS_KEY_SECRET`, referenced in job payloads as `${secrets.NAME}`
  rather than embedded raw. There's a pre-existing secret named `"AWS"` from
  September 2025 in the account — unrelated, predates this project, don't
  touch it.
- `POST /v2/templates` + `PUT /v2/templates/{id}/upload` — template creation
  mirrors our own S3 presigned-upload pattern almost exactly (create record →
  get presigned URL → PUT the file directly). Not used in the end — the user
  uploaded the template via nexrender-cloud's own dashboard UI instead, which
  turned out to be available and simpler than the API flow.
- `GET /v3/templates` — list templates. Not used in the actual implementation,
  only during research.

**Real template in use**: id `01KY9MN1XA629BAZYSV18G69HQ`, composition
`MainComp`. Two sub-segments in the timeline:
- **Intro**: `Question_VO_Place` (audio, static per-question file, *drives
  this segment's duration*), `Question_Text_Place` (text). Static/baked in:
  "Question:" label, wordmark, logo, background.
- **Answer**: `Answer_Video_Place` (video — the distributor's captioned
  answer clip), `Distributor_Name` (text). Static: logo + wordmark reused.

Both seeded clients (IFB Appliances, Voltas) currently point at this same
template in `branding_config.nexrender_template` — it's one shared rough test
template, not yet distinct per-client branded ones.

**Critical gotcha**: `upload.params` for the S3 provider has a separate
`endpoint` field (distinct from `region`) that **silently defaults to
`https://s3.amazonaws.com`** (the us-east-1 generic endpoint) if omitted. This
breaks uploads for any bucket outside us-east-1 — including ours
(`ap-south-1`) — with the exact AWS error "the bucket you are attempting to
access must be addressed using the specified endpoint." Must set it
explicitly: `endpoint: https://s3.${AWS_REGION}.amazonaws.com`. This cost two
failed (but successfully AE-rendered) nexrender jobs to track down — the first
fix attempt touched `outputUrl` instead and did nothing.

## Real bugs hit and fixed this session (not just config typos)

1. **`AWS_REGION`** was set to a full URL instead of a bare region code —
   broke S3 presigned URL generation entirely.
2. **`gemini-2.5-flash` returned 404** ("no longer available to new users")
   despite being listed in the models API. Switched to the `gemini-flash-
   latest` alias, which auto-points at whatever's current — avoids repeating
   this when models rotate again.
3. **S3 `HeadObject` returns 403, not 404, for a nonexistent key** when the
   IAM user lacks `s3:ListBucket` (ours does, deliberately least-privilege) —
   S3 won't confirm-or-deny existence without list permission. `objectExists()`
   in `src/services/s3.ts` treats both status codes as "not found," since every
   key it checks is one we generated ourselves.
4. **Prisma Client must be regenerated *and* the process restarted** after any
   schema migration. A running worker holds the pre-migration client in
   memory — `npx prisma generate` alone isn't enough if a process is already
   running; it needs to be killed and restarted too. Cost 3 wasted Gemini
   calls once (job failed at the DB write step, after the paid call already
   succeeded).
5. **ffmpeg's `subtitles` filter cannot take an absolute Windows path via
   colon-escaping** — tried both single-backslash and double-backslash escape
   variants, both failed with `Unable to parse "original_size"... as image
   size`. Fixed by running ffmpeg with `cwd` set to the working directory and
   passing a bare relative filename instead of fighting the escaping
   (`burnCaptions` in `src/services/ffmpeg.ts`).
6. **`node --env-file=.env` only applies to the process it's given to**, not
   child processes spawned separately (e.g. bare `npx prisma migrate dev`).
   Fix: wrap via `node --env-file=.env -e "require('child_process').execSync('npx prisma ...', {stdio:'inherit'})"`
   so the child inherits the already-loaded `process.env`.
7. **`npm run dev`/`npm run worker` don't auto-load `.env`** — `tsx` doesn't
   do this by itself. Both scripts now use `tsx --env-file=.env` explicitly.
   Nothing hot-reloads `.env` changes or code changes in `worker.ts` — always
   kill and restart the node process after either changes (this bit us
   repeatedly: `AWS_REGION` fix, Gemini model fix, ffmpeg fix, nexrender
   endpoint fix all required a restart before the fix actually took effect).
8. **`tsx`'s CLI only recognizes `watch` as a subcommand when it's the first
   argument.** `package.json`'s `dev` script was
   `tsx --env-file=.env watch src/index.ts` — with a flag ahead of it, `watch`
   got parsed as the entry script path instead
   (`Cannot find module '.../watch'`). Fixed by reordering to
   `tsx watch --env-file=.env src/index.ts`, confirmed via `tsx --help`'s
   documented usage forms (`tsx [flags...] [script path]` / `tsx <command>`).
   Found while verifying step 8 — the server had apparently never been
   started via `npm run dev` in a way that hit this, only `npm run worker`
   (no `watch`) and presumably direct `tsx` invocations during earlier
   sessions' live testing.

## Permission/tooling notes for whoever continues this

- `.env` is deny-listed in `.claude/settings.json` for `Read`/`Edit` **and**
  any Bash command that touches its content (`grep .env`, `wc .env`, `cat
  .env` all get blocked) — deliberate, don't try to work around it. The only
  way to verify its contents indirectly is running the actual app and reading
  the *behavior* (e.g. "missing required env var X" errors), never the values.
- Destructive Bash operations (`deleteMany`, etc.) get blocked by an
  auto-mode permission classifier and need explicit user confirmation first.
- Windows-specific: use `taskkill //F //PID <pid>` to stop background node
  processes (found via `tasklist //FI "IMAGENAME eq node.exe"` — there's
  usually only the API server and/or worker running, distinguish by PID and
  what was started when).

## Deferred/future items (also written into `CLAUDE.md`'s note-to-self section)

- Long recordings (>1 min) — no handling defined yet.
- Different phone aspect ratios — no handling defined yet. **This is likely
  the direct cause of the zoomed/cropped render below**, now visibly
  manifesting rather than theoretical.
- WhatsApp-servable file size — raw segments are ~100MB/minute, too big to
  share directly; not addressed.
- Caption burn-in reads the segment video twice (once for audio extraction,
  once again for burning) and stores an extra full-size video copy in S3 —
  deliberate speed-over-cost tradeoff for first implementation. Revisit: burn
  captions on nexrender's *final* output instead, using a fixed per-question
  time offset (intro VO durations are static and known in advance), which
  would cut this to one extra pass with no extra stored video.
- **Nexrender template's answer segment has a static/fixed duration** — first
  real render came out 30s despite a ~58s source clip. Needs to be driven by
  actual footage length instead. User has already worked out an approach for
  this from prior testing (not yet implemented here — ask them for it).
- **First real render came out zoomed/cropped** — the answer footage got
  scaled to fill the template's expected frame rather than fitting cleanly.
  Likely the aspect-ratio-mismatch item above showing up in practice; possibly
  also related to raw videos being stored as 1920×1080 with a 90° rotation
  flag rather than "true" portrait dimensions, if nexrender's ingestion
  doesn't honor that metadata the way a normal player does.
- Caption styling (font size, vertical position) is adjustable via ffmpeg's
  `subtitles` filter `force_style` option (`Fontsize`, `MarginV`) — confirmed
  possible, not yet implemented.
- Mobile app recording quality/bitrate reduction (to shrink the ~100MB/min
  raw uploads) — this is a mobile-app-side change, out of scope for this repo
  entirely; raise it in that project's own session.
- **Orphaned upload if the app is killed mid-upload** — `POST
  /segments/confirm` is entirely client-driven; if the app dies before
  calling it (even after a successful S3 PUT), there's no backend awareness
  and no way to detect it. Fix would be an S3 `ObjectCreated` event
  notification (→ SQS/Lambda) as a backstop independent of the client. Not
  built — depends on whether the mobile app even does OS-level background
  transfer, which is a `video_project` question. Confirm itself has no time
  limit, so a *delayed* confirm (app reopened later) already works fine —
  this item is only about confirm never arriving at all.
- **nexrender: polling vs. webhook** — `render_segment` currently blocks a
  worker for the full render duration via `pollJobUntilDone`. Webhook would
  free the worker immediately but requires a public HTTPS endpoint (only
  available once deployed), signature verification, splitting the handler
  into submit + webhook-triggered-completion phases, and a fallback
  poll/timeout anyway (webhooks can drop). Not worth it before real
  concurrent render volume makes worker capacity the actual bottleneck.
  **Not yet confirmed nexrender-cloud even supports webhooks** — only their
  polling API (`GET /v2/jobs/{id}`) has been verified against their docs.
- **Admin dashboard was forgotten from scope entirely.** `sentiment_results`
  is written correctly per segment (score, themes, summary, best quote,
  relevance/moderation/complaint flags, highlight score) but has no real
  admin-facing surface — only the temporary `GET /segments/sentiment` test
  route. Needs to be designed and built as its own phase; this data is
  intentionally never distributor-facing.

## Step 9: timing + rough cost estimate

Full per-stage timing table is in `BUILD_STEPS.md`'s step 9 section — this is
just the cost side, computed once at the end per the user's request, using
actual measured usage from the 3 successful runs (35–37s clips) plus pricing
pulled from a live web search on 2026-07-25 (not from training-data memory,
which would likely be stale for anything this pricing-sensitive). **Treat
all of this as rough, directional planning, not a number to budget against
precisely** — a couple of the source prices below were inconsistent across
search results and should be re-verified against the actual billing
consoles/dashboards before being relied on.

**Per-video marginal processing cost** (the 4 paid/metered things this
pipeline actually calls):
- **nexrender render**: $0.21/render-minute on their Pay-As-You-Go plan
  ([nexrender.com/pricing](https://www.nexrender.com/pricing)). Measured
  render time (`nexrender_poll_until_done`) averaged ~38s = 0.63 min →
  **~$0.13/video**. By far the largest per-video line item.
- **ElevenLabs Scribe**: search results disagreed — official pricing page
  snippet said $0.22/hour of input audio, an older ElevenLabs announcement
  said $0.40/hour, one blog conflated it with a $0.22/1,000-token figure
  that's a different unit entirely
  ([elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api)). Using
  $0.22–0.40/hour against ~36s of audio → **~$0.002–0.004/video**. Small
  either way, but worth confirming the real number if volume grows.
- **Gemini sentiment call**: `GEMINI_API_KEY` uses the `gemini-flash-latest`
  alias (chosen in step 6 specifically so it auto-updates instead of
  breaking on model retirement) — which means the actual model, and
  therefore the actual price, can move without this codebase changing.
  Current Flash-tier pricing found ranges from $0.50/$3 per million
  input/output tokens up to $1.50/$7.50 for the newest Flash model
  ([cloudzero.com/blog/gemini-pricing](https://www.cloudzero.com/blog/gemini-pricing/)).
  Estimated ~700 input tokens (transcript + prompt/schema) + ~200 output
  tokens per call → **~$0.002–0.006/video** depending on where the alias
  currently points.
- **S3** (storage + requests + the pipeline's own internal transfers —
  ffmpeg pulling the raw video, nexrender pulling the captioned video + VO
  audio): storage for the ~61MB retained per video (raw + captioned
  intermediate + final render) is ~$0.0014/month at $0.023/GB-month
  ([aws.amazon.com/s3/pricing](https://aws.amazon.com/s3/pricing/)); internal
  transfer during processing is roughly 25–30MB at the $0.109/GB ap-south-1
  egress rate → **~$0.003/video**. Requests (PUT/GET/HEAD) are a fraction of
  a cent.

**Total marginal cost per video processed**: roughly **$0.14–0.15**, almost
entirely the nexrender render-minute charge — everything else combined is a
rounding error next to it.

**The number that actually matters more than the per-video figure**:
nexrender's Pay-As-You-Go plan has a **$119/month base fee** on top of the
per-minute charge, not a pure usage meter
([nexrender.com/pricing](https://www.nexrender.com/pricing)). At low volume
that fixed floor dominates completely — e.g. at 10 videos/month, real
cost-per-video is closer to **~$12** once the $119 floor is amortized in,
not $0.14; it only approaches the marginal $0.14 rate at high volume (many
hundreds/month). Worth checking which nexrender plan is actually subscribed
to and what real expected monthly volume looks like — this is a bigger lever
than any network/egress optimization below.

**Structural hosting cost for a public deployment** (not tied to video
volume, this is what "running on a publicly accessible server" adds):
- **App Runner** (API server): $0.064/vCPU-hr + $0.007/GB-hr while active,
  $0.007/GB-hr provisioned even when idle
  ([aws.amazon.com/apprunner/pricing](https://aws.amazon.com/apprunner/pricing/)).
  Rough small-service estimate: **~$30–60/month**.
- **Worker process**: it's a persistent polling loop (`worker.ts`), not
  request-driven, so it doesn't fit App Runner's scale-to-zero model the way
  the API does — would need its own small always-on compute (Fargate task or
  small EC2 instance). Rough estimate: **~$15–30/month**.
- **RDS Postgres** (`db.t4g.micro`): ~$11.68/month compute
  ([economize.cloud](https://www.economize.cloud/resources/aws/pricing/rds/db.t4g.micro/))
  + ~$1/month storage at current DB size.
- **S3 storage**: scales with total videos ever processed, not monthly
  volume — negligible until there are thousands of testimonials
  (~$0.023/GB-month).
- **Egress for end-user playback**: this is the genuinely variable,
  hard-to-predict one — every time someone actually watches/downloads a
  rendered reel (WhatsApp share, repeat views), that's ~45MB × $0.109/GB ≈
  **$0.005/view**, and it scales with how widely a reel gets shared, not
  with how many were created. A reel that gets forwarded around could cost
  more in egress than it did to render.

**Rough total floor to have this running publicly at low volume**: roughly
**~$180–220/month** (hosting ~$60–100 + nexrender's $119 base), before
counting per-video processing (~$0.14 each) or playback egress (usage-
dependent). This is a genuinely rough estimate for planning purposes, not a
number to hold AWS/nexrender to — re-verify against actual billing consoles
before treating any of it as final.

## Post-step-9 benchmark (2026-09-17): transcription+analysis only, no render

**This measures something different from the "Step 9" benchmark above —
keep both.** The step 9 numbers are full end-to-end including nexrender
render time and cost; that's still the right reference for once rendering
is back on. This section measures the pipeline as it actually runs *right
now*, during this internal-test phase: rendering is off
(`ENABLE_REEL_RENDERING=false`), and caption burn-in — which existed solely
to feed nexrender — is now gated on that same flag
(`src/jobs/transcribeSegment.ts`) rather than always running, so it doesn't
happen either. What's left is audio extraction → ElevenLabs transcription →
Gemini sentiment analysis, which is the entire real cost/time surface today.

**Real test, not synthetic**: a real previously-recorded ~58s clip the user
provided (S3 key already tied to an existing segment in the local dev DB —
Zeist client, "Test User" distributor, `question_index: 1`), run through
`extractAudio`/`transcribeAudio`/`analyzeSentiment` directly, standalone
(no DB/S3 writes — the existing segment's real data wasn't touched). n=1,
one sample — treat as directional, same as everything else in this file.

- **Source video**: 58.4s duration, 52.9MB, 1080×1920 (already the
  normalized/captioned-shape output). Hindi speech, heavily code-mixed with
  English business vocabulary — ElevenLabs detected `hin` at **98.25%
  confidence** (`language_probability`, now stored on `Transcript` — see
  the sentiment-prompt-rewrite commit), 150 words.

| Stage | Time |
|---|---|
| ffmpeg extract audio | 5.3s |
| ElevenLabs transcribe | 2.7s |
| Gemini sentiment analysis | 7.4s |
| **Total** | **~16.3s** |

- **Real Gemini token usage** (from the actual API response's
  `usageMetadata`, now logged on every call — see `src/services/gemini.ts`):
  **1,090 input tokens, 238 output tokens, 1,328 total.** That input figure
  is the entire prompt: instructions, the fixed theme/emotional-tone/
  life-skills vocab lists, and the transcript together — there's no
  separate system prompt, everything goes in as one combined message.
- **Real cost, current pricing** (verified live on 2026-09-17, not from the
  July estimate above — the model has since changed from the
  `gemini-flash-latest` alias to a **pinned** `gemini-3.5-flash-lite`, so
  this is a real number for a known-fixed model, not a moving target):
  - Gemini `gemini-3.5-flash-lite` standard tier: $0.30/1M input tokens,
    $2.50/1M output tokens → **~$0.0009** for this call.
  - ElevenLabs Scribe: $0.22/hour → 58.4s of audio → **~$0.0036**.
  - **Combined: ~$0.0045/segment** — under half a cent.

**What this means right now**: during this internal-test phase (no
rendering), the real cost floor per segment is a few tenths of a cent —
100 segments ≈ $0.45, 1,000 ≈ $4.50. The step-9 estimate's dominant cost
(nexrender's ~$0.13/video + $119/month base) **isn't being spent at all**
while `ENABLE_REEL_RENDERING` stays off. Time-wise, a segment's real
server-side processing today is ~16–20s (this measurement plus small S3/DB
write overhead not included above), not the ~63s the step-9 figure implies
— that figure included render time, which isn't happening.

Caveat carried over from the numbers above: ElevenLabs/ffmpeg time scales
with audio duration, and Gemini's token count (and cost) scales with
transcript length — a longer or shorter answer moves these proportionally,
this isn't a fixed per-segment constant.

## Test/seed data currently in the dev DB

- 2 clients: IFB Appliances, Voltas — both `branding_config.nexrender_template`
  now point at the real shared test template id above.
- 5 seeded distributor accounts (Phase A, `src/config/seedAccounts.ts`):
  `ramesh`/`ramesh123` (IFB), `suresh`/`suresh123` (IFB), `patel`/`patel123`
  (IFB), `sharma`/`sharma123` (Voltas), `kumar`/`kumar123` (Voltas).
- Real test videos pushed through the full pipeline in earlier sessions:
  `assets/question_1-3.mp4` (gitignored, not committed — ~100MB each) under
  `ramesh`; one more under `suresh`; one under `patel` (uploaded but not fully
  processed through render in every test run — check job/segment status
  before assuming it's complete).
- **Step 9 smoke test data (this session)**: `sharma` (Voltas, previously
  untouched) now has 3 fully-rendered segments — `assets/goal_9_question_2.mp4`
  and `_3.mp4` at their natural question_index, and `_4.mp4` re-confirmed
  under `question_index: 1` after the original `question_index: 4` upload hit
  the known "questions 4/5 not configured" gap (still sits in the DB at
  `question_index: 4`, status `transcribed`, no `rendered_video` row — left
  as-is, useful as a real example of the partial-completion case). All 4
  files gitignored, not committed, ~8MB each (much smaller than the earlier
  ~100MB test clips).
- One old orphaned placeholder segment under "Kumar Sales Corp" with a fake
  `video_key` from very early step-4 testing — never actually uploaded to S3,
  no jobs ever attached to it, harmless, safe to ignore or clean up later.
- 5 static per-question VO files uploaded to `static/question-vo/{1-5}.mp3` in
  S3 (source files also still in `assets/audio/question{1-5}.mp3`, gitignored).

## Env vars — status, not values

All required vars are populated in `.env` (never read directly, only verified
indirectly by running the app): `DATABASE_URL`, `SESSION_SECRET`, `AWS_REGION`
(bare region code, e.g. `ap-south-1` — not a URL), `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `ELEVENLABS_API_KEY`,
`GEMINI_API_KEY`, `NEXRENDER_SERVER_URL` (must include the `/api` segment),
`NEXRENDER_API_KEY`. `.env.example` is kept in sync with whatever's actually
required in `src/config/env.ts`.

## Orientation — key files

```
src/config/env.ts            fail-fast env validation (all vars required now)
src/config/questions.ts      question text + VO S3 key, by question_index
src/config/seedAccounts.ts   Phase A hardcoded login credentials
src/services/s3.ts           presigned URLs, objectExists, upload helpers
src/services/ffmpeg.ts       extractAudio, burnCaptions
src/services/elevenlabs.ts   Scribe transcription
src/services/gemini.ts       structured-output sentiment analysis
src/services/nexrender.ts    createJob/getJob/pollJobUntilDone
src/services/captions.ts     SRT/VTT generation from word timestamps
src/jobs/transcribeSegment.ts  step 6 handler (+ caption burn-in, step 7 queuing)
src/jobs/renderSegment.ts      step 7 handler
src/routes/login.ts, me.ts, segments.ts, distributors.ts (step 8)
src/middleware/auth.ts
src/worker.ts                 standalone process, npm run worker
src/index.ts                  Express app, npm run dev
prisma/schema.prisma, seed.ts
```

## What the next session should probably do first

1. Read `BUILD_STEPS.md` to confirm current step checkboxes match this file's
   claim (steps 0–9 all done, step 9 uncommitted as of this writing).
2. Commit step 9 (`BUILD_STEPS.md`, `learnings.md`,
   `src/jobs/renderSegment.ts`) if not already done.
3. All build steps are complete — next work is one of: the flagged future
   items (orphaned uploads, nexrender webhook, admin dashboard, aspect
   ratio/duration/long-recording handling), or an actual deployment pass
   (App Runner + RDS), or whatever the user directs.
4. Remember the restart-after-changes gotcha before assuming a fix took
   effect.
