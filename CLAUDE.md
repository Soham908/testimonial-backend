# Project context — testimonial app backend

##
note for me - things that need to be resolved in the future, super important
how to handle people talking too much, for example video goes above 1 min, how to handle that
how to handle, each mobile phone giving different ratio output for the video
if we want to send this via Whatsapp, how to ensure that the video is small enough size for the testimonial video or anything, the video needs to be a servable size right not 100mb
render pipeline caption burn-in reads the segment video twice (once for audio
extraction in transcribe_segment, once again for burning subtitles before
sending to nexrender) and stores an extra full-size video copy in S3 as an
intermediate artifact — chosen deliberately for speed of first implementation,
not because it's the right long-term shape. Revisit once there's real usage:
burn captions on nexrender's final output instead (using a fixed per-question
time offset, since the intro VO durations are static) to cut this down to one
extra pass instead of two, with no extra stored video at all.
nexrender template's answer segment has a static/fixed duration right now
(step 7 test render came out 30s despite a ~58s source clip) — needs to be
made dynamic instead, driven by the actual footage length. User has already
worked out an approach for this from prior testing, not yet implemented here.
first real step-7 render came out zoomed in — the answer footage got
cropped/scaled to fill the template's expected frame rather than fitting it
cleanly, likely the aspect-ratio mismatch from the "different phone ratios"
item above actually showing up in practice. Needs a fix on the template
and/or how footage is fit into it.

## What this is
Server-side counterpart to the React Native testimonial app. Handles everything
once a recorded segment leaves the device: upload, transcription, sentiment
analysis, and branded rendering.

**This is a separate project from the mobile app at `C:/dev/video_project`.**
Sibling repo, not a subfolder of it, not sharing a `CLAUDE.md`. Don't pull
mobile-app context (camera guidance, frame processors, recording flow) into
reasoning about this codebase — none of it applies here.

## Read these first, in order
1. `docs/backend-plan.html` — full architecture: schema, both job pipelines,
   API surface, identity/scoping model, engineering principles. This is the
   source of truth for every design decision below. Don't re-derive a decision
   that's already made there.
2. `BUILD_STEPS.md` — the build sequence, one verifiable `/goal` per step.
   Check which steps are already marked done before starting new work.

## Stack
Express + TypeScript · Postgres + Prisma · Postgres-backed jobs table (no
Redis yet — `SELECT ... FOR UPDATE SKIP LOCKED`) · S3 · AWS App Runner + RDS
(eventual hosting) · ElevenLabs Scribe (STT) · Claude API (sentiment/themes) ·
nexrender + After Effects (render)

## Locked decisions worth remembering mid-session
- One branded reel per question, not one merged video — render fires per
  segment, at the same trigger point as transcription, not gated on all 5
  segments being uploaded.
- Mobile playback is local-first, using each segment's `updated_at` to detect
  staleness — no separate video-id field exists or is needed.
- Identity is two-phase: Phase A (now) is username/password against 5 seeded
  dummy accounts split across 2 dummy clients. Phase B (client-ready) swaps in
  invite-token exchange — only the login step changes; every route downstream
  of the auth middleware stays untouched either way.
- Two-tier scoping (distributor + client) is enforced structurally through one
  auth middleware — no data-access function should be callable without that
  context already resolved.

## Environment
Needs a populated `.env` — see `.env.example` for the required variable list.
Needs a running local Postgres instance before any migration step can run.
Config validation should fail loudly at startup if anything required is
missing, per the fail-fast principle in backend-plan.html.

## Working style
Solo builder, reviews/QAs Claude Code's output rather than writing it directly.
Run one `BUILD_STEPS.md` step at a time as its own scoped `/goal` — don't
chain multiple steps into a single run. When asked to make a call, give one
clear recommendation with reasoning, not a menu of options.
