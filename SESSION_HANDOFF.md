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
*This file was NOT committed/pushed automatically — ask the user whether
they want it committed and pushed to `origin/master` so it's pullable from
the other laptop, since that's a shared/remote-visible action.*
