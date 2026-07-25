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
if the mobile app is force-quit or killed mid-upload, the PUT to S3 may never
finish and POST /segments/confirm may never get called — right now there's no
way to detect an orphaned S3 object with no DB row behind it, since confirm is
entirely client-driven. Standard fix would be an S3 event notification
(ObjectCreated -> SQS/Lambda) as a backend-side backstop that doesn't depend
on the client ever confirming — but whether this is worth building depends on
whether the mobile app implements real OS-level background transfer at all
(iOS background URLSession / Android WorkManager) — that's a video_project
question, not this repo's, and should be checked there before over-building a
backstop for a risk that might not exist in practice. note: confirm itself
already has no time limit, so a *late* confirm (app reopened later) already
works fine as-is — this is only about confirm never arriving at all.
render_segment currently blocks a worker for the entire render duration by
polling nexrender-cloud to completion. A webhook would free that worker
immediately instead, but it's a real redesign, not a small swap: needs a
publicly reachable HTTPS endpoint (only exists once actually deployed, not in
local dev), payload signature verification, splitting render_segment into a
submit phase and a separate webhook-triggered completion phase, and still
needs a fallback poll/timeout since webhooks can get dropped. Not worth it
before there's enough concurrent render volume for worker capacity to
actually be the bottleneck — and nexrender-cloud's webhook support hasn't
actually been confirmed in their docs yet, only their polling API has.
admin dashboard was forgotten from scope entirely and needs to be designed
and built. sentiment_results (sentiment score, themes, summary, best quote,
relevance/moderation/complaint flags, highlight score) is being written
correctly per segment but has no real admin-facing surface — only a
temporary test-only endpoint (GET /segments/sentiment in segments.ts, scoped
by client_id, explicitly not part of the documented API surface). This data
is intentionally never distributor-facing; it needs a real admin/company view
built once that phase starts.

what would be a better approach for the recording of the testimonial
so right now, what we are doing is, in 1 single flow, all of the questions are asked and need to be answered
which is causing a lot many issues, like, once the video gets recorded the user can just click a button, are you ok with this
and cannot check out the entire video, if it is to their liking and then proceed
also, something like, they have to again and again come close to the screen and then go back again
either way, it is not a flawless thing, where everything is automated and everything just works as in ideal scenario, where once the question starts, 5 questions are asked in an actual F&Q/testimonial way
where questions are automatically asked, the user is then asked, are you done with your answer -> stop recording -> are you ok with your answer and everything continues working and the next question beings
it is not an end to end fully automated flow and that would be too hard to implement and honestly not viable

so would it be better to take an approach where we do something like, the user will have to answer 1 question at a time and then go through that questions flow
and we can focus on this now, and make sure that each video cut is proper and professional
so instead of focusing on improving the smoothness, we focus on the quality, cause yes, smoothness would be god, but the most important thing for the app is going to be the quality of the video
and what we need to do is, showcase the user then and there, after the question to view the video, if they like it or not
if they want to edit it out, or take the auto suggestion where the last 2 secs are clipped cause the user comes closer to stop hte video, so we snip that 
and focus on getting the most quality out of that specific video

cause the idea here is going to be something like, this app is going to be used 1 time only, for now, im testing and it makes sense to have it in 1 flow, and have try the smoothness angle
but in real world scenario, either way the user is going to be using it 1 time (considering there are no future campagins, which there could be if the company likes it)
so either way the user is going to be recording it once only, or they would want to put in the effort right, else it would not matter for hte branded reel at the end either way
so, what we would want to do is something like, focus on the quality entirely and forget about the smoothness

that would also resolve a lot of issues that we are facing, and it would obviously add a little bit of resistance, where you would have to keep adding 1 by 1 and it can be a little annoying
but we need to think in terms of the end user as well right, we are doing it multiple times for testing purpose
but the end user is just going to be using it once right, so why not make that one time thing a splendid experience
and focus on what is important, instead of just trying to make something smooth
let it be a little rigid, let it be a little repetitive, they dont have to open it daily and take videos right

obviously it is not a simple decision to make, but we need to consider this is what im syaing


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
