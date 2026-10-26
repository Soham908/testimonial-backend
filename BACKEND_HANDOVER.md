# Backend handover for the new laptop

Prepared 2026-10-26 from this checkout and the test history in this task. The source baseline before this handover was `a9118aa` on `master` (2026-09-21). This is the backend portion of the laptop migration; mobile and dashboard application internals need handovers from their own repositories.

## Start here

This backend supports a video-testimonial platform for Indian distributor networks. Participants answer configured questions with individual video clips. The backend authorizes direct S3 uploads, records each submission, runs speech transcription and analysis asynchronously, and optionally produces a branded reel for each answer. An internal dashboard reads client-wide aggregates and individual responses.

Repository: <https://github.com/Soham908/testimonial-backend>. The old local path is `C:/dev/testimonial-backend`; that path is a convenience, not an application requirement. The mobile project was a sibling at `C:/dev/video_project`. The dashboard UI is a separate project; its clone URL, environment, dependencies, and deployment are outside this handover's verified scope.

Read the architectural intent in [docs/backend-plan.html](docs/backend-plan.html), then [BUILD_STEPS.md](BUILD_STEPS.md). All original build steps 0–9 are marked done. Read this handover next for current behavior and corrections to historical notes, then [API_CONTRACT.md](API_CONTRACT.md) for integration details. For a discrepancy about implemented behavior, inspect the route/service and [Prisma schema](prisma/schema.prisma).

[CLAUDE.md](CLAUDE.md), [SESSION_HANDOFF.md](SESSION_HANDOFF.md), [AUDIT_BACKEND.md](AUDIT_BACKEND.md), [DASHBOARD_DATA_CONTRACT.md](DASHBOARD_DATA_CONTRACT.md), and [learnings.md](learnings.md) preserve useful history. Some statements are stale: the API contract's LAN-only hosting paragraph, the old claim that no dashboard exists, older seven-table diagrams, Claude references for analysis, and the claim that normalization is entirely unimplemented. Do not use these to undo working features. This handover does not rewrite their historical entries.

## Implemented system and decisions

- Express 5 and TypeScript, with API and worker as separate Node processes.
- PostgreSQL and Prisma 7 (`@prisma/adapter-pg`). Eight application models: clients, questions, distributors, segments, transcripts, sentiment results, jobs, rendered videos. Prisma connection and seed configuration live in `prisma.config.ts`, not a datasource URL inside `schema.prisma`.
- PostgreSQL is both data store and job queue. No Redis. Jobs are claimed atomically using `FOR UPDATE SKIP LOCKED`.
- S3 holds raw clips, SRT/VTT captions, optional captioned/normalized intermediate clips, question voiceovers, and rendered output. Store object keys in the database; generate fresh presigned URLs on reads.
- ElevenLabs `scribe_v1` handles transcription. Gemini handles analysis; the current source selects `gemini-3.5-flash-lite` in `src/services/gemini.ts`. Earlier notes name other models/providers. Confirm provider availability if the API rejects the configured model; this handover has not called those services.
- nexrender-cloud handles optional After Effects rendering. The backend does not require a local After Effects installation.
- One answer segment and one branded reel per question. No combined five-question video. Each confirmed answer proceeds independently.
- Auth resolves `{ distributor_id, client_id }` once in middleware. Distributor routes use their own identity; dashboard aggregates use their client's identity. Never accept a caller's client ID as an authorization decision.
- Questions are database records per client, localized to English/Hindi/Marathi. Fetch the current catalog rather than assuming five questions globally. `Question.id` is the stable UI/cache identity; `index` is ordering and the current upload identifier.
- Mobile playback is local-first, with `updated_at` for staleness. Raw segment playback and rendered-reel playback are separate endpoints.

### Real upload and processing sequence

1. Authenticate, then read `/distributors/me` and `/distributors/me/questions`.
2. `POST /segments/upload-url` with `{ question_index }` returns `{ upload_url, video_key }`.
3. PUT raw MP4 bytes directly to `upload_url` on S3.
4. `POST /segments/confirm` with `{ question_index, duration, trim_start_ms: null, trim_end_ms: null }`. Duration is a positive number in seconds. Optional capture metadata can be included. Sending `video_key` is harmless, but the backend derives the trusted key itself.
5. Confirm checks object existence, upserts the segment and inserts a `transcribe_segment` job in one database transaction.
6. The worker extracts audio directly from a presigned S3 URL through FFmpeg, calls ElevenLabs, uploads captions, and writes the transcript. It then runs Gemini analysis and stores the result. Successful `Segment.status` is `transcribed`.
7. Only when `ENABLE_REEL_RENDERING=true`, the transcription handler also burns captions and normalizes the answer before analysis/render queuing. It uploads `.captioned.mp4` and queues `render_segment` after the transcription handler's work. The render worker submits and polls nexrender, then marks `RenderedVideo.status` as `rendered`.

Normalization is currently part of `burnCaptions`, not a separately queued normalization job. With rendering disabled, both this pass and nexrender submission are skipped. Audio extraction/transcription/analysis still run. The normalizer targets 1080×1920, 30fps, square pixels, H.264/AAC, with scaling/padding and decoded orientation. A successful transcription-only stress run does not validate normalization or rendering.

Source map: `src/index.ts` mounts routes; `src/routes/segments.ts` handles upload/confirm; `src/routes/distributors.ts` exposes profile/questions/playback; `src/worker-main.ts` starts polling from `src/worker.ts`; `src/jobs/` contains handlers; `src/services/` contains S3, speech, analysis, captions, FFmpeg, questions, and render integrations.

### Accounts, clients, and dashboard

There are two implemented login paths. Seeded users use `POST /login` with username/password mapped in `src/config/seedAccounts.ts`. Self-registered internal participants use `POST /register` with `{ name, phone, password }` and later `POST /login/phone`. Registration returns only `{ token }`; `/distributors/me` supplies the ID. Phone numbers are unverified and normalized to their final ten digits; password minimum is six characters. JWTs expire after 30 days. Invite exchange is a planned direction, not an implemented replacement. There is no password-reset endpoint.

The seed defines IFB Appliances, Voltas, and Zeist, five original distributors split between IFB/Voltas, and five education questions per seeded client. Self-registration always places users under Zeist. Those script fixtures answer these questions, not questions about product satisfaction:

1. What did your education teach you that you still value today?
2. What's your best education memory, and why?
3. What do you wish your education had taught you?
4. What's better about education today, and what's worse?
5. If you could change three things about education, what would they be?

The dashboard API **is implemented** in `src/routes/dashboard.ts`. It includes summary, wordcloud, themes, theme-sentiment, highlights, response detail, questions, teacher-impact, life-skills, technical, and extraction-quality routes. These are read-only database/tokenization endpoints; loading a dashboard does not call an LLM. The old `/segments/sentiment` endpoint was removed.

`/dashboard/highlights` supports independent question, theme, teacher-contribution, life-skill, and sentiment-category filters. Sentiment buckets are positive at `>= 0.3`, negative at `<= -0.3`, and neutral between them. The response-detail route explicitly converts Prisma Decimal scores to JSON numbers. Use the full current shapes in `API_CONTRACT.md` rather than reconstructing them from UI labels.

Analysis includes sentiment score, constrained themes, emotional tone, summary, best quote, relevance, moderation, profanity, complaint, actionable feedback, highlight score, and fixed teacher/life-skills extraction. `Question.extraction_spec` is retained but dormant. Since the September 16 prompt change, `moderation_flag=true` means unsuitable for external use; older rows may retain the inverse meaning until intentionally reprocessed. Negative sentiment alone should not be treated as a moderation failure.

Dashboard routes are feature-gated but still use distributor JWT auth with client-wide scope. Separate production admin roles are not implemented. CORS origin allowlisting is browser access control, not an authorization boundary. Coordinate this with the dashboard owner before broadening access.

## New-laptop setup

Install Git, Node and npm, FFmpeg/ffprobe on PATH, and PostgreSQL client tools if using a local database or backups. This machine reports Node `v22.13.0`; the repository has no engine pin. Use a compatible Node 22 installation initially and the committed npm lockfile. The FFmpeg build needs `libmp3lame`, `libx264`, AAC and the `subtitles`/libass filter. Hindi/Marathi caption rendering also needs fonts with Devanagari coverage.

Clone and install from the repository root:

```powershell
git clone https://github.com/Soham908/testimonial-backend.git
cd testimonial-backend
git switch master
npm ci
```

Copy the private `.env` separately as planned. Review `DATABASE_URL`, browser origin allowlist and port for the new machine. `localhost` refers to the new laptop; an old LAN address will not follow it. Preserve `SESSION_SECRET` if deliberately continuing to use sessions against the same environment. Keep secrets and database backups outside Git.

`src/config/env.ts` currently requires all of these, including nexrender settings even when rendering is off: `DATABASE_URL`, `SESSION_SECRET` (at least 32 characters), `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `NEXRENDER_SERVER_URL`, `NEXRENDER_API_KEY`.

| Setting | Current default / purpose |
| --- | --- |
| `PORT` | `3000` |
| `ENABLE_REEL_RENDERING` | `false`; caption/normalization intermediate and new render queuing |
| `ENABLE_SELF_REGISTRATION` | `false`; `/register` and `/login/phone` |
| `ENABLE_DASHBOARD_ENDPOINTS` | `false`; internal `/dashboard/*` routes |
| `ENABLE_DEV_ENDPOINTS` | `false`; reserved, currently unused |
| `CORS_ALLOWED_ORIGINS` | Empty; comma-separated exact browser origins for dashboard requests |
| `MIN_APP_VERSION` | `0.0.0`; returned with profile |
| `JOB_VISIBILITY_TIMEOUT_MS` | `900000` (15 minutes); stale-processing reclamation |
| `WORKER_ID` | Process-derived logging identifier |

Only the literal string `true` enables each boolean flag. The flags on the running server must be checked there; this document does not infer their deployed values from `.env.example`. Mobile has its own `EXPO_PUBLIC_ENABLE_REEL_RENDERING` flag. nexrender's base URL must include `/api`; AWS region is a bare code such as `ap-south-1`, not a URL. Its S3 push-upload secrets live on nexrender-cloud, separate from this laptop's `.env`.

### Preserve database and cloud state

Cloning Git and copying `.env` do not move the database. Choose the intended environment before running any migration, seed, API, or worker:

- For the existing deployed backend/dashboard data, continue using its deployed API and authorized database access. Moving laptops does not require moving S3 objects or restarting EC2.
- To preserve a local database, privately transfer a current `pg_dump` custom-format backup and restore into a newly created, separate local database. The old `SESSION_HANDOFF.md` references a September Desktop backup; its existence and freshness were not checked for this handover. Create/check a current backup before retiring the old laptop. A fresh seed will not recreate stress-test users, IDs, transcripts or analysis.
- For a deliberately empty development database, apply committed migrations and then seed. Seed upserts known clients/distributors/questions; it can still update existing configuration. Do not seed an existing shared/deployed database just to set up a laptop.

Use PostgreSQL's prompted-password authentication or privately configured PG variables, rather than putting a password-bearing connection URL into a shell command or document. Example restore into an **empty local** database, after substituting your local role/backup path:

```powershell
createdb -h localhost -U LOCAL_ROLE -W testimonial_backend
pg_restore -h localhost -U LOCAL_ROLE -W --no-owner --no-privileges -d testimonial_backend C:/private/testimonial_backend.dump
```

Keep PostgreSQL client/server versions compatible with the backup. A restore includes schema and Prisma's migration history; inspect migration status for any later source migrations. Do not run a destructive reset or overwrite an existing database as a setup shortcut.

With the correct `.env` and database selected:

```powershell
node --env-file=.env node_modules/prisma/build/index.js generate
node --env-file=.env node_modules/prisma/build/index.js migrate status
# Apply only outstanding committed migrations to the intended database:
node --env-file=.env node_modules/prisma/build/index.js migrate deploy
# Empty development database only, if seed data is wanted:
node --env-file=.env --import tsx prisma/seed.ts
```

These direct Node commands avoid the old machine's intermittent `npx` launcher/Prisma environment-loading issues. Normal `npx prisma ...` is also usable when it works locally.

### Start and verify

```powershell
npm test
npm run build
npm run dev
```

In another terminal, after confirming its `DATABASE_URL` points at the intended queue:

```powershell
npm run worker
```

Starting a worker can immediately consume pending jobs and make paid API calls. Do not start a laptop worker against the deployed queue merely to check installation. The API can run without a local worker if testing reads only. `GET http://localhost:3000/health` returns `{ "status": "ok" }`, but does not test DB/S3/provider connectivity.

Verify login/profile, question catalog and dashboard reads with the appropriate client account. An IFB token does not show Zeist stress records. For local dashboard development, add its actual origin (often `http://localhost:5173`) to API `CORS_ALLOWED_ORIGINS`; configure the dashboard's API URL in that project's own environment. For a physical phone on local Wi-Fi, use the laptop's LAN address and permit the API port through its firewall.

Unit tests mock Prisma/external services and use dummy settings from `tests/setup.ts`. Passing them verifies code behavior, not external credentials. `npm run jobs:list` is a real read against the configured database and lists terminal failures, abandoned processing, and jobs awaiting retries.

## Deployment continuity and timings

The last deployment **reported by the user in September** was `https://insight-backend.thezeist.com`, on EC2 with PM2 and a `worker` process. Current EC2 host, database location, process definitions, proxy/TLS configuration, and live revision were not inspected during this handover. App Runner/RDS in older documents is architectural intent, not evidence of the live topology. The checkout has no committed PM2 ecosystem file or complete deployment runbook; privately preserve SSH access, host alias, working directory, actual PM2 start commands/environment and logs before decommissioning the old laptop. Do not commit private keys.

If deploying a later code change: inspect the remote branch/revision and database target, pull approved changes, install lockfile dependencies, generate Prisma, apply required migrations, build, then restart the actual API and worker services. A documentation-only laptop handover does not require redeploying the running service.

One worker awaits one job handler at a time. Additional worker processes can claim different jobs safely via `SKIP LOCKED`. Idle polling is one second; failed jobs retry with 30-second exponential backoff capped at ten minutes, default five failures before terminal status. `attempts` counts failures/reclaims, not every successful initial execution. A lock token prevents an old worker from overwriting a reclaimed job's queue bookkeeping; it does not prevent all simultaneous external side effects. Paid stages check stored results for resumability.

Current timing instrumentation is log-based: per-stage `stage=... ms=...` and successful handler `TOTAL`. `jobs` has created/updated times and retry scheduling, but no dedicated started/completed timestamps, duration columns, or attempt-history table. The user planned backend timing improvements; those are not present in this checkout. Queue waiting and worker execution are distinct. Subtracting a final job row's timestamps is not a reliable full-batch stopwatch across retries or multiple workers.

Historical September worker logs showed about 5.1–5.5 seconds per transcribe/analyze job with rendering disabled; the user reported the final job's created-to-updated interval around 10m24s for the first bulk run. These are observations, not a throughput guarantee. No fresh live performance test was run for this handover.

## Portable synthetic datasets and test tooling

The original `codex-stress-test/` is locally ignored and will not arrive through Git. This handover adds a small, Git-tracked copy at [tools/stress-test/](tools/stress-test/) containing the scripts, generators, manifests and submission reports. It excludes media, secrets and local logs. The two datasets contain 150 scripted answers, not genuine distributor feedback; keep that distinction when interpreting dashboard metrics.

| Round | Dataset | History |
| --- | --- | --- |
| Original | 20 fake distributors × 5 answers, primarily positive/mixed | 100/100 submitted, 0 failures, 44.154s submission wall clock |
| Round 2 | 10 additional distributors × 5 answers, more critical but mixed | 50 VOs/videos generated; 50/50 submitted, 0 failures, 22.852s submission wall clock |

Both are romanized Hinglish, approximately 140–160 words each, using the education questions above. Round 2 broadens tone/theme coverage; its existence does not prove the combined dashboard is statistically balanced. Confirm actual stored sentiment to assess balance.

Original TTS history: 91,292 characters, estimated $4.5664. Round 2: 48,766 characters, estimated $2.4383. Those estimates used a historical $0.05/1,000-character assumption for Flash v2.5, not a current billing quote. TTS generators reuse the same project-selected voice and save each file locally for reuse. Manifests retain historical generation paths/metadata; they do not include the audio/video bytes.

For exact reuse without more TTS charges, privately copy the old MP3/MP4 folders into the matching layout under `tools/stress-test/`: `audio/`, `videos/`, `round-2/audio/`, `round-2/videos/`. To regenerate videos, also copy `sample video.mp4`; it is not in Git. Generators resolve from their own directory. Round 2 adds an explicit duration limit for a stream-copy loop-boundary issue. Video creation drops the source audio, loops the captured visual, copies its video stream, and inserts the new AAC VO. Lip sync is deliberately irrelevant to this pipeline fixture.

Read [tools/stress-test/README.md](tools/stress-test/README.md) for exact commands and limitations. The upload runner defaults to **no network requests** until `--execute` is supplied; `--smoke` means one distributor with all five questions. Default concurrency is five distributors, sequential questions within each distributor. It registers new accounts, not merely fake local identities. Use a fresh run ID to avoid phone conflicts. Registration is limited to 20 attempts/IP/15min; global API limit is 300/IP/15min. Five concurrent distributors does not mean five simultaneous backend processing workers.

Current runner-created accounts use the deliberately simple internal-test password `password`; the first September 17 smoke account predates this convention. Reports record distributor IDs, timings, video keys and the run ID, not session tokens. Phone identity is reproducible from the run ID and sorted distributor position. After a laptop move, log in afresh rather than relying on old 30-day JWTs. Existing accounts, raw clips and analysis remain in their database/S3 environment without local media copies.

The runner reports **submission only**. It does not poll processing completion, save returned segment IDs, or measure queue/stage durations. A successful confirm triggers asynchronous work but does not prove it finished. Inspect worker/job state and dashboard records before claiming end-to-end success.

## Known limitations and continuation priorities

1. **Retakes can keep stale results.** Confirm overwrites the deterministic raw key/upserts the same segment, but the worker skips existing transcript/sentiment/captioned/rendered artifacts. Revision-aware invalidation is still needed. Fresh stress accounts avoid masking this bug but do not fix it.
2. **Template work remains.** Historical After Effects tests showed a fixed answer duration (~30s despite a longer source) and framing/rotation problems. Normalization was added, but the real template and multiple source aspect ratios still need validation. Rendering is off by default.
3. **Admin authentication is incomplete.** Dashboard uses client-scoped distributor sessions, not distinct admin roles. Self-registration and simple test passwords are internal testing provisions.
4. **Timing persistence is unimplemented in this checkout.** Preserve queue/attempt/stage timings if that is the next task; do not infer they exist because PM2 logs show durations.
5. **Retried render submissions and long polling need care.** Rendering occupies a worker while polling (ten-minute provider wait limit); visibility timeout defaults to fifteen minutes. No webhook-based completion flow is implemented.
6. **Intermediate media and retention.** Enabled rendering reads raw video for audio extraction and again for caption burn-in and stores an extra captioned copy. No general lifecycle/retention policy is defined here. Large-source size and delivery/WhatsApp sizing remain product decisions.
7. **Missing confirm recovery.** A killed client may upload to S3 without confirming. No S3-event backstop exists. Check real mobile background transfer before building that redesign.
8. **Prompt/data versions.** Older sentiment rows can have legacy moderation/extraction semantics. New analysis code does not automatically backfill them. Reprocessing needs explicit invalidation because stored results are intentionally reused.

The user works as a solo builder reviewing generated code. Give a clear recommendation with evidence, keep tasks scoped, and preserve concurrent-session edits. Earlier mobile UX discussion favored reviewing/trimming one question at a time and prioritizing footage quality; implementation belongs to the mobile repo and is not verified here.

## Handover verification

On 2026-10-26, the existing unit suite passed (6 files, 55 tests) and TypeScript checking passed using the installed local compiler (`tsc --noEmit`). Both copied datasets were checked against the original text, with 20/10 identities and exactly questions 1–5 per identity. All copied JSON parses, and the handover/toolkit's local Markdown links resolve. No service was deployed, database migrated/restored/seeded, media regenerated, or live upload performed as part of this handover. Re-run the setup checks on the new laptop; these results do not certify its dependencies or credentials.

## Prompt to resume work on the new laptop

> This is the testimonial backend repository. Read `docs/backend-plan.html`, `BUILD_STEPS.md`, then `BACKEND_HANDOVER.md` and `API_CONTRACT.md`. Treat older handoff/audit notes as historical where current code differs. The mobile app and dashboard UI are separate repositories; this repo contains their backend contracts and dashboard API. Check Git status before editing. Configure private `.env` separately and establish the correct database before running migrations, seeds, workers, or stress uploads. The portable synthetic fixtures/tooling are in `tools/stress-test/`; audio/video bytes are optional private transfers. Continue with the specific task I provide next.
