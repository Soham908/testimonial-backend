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
- [ ] Done

```
/goal package.json exists with Express + TypeScript configured, the folder 
structure (routes/, middleware/, services/, jobs/, db/, config/) exists, 
.env.example lists every variable named in backend-plan.html, .env is listed in 
.gitignore before any commit is made, CLAUDE.md exists summarizing the 
architecture from backend-plan.html, and git is initialized with an initial 
commit — or stop after 10 turns and report what's incomplete.
```

## 1 — Schema
- [ ] Done

```
/goal prisma/schema.prisma matches all 7 tables in backend-plan.html exactly — 
fields, types, relations, the unique constraint on (distributor_id, 
question_index) for segments, and segment_id (not distributor_id) as the key on 
rendered_videos — the initial migration applies cleanly to the local Postgres 
database, and npx prisma validate passes — or stop after 10 turns and report the 
blocker.
```

## 2 — Seed data
- [ ] Done

```
/goal prisma/seed.ts creates 2 dummy clients and 5 dummy distributors split 
across them (not all 5 under one client), running the seed script populates the 
database with exactly these rows, and a query confirms all 7 rows exist — or 
stop after 8 turns and report the blocker.
```

## 3 — Auth
- [ ] Done

```
/goal POST /login authenticates against the seeded accounts and returns a 
session token, the auth middleware resolves that token into 
{ distributor_id, client_id } on every request, and a request with a missing or 
invalid token demonstrably fails rather than returning data — or stop after 12 
turns and report the blocker.
```

## 4 — Upload flow
- [ ] Done

```
/goal POST /segments/upload-url returns a valid presigned S3 URL scoped to one 
object key, POST /segments/confirm upserts the segment row respecting the 
(distributor_id, question_index) uniqueness, and confirming a segment queues 
both a transcribe_segment job and a render_segment job in the jobs table — or 
stop after 12 turns and report the blocker.
```

## 5 — Worker skeleton
- [ ] Done

```
/goal worker.ts runs as an independent process from the API, polls the jobs 
table using SELECT ... FOR UPDATE SKIP LOCKED, successfully claims a pending 
job and marks it processing then done, and two worker instances running at the 
same time never claim the same job — or stop after 10 turns and report the 
blocker.
```

## 6 — Transcription pipeline
- [ ] Done

```
/goal the transcribe_segment job handler extracts audio via ffmpeg, sends it to 
ElevenLabs Scribe, writes the transcript and SRT/VTT keys to the transcripts 
table, sends the transcript to the Claude API for sentiment and theme 
extraction and writes sentiment_results, and re-running the job when a result 
already exists does not call either paid API again — or stop after 15 turns and 
report the blocker.
```

## 7 — Render pipeline
- [ ] Done

```
/goal the render_segment job handler calls nexrender with the segment's clip 
and the client's branding config, uploads the rendered output to S3, and writes 
the resulting row to rendered_videos — or stop after 15 turns and report the 
blocker.
```

## 8 — Read endpoints
- [ ] Done

```
/goal GET /distributors/me/segments returns all 5 segments with status and a 
valid presigned playback URL for each, GET /distributors/me/rendered-video 
returns the reel's status and presigned URL once ready, and both responses 
include each row's updated_at — or stop after 10 turns and report the blocker.
```

## 9 — End-to-end smoke test
- [ ] Done

```
/goal a single real test video, pushed through the full flow, results in a 
segment row, a transcript, a sentiment result, and a rendered reel, all 
retrievable through the read endpoints with correct URLs — or stop after 15 
turns and report exactly which stage broke.
```
