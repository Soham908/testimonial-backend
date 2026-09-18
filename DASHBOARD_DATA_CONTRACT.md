# Dashboard data contract — what this backend actually produces

Written for a separate dashboard-prototype project building fake data. This
describes only what exists in this repo's code — no code was changed to
produce it. Sections 1–6, 9, and 10 are strict code description. Section 7 is
explicitly labeled as judgment/assumption (fixture guidance, not derived from
real production data — none exists yet). Section 8 does arithmetic on top of
section 7's assumptions and says so.

**Refreshed 2026-09-16** against `master` as of that date, to fold in a
session of real backend work since this doc was first written: a fixed (no
longer inverted) `moderation_flag`, a constrained theme vocabulary, two new
`sentiment_results` columns, `Question` becoming a real per-client DB table
(it wasn't when earlier parts of this doc were first drafted), and 8 new
`GET /dashboard/*` endpoints (§10) that supersede the old `GET /segments/
sentiment` test endpoint referenced throughout the original version of this
doc — that route no longer exists. Everything below reflects current code,
not a diff against the prior version.

---

## 1. Every Prisma model, field by field

Source: `prisma/schema.prisma`. 8 models, 2 supporting job-type enums, 3
lifecycle-status enums.

### `Client` → table `clients`

| Field | Type | Nullable | Written by | Read by |
|---|---|---|---|---|
| `id` | `String` (uuid, PK) | no | `prisma/seed.ts` only | Used as FK target everywhere (`distributor.client_id`), never selected/returned by any route |
| `name` | `String` | no | `prisma/seed.ts` only | **Not read by any route or job.** Written, never consumed. |
| `branding_config` | `Json` | no | `prisma/seed.ts` only | Only the `nexrender_template` key inside it is actually read (`renderSegment.ts`). The other keys present in seed data (`logo_url`, `primary_color`) are written but **never read by any code path**. `Json` type means Prisma/Postgres impose no shape constraint at all — nothing stops a row from having none, some, or extra keys. |
| `created_at` | `DateTime` (default now) | no | auto | Never read/returned |
| `distributors` | relation → `Distributor[]` | — | — | Schema defines this relation; no query in the codebase actually traverses `Client → distributors`. All real joins go the other direction (`Distributor → client`). |

### `Question` → table `questions`

**Real DB table, not hardcoded application config.** An earlier version of
this doc (and still, in places below where noted) assumed questions lived in
a `src/config/questions.ts` object literal with no DB backing — that's no
longer true. Every client has its own `Question` rows now.

| Field | Type | Nullable | Written by | Read by |
|---|---|---|---|---|
| `id` | `String` (uuid, PK) | no | `prisma/seed.ts` only | Returned by `GET /distributors/me/questions` as the stable identity key (survives reorders/edits — `index` doesn't) |
| `client_id` | `String` | no | seed only | Scoping (`WHERE client_id = ...`), the `(client_id, index)` unique constraint |
| `index` | `Int` | no | seed only | Ordering (`ORDER BY index`), and the *application-level* link to `Segment.question_index` — see below, this is not a real FK |
| `is_branded` | `Boolean` (default `false`) | no | seed only, always `false` in every seeded row today | Returned by `GET /distributors/me/questions`; not otherwise branched on anywhere in this codebase |
| `text_en` / `text_hi` / `text_mr` | `String` | no | seed only | `src/services/questions.ts` (`localizeQuestion`) picks one based on the caller's language; also the question text embedded in the Gemini sentiment prompt (`transcribeSegment.ts`) |
| `vo_key_en` / `vo_key_hi` / `vo_key_mr` | `String` | no | seed only | `localizeQuestion` picks one; used to presign `vo_playback_url` in `GET /distributors/me/questions` |
| `extraction_spec` | `Json` | yes | seed only, always `null` in every seeded row | **Currently dormant.** Not read by `src/services/gemini.ts` as of the 2026-09-16 prompt rewrite (§2) — that rewrite hardcodes a fixed `extracted` shape instead of building one per question. Kept in the schema for a possible future per-question reactivation. |
| `talking_points` | `Json` (`{en, hi, mr}`, each `string[]` or `null`) | yes | seed only | `localizeQuestion`; returned by `GET /distributors/me/questions` as on-screen recording nudges |
| `created_at` | `DateTime` | no | auto | Never read/returned |
| `updated_at` | `DateTime` (`@updatedAt`) | no | auto | Returned by `GET /distributors/me/questions` — the mobile app's local-first cache key for this question (same pattern as `Segment.updated_at`) |
| `client` | relation → `Client` | — | — | — |

`@@unique([client_id, index])` — **this is the closest thing to a link
between a `Segment` and its `Question`, and it's application-level, not a
real foreign key.** `Segment.question_index` is a plain `Int` column with no
`@relation` to `Question` at all. `POST /segments/upload-url` and
`POST /segments/confirm` (`src/routes/segments.ts`) validate a submitted
`question_index` by running `prisma.question.findUnique({ where: {
client_id_index: { client_id, index } } })` and rejecting (`400`) if nothing
comes back — well-formedness (`> 0`, integer) is checked separately from
actual existence for this client. There is **no fixed 1–5 (or any other)
range hardcoded anywhere** — a client's active `question_index` values are
exactly whatever `Question` rows exist for it, nothing more, nothing less.

Seeded today (`prisma/seed.ts`): all 3 dummy clients (IFB, Voltas, Zeist) get
the **same 5 questions**, an "education" theme used to validate the app's
mechanics — matching the topic framing in the Gemini prompt (§2). Every
seeded question has a real VO key generated per client/language/index
(`static/question-vo/{client_id}/{lang}/{index}.mp3`) — **not yet uploaded to
S3** (a forward reference, same convention as `Segment.video_key` before
upload), so `GET /distributors/me/questions`'s `vo_playback_url` field will
presign a URL to an object that doesn't exist yet for any client that hasn't
had real VO audio uploaded.

### `Distributor` → table `distributors`

| Field | Type | Nullable | Written by | Read by |
|---|---|---|---|---|
| `id` | `String` (uuid, PK) | no | seed only | Everywhere — this is `req.auth.distributor_id`, the primary scoping key for nearly every query |
| `client_id` | `String` | no | seed only | `req.auth.client_id`, `buildSegmentVideoKey`, `GET /dashboard/*` scoping (§10) |
| `name` | `String` | no | seed only | **Actually used**: rendered as the `Distributor_Name` text layer in the final video (`renderSegment.ts`). In seed data this holds a *business* name ("Ramesh Traders"), not a person's name. |
| `phone` | `String` | no | seed only | **Never read by any route or job.** Stored, unused. |
| `invite_token` | `String` (unique) | no | seed only | `login.ts` — the actual join key between a hardcoded login credential and this row. Functions as an internal lookup key today, not a real invite-redemption token (see §9). |
| `language_pref` | `String` | no | seed only | **Never read by any route or job.** Not used to select transcription language (ElevenLabs auto-detects), not returned by any endpoint. Free-form string, no enum constraint at the schema level — only `"en"`/`"hi"` appear in the actual seed data. |
| `created_at` | `DateTime` | no | auto | Never read/returned |
| `client` | relation → `Client` | — | — | Traversed: `renderSegment.ts` (`distributor.client.branding_config`) |
| `segments` | relation → `Segment[]` | — | — | Traversed via `distributor_id` filters, not literal Prisma `include` |

**No `status`/`active` field exists on `Distributor` at all** — see §4/§9.

### `Segment` → table `segments`

| Field | Type | Nullable | Written by | Read by |
|---|---|---|---|---|
| `id` | `String` (uuid, PK) | no | auto on create | FK target for `Transcript`/`SentimentResult`/`RenderedVideo`; returned in the confirm response |
| `distributor_id` | `String` | no | `segments.ts` (from `req.auth`) | Scoping filter everywhere |
| `question_index` | `Int` | no | `segments.ts` (request body, validated as a positive integer, then checked for existence against `Question` per client — no hardcoded numeric range, see §3) | Render config lookup, response payloads, the `(distributor_id, question_index)` unique constraint |
| `video_key` | `String` | no | `segments.ts` — **server-derived**, never trusted from the client (see the IDOR fix in the security audit) | S3 operations, captioned-key derivation |
| `status` | `SegmentStatus` enum | no, default `recorded_local` | `segments.ts` sets `"uploaded"`; `transcribeSegment.ts` sets `"transcribing"` / `"transcribed"` / `"failed"` | Returned in `GET /distributors/me/segments` |
| `duration_seconds` | `Int` | no | `segments.ts` (client-supplied, rounded server-side, must be `>0`) | Returned in `GET /distributors/me/segments`; `/dashboard/technical`'s `average_duration_by_question` (§10) |
| `capture_metadata` | `Json` (`{file_size_bytes, width, height, fps, codec, device_model, os_version}` per `POST /segments/confirm`'s contract — not shape-validated by this backend) | yes | `segments.ts` (client-supplied at confirm time, best-effort) | `/dashboard/technical`'s `devices`/`resolutions` breakdowns (§10) — only over segments where this is non-null |
| `created_at` | `DateTime` | no | auto | Returned in the read endpoint |
| `updated_at` | `DateTime` (`@updatedAt`) | no | auto, **overwritten on every status change** | Returned in the read endpoint — this is the field the mobile app's local-first cache comparison relies on |
| `distributor` | relation | — | — | Scoping joins |
| `transcript`, `sentiment_result`, `rendered_video` | relations (1:1, optional) | — | — | Existence-checked (`isNot: null`), joined for question_index, etc. |

`SegmentStatus` enum values: `recorded_local`, `uploaded`, `transcribing`,
`transcribed`, `failed`.
**`recorded_local` is never written by any code in this repo** — the first
write any `Segment` row ever receives is `"uploaded"` at confirm time; a
`Segment` row doesn't exist before that. It's a dead value from this
backend's perspective (presumably meant for on-device-only state the mobile
app tracks locally, never sent here).

**Important for a dashboard**: `status: "failed"` on a `Segment` means the
*transcription* pipeline failed (audio extraction, ElevenLabs, caption
burn-in, or Gemini). **A render failure does not touch `Segment.status` at
all** — `renderSegment.ts` only ever writes to `RenderedVideo`. A segment can
sit at `status: "transcribed"` forever while its `RenderedVideo.status` is
`"failed"`. These are two independent status fields, not one funnel.

### `Transcript` → table `transcripts`

| Field | Type | Nullable | Written by | Read by |
|---|---|---|---|---|
| `id` | `String` (uuid, PK) | no | `transcribeSegment.ts` | Never read back individually |
| `segment_id` | `String` (unique) | no | same | FK/lookup |
| `text` | `String` | no | same (ElevenLabs output) | Fed into the Gemini prompt (`transcribeSegment.ts`) — **never returned by any API route** |
| `language_detected` | `String` | no | same (ElevenLabs `language_code`) | **Never read anywhere after being written.** Free-form string, ElevenLabs' vocabulary, not this repo's. |
| `srt_key` | `String` | no | same | Fetched internally to burn captions onto the video — **never returned by any route** |
| `vtt_key` | `String` | no | same | **Fully dead after write** — generated and uploaded to S3, stored in this column, but nothing in the codebase ever reads it back. Only the SRT file is actually used (for caption burn-in). |
| `created_at` | `DateTime` | no | auto | Never read |

**No API route returns any `Transcript` field.** The mobile app has no
documented way to fetch transcript text or caption files.

### `SentimentResult` → table `sentiment_results`

Most fields are written together in one `create` call (`transcribeSegment.ts`),
sourced from one Gemini response. See §2 for exact semantics. **`GET
/segments/sentiment`, this table's original read path, no longer exists** —
removed once the `GET /dashboard/*` endpoints (§10) superseded it. The "Read
by" column below now points at those.

| Field | Type | Nullable | Read by |
|---|---|---|---|
| `id` | `String` (uuid, PK) | no | Never selected/returned |
| `segment_id` | `String` (unique) | no | FK, used for the join, not directly selected |
| `sentiment_score` | `Decimal` | no | `/dashboard/summary`, `/dashboard/theme-sentiment`, `/dashboard/highlights` |
| `themes` | `Json` (array of strings, **constrained** — see §2) | no | `/dashboard/themes`, `/dashboard/theme-sentiment`, `/dashboard/wordcloud` (indirectly, via which transcripts are pulled) |
| `emotional_tone` | `String` | **yes** — added 2026-09-16; rows analyzed before that date have `null` here, never backfilled automatically | Not currently read by any `GET /dashboard/*` endpoint — written, not yet surfaced in a report |
| `summary` | `String` | no | Not currently read by any `GET /dashboard/*` endpoint |
| `best_quote` | `String` | no | `/dashboard/highlights` |
| `is_relevant` | `Boolean` | no | `/dashboard/extraction-quality` |
| `moderation_flag` | `Boolean` | no | `/dashboard/highlights` (excludes `true` rows — see §2 for the **corrected**, no-longer-inverted meaning) |
| `contains_profanity` | `Boolean` | **yes** — added 2026-09-16, same nullability/backfill caveat as `emotional_tone` | `/dashboard/extraction-quality` |
| `contains_complaint` | `Boolean` | no | `/dashboard/themes` (the complaint-filtered breakdown) |
| `actionable_feedback` | `String` | yes | Not currently read by any `GET /dashboard/*` endpoint |
| `highlight_score` | `Decimal` | no | `/dashboard/highlights`, `/dashboard/extraction-quality` |
| `extracted` | `Json` (fixed shape as of 2026-09-16 — see §2) | yes | `/dashboard/teacher-impact` (`extracted->>'mentions_teacher'`, `extracted->>'teacher_contribution'`) |
| `created_at` | `DateTime` | no | Not currently read by any `GET /dashboard/*` endpoint |

### `Job` → table `jobs`

| Field | Type | Nullable | Written by | Read by |
|---|---|---|---|---|
| `id` | `String` (uuid, PK) | no | auto | `worker.ts` (update-where, logging) |
| `type` | `JobType` enum | no | `segments.ts`, `transcribeSegment.ts` | `worker.ts` — dispatch key into the handler map |
| `payload` | `Json` (always `{segment_id: string}` in practice) | no | same | Destructured in both handlers; queried via JSON path (`payload->>'segment_id'`) in the duplicate-render-job guard |
| `status` | `JobStatus` enum | no, default `pending` | worker claim/update | Claim query filters `WHERE status='pending'`; nothing else reads it |
| `attempts` | `Int` | no, default 0 | incremented on failure | **Never read anywhere.** No retry logic consumes it — it's a write-only counter today. |
| `last_error` | `String` | yes | set on failure | **Never read by any route.** No endpoint exposes job errors; only visible via server console logs. |
| `created_at` | `DateTime` | no | auto | `ORDER BY created_at` in the claim query |
| `updated_at` | `DateTime` (`@updatedAt`) | no | auto + explicit `SET now()` in the claim query | Never explicitly read/returned |

`JobType` enum: `transcribe_segment`, `render_segment` — both real, both
used, no others exist.
`JobStatus` enum: `pending`, `processing`, `done`, `failed`. No transition
from `failed` back to `pending` exists anywhere (no retry — see §4).

### `RenderedVideo` → table `rendered_videos`

| Field | Type | Nullable | Written by | Read by |
|---|---|---|---|---|
| `id` | `String` (uuid, PK) | no | auto | Never read/returned individually |
| `segment_id` | `String` (unique) | no | `renderSegment.ts` | FK/lookup |
| `video_key` | `String` | no | same — set from nexrender's `outputUrl`, **before the file exists in S3** | Used to build `playback_url`, only once `status === "rendered"` |
| `status` | `RenderedVideoStatus` enum | no, default `pending` | same | Branches `playback_url` logic; returned in `GET /distributors/me/rendered-videos` |
| `created_at` | `DateTime` | no | auto | Never read/returned |
| `updated_at` | `DateTime` (`@updatedAt`) | no | auto | Returned in the read endpoint |

`RenderedVideoStatus` enum values: `pending`, `rendering`, `rendered`,
`failed`. **`pending` is never actually produced** — the only place a row is
created (`renderSegment.ts`'s `upsert`) always sets `status: "rendering"`
explicitly on both `create` and `update`, bypassing the schema default.
A `RenderedVideo` row's real observed states are only `rendering`,
`rendered`, `failed`.

---

## 2. The analysis output, in detail

**Provider**: Google Gemini, model **pinned** to `gemini-3.5-flash-lite`
(not `-latest` — that auto-updating alias silently landed on a far more
quota-constrained model in the family; see the comment in
`src/services/gemini.ts` for the incident that motivated pinning it), via
`@google/genai`. One call per segment, structured JSON output
(`responseSchema`, not prompt-parsed text) — the schema itself enforces the
constrained vocabularies below (Gemini's structured output rejects values
outside a declared `enum`), not just prompt wording.

**Rewritten 2026-09-16** — everything in this section describes the *current*
prompt/schema. `sentiment_results` rows written before that date were
produced by an earlier, materially different prompt (unconstrained
free-text `themes`, no `emotional_tone`/`contains_profanity`/`extracted`
fields, and — critically — an **inverted** `moderation_flag`, see below).
Those old rows are not reprocessed automatically; they carry old-prompt
values under old-prompt semantics until/unless a deliberate reprocessing
pass runs (real ElevenLabs+Gemini cost, not done automatically).

**The actual prompt sent** (verbatim from `buildPrompt()` in
`src/services/gemini.ts`, `{{transcript_text}}`/`{{question_text}}` below
standing in for the interpolated values):

```
You are analyzing a single video-testimonial transcript from an internal test of a
recording platform. The topic is generic ("education") and used only to validate
the app's mechanics — this is not client-facing content. The speaker is a real
person answering one specific question about their own education experience, in
English, Hindi, Marathi, or a natural mix.

Return ONLY valid JSON, no other text, matching this exact shape:

{
  "sentiment_score": <number, -1.0 to 1.0>,
  "themes": [<0 to 2 strings, ONLY from the fixed list below>],
  "emotional_tone": <one of "heartfelt", "humorous", "matter_of_fact",
    "passionate", "other">,
  "summary": "<1-2 sentences, third person, neutral tone>",
  "best_quote": "<verbatim excerpt from the transcript, the single most
    illustrative sentence or two, in its original language/script>",
  "is_relevant": <boolean, true if the answer actually addresses the question
    asked, false if off-topic or non-responsive>,
  "moderation_flag": <boolean>,
  "contains_profanity": <boolean, true if the transcript contains swear words
    or crude language, independent of moderation_flag>,
  "contains_complaint": <boolean>,
  "actionable_feedback": <string or null>,
  "highlight_score": <number, 0.0 to 1.0>,
  "extracted": {
    "mentions_teacher": <boolean>,
    "teacher_contribution": <one of "inspiration", "discipline", "confidence",
      "mentorship", "career_direction", or null if mentions_teacher is false>,
    "life_skills_mentioned": [<0 to 3 strings, ONLY from: "communication",
      "financial_literacy", "leadership", "teamwork", "problem_solving">]
  }
}

FIXED THEME LIST — themes must be chosen only from this list, exactly as
written [... full instructions in code, 11-item list below ...]

MODERATION_FLAG — this field means "unsuitable for external/client-facing use."
[... full rubric in code: hate speech/slurs, sexual content, content that
could embarrass/endanger the speaker, or a direct complaint about Zeist
Interactive/this app/the recording process — NOT a complaint about the
speaker's own education, which is normal expected content ...]

[... CONTAINS_COMPLAINT / EMOTIONAL_TONE / BEST_QUOTE rubrics, see code for
exact wording ...]

Transcript:
"""
{{transcript_text}}
"""

Question asked: "{{question_text}}"
```

**Fields, exact semantics:**

| Field | Type (DB) | Range/values | Notes |
|---|---|---|---|
| `sentiment_score` | `Decimal` | -1 (very negative) to 1 (very positive) | Not clamped/validated by this backend — whatever Gemini returns is stored as-is |
| `themes` | `Json` (array of strings) | **Constrained**: 0–2 items, each one of exactly 11 fixed values — `teacher_impact`, `discipline_and_habits`, `academic_knowledge`, `peer_relationships`, `financial_literacy_gap`, `communication_skills_gap`, `career_readiness`, `access_and_technology`, `pressure_and_values`, `confidence_and_growth`, `practical_learning_gap` | Enforced by the response schema (`enum` + `maxItems: "2"`), not just prompt wording — Gemini cannot return a value outside this list. Exported as `THEME_VALUES` in `src/services/gemini.ts` for anything that needs the same source of truth. |
| `emotional_tone` | `String` (nullable column, but always populated by the current prompt) | One of `heartfelt`, `humorous`, `matter_of_fact`, `passionate`, `other` | Judged only from transcript wording — the prompt explicitly forbids inferring vocal tone/pacing (no audio access) |
| `summary` | `String` | 1–2 sentences, third person, neutral tone | No character limit enforced in code or schema |
| `best_quote` | `String` | Verbatim, original language/script (not translated) | Not validated against the actual transcript text by this backend — prompt-only constraint |
| `is_relevant` | `Boolean` | true/false | Whether the answer actually addresses the question asked |
| `moderation_flag` | `Boolean` | true/false | **`true` now means unsuitable for external/client-facing use** — hate speech/slurs, sexual content, content that could embarrass/endanger the speaker, or a direct complaint about Zeist Interactive/this app/the recording process itself. **This is the corrected, non-inverted meaning as of 2026-09-16.** Before that date this field meant the opposite (`true` = safe to publish) — a fixture generator or dashboard UI built against the old version of this doc will have it backwards. A critical-but-genuine answer about the speaker's own education should almost always be `false`; the prompt explicitly instructs the model not to default to `true` or flag mere negativity. |
| `contains_profanity` | `Boolean` (nullable column — see §1) | true/false | Independent of `moderation_flag` — profanity alone doesn't automatically trip moderation, and moderation can trip without profanity |
| `contains_complaint` | `Boolean` | true/false | True if the speaker expresses dissatisfaction with their own education — normal, expected, unrelated to `moderation_flag` |
| `actionable_feedback` | `String \| null` | Populated only if `contains_complaint` is true, else `null` | Prompt convention only, not DB/code enforced |
| `highlight_score` | `Decimal` | 0 (weak) to 1 (strong) | Composite — relevance, sentiment strength, quote quality — no sub-scores stored separately |
| `extracted` | `Json` (nullable column, but always populated by the current prompt) | Fixed shape: `{ mentions_teacher: boolean, teacher_contribution: one of "inspiration"/"discipline"/"confidence"/"mentorship"/"career_direction" or null, life_skills_mentioned: 0–3 strings from "communication"/"financial_literacy"/"leadership"/"teamwork"/"problem_solving" }` | **No longer question-specific.** Before this rewrite, `extracted`'s shape was meant to vary per question via `Question.extraction_spec` (§1) — that mechanism is now dormant (every seeded question already had `extraction_spec: null`), replaced by this one fixed shape for every question. `teacher_contribution` is only non-null when `mentions_teacher` is true; `life_skills_mentioned` only includes a skill the speaker explicitly references, never an inferred one. |

**Realistic example values**: two real (non-fixture) data points exist, from
two different prompt eras — treat them separately, don't blend them:
- **Pre-rewrite** (`BUILD_STEPS.md`'s step 9 smoke test, product-testimonial
  topic, old prompt): 3 real videos, `sentiment_score` **0.85–0.9** across
  all three, `is_relevant: true` for all three. No negative/mixed/
  `contains_complaint: true` example was ever produced under the old prompt.
- **Post-rewrite** (this session, education topic, current prompt) — a real,
  live-verified Gemini call, not synthetic:
  ```json
  {
    "sentiment_score": -0.2,
    "themes": ["financial_literacy_gap", "teacher_impact"],
    "emotional_tone": "matter_of_fact",
    "summary": "The speaker notes a lack of financial education in school while acknowledging a teacher who helped build their confidence.",
    "best_quote": "Honestly my school was okay but the teachers never really taught us anything about money.",
    "is_relevant": true,
    "moderation_flag": false,
    "contains_profanity": false,
    "contains_complaint": true,
    "actionable_feedback": "School should teach practical financial literacy.",
    "highlight_score": 0.7,
    "extracted": {
      "mentions_teacher": true,
      "teacher_contribution": "confidence",
      "life_skills_mentioned": ["financial_literacy"]
    }
  }
  ```
  Worth noting for fixture purposes (§7): this is a genuinely critical answer
  (`contains_complaint: true`, negative-leaning `sentiment_score`) that still
  correctly got `moderation_flag: false` — real evidence the corrected
  prompt doesn't conflate "negative" with "unsuitable to publish."

---

## 3. Question configuration

**Real, per-client `Question` DB table now** (`prisma/schema.prisma`, full
field list in §1) — not the hardcoded `src/config/questions.ts` object
literal an earlier version of this doc described. That file no longer
exists; questions are rows, not config.

- **No global fixed question count or range.** `isPlausibleQuestionIndex`
  (`src/routes/segments.ts`) only checks "positive integer" — there is no
  hardcoded upper bound (not 5, not 7, not anything). Actual validity is
  checked separately, per request, against the DB: `questionExists(client_id,
  question_index)` looks up `Question` by the `(client_id, index)` unique
  constraint and `POST /segments/upload-url`/`POST /segments/confirm` both
  `400` if nothing matches. A client's real active `question_index` range is
  exactly whatever `Question` rows exist for it — nothing is inferred or
  capped.
- **Every seeded question is fully render-capable** — VO keys
  (`vo_key_en/hi/mr`) are generated per index at seed time for every
  question, not hand-maintained for a subset like the old `QUESTION_VO_KEY`
  map was. There is no "question accepted at upload but permanently fails at
  render" gap in the current seed data (there was, in the old hardcoded
  scheme, for indices with text but no VO entry — not applicable anymore).
- **Currently seeded**: all 3 dummy clients (IFB, Voltas, Zeist) have the
  same 5 questions (education theme, see §1's `Question` section and §2's
  prompt topic framing) — a coincidence of what's been seeded so far, not a
  ceiling. Nothing in the schema or route code prevents a client from having
  a different count (e.g. IFB's eventual real 7-question set) — that's purely
  a `prisma/seed.ts` / admin-provisioning question, not a code capability
  gap. Section 8's "1,000 distributors, 7 questions each" scenario, treated
  as an unreachable hypothetical in an earlier version of this doc, is now
  straightforwardly achievable by seeding 7 `Question` rows per client — see
  §8's revised framing.
- **Link to a recorded segment is still application-level, not a real
  foreign key**: `Segment.question_index` is a plain `Int` column with no
  `@relation` to `Question`. The only DB-level constraints on it are
  `Segment`'s own `@@unique([distributor_id, question_index])` (one segment
  per distributor per question — a retake overwrites the same row) — nothing
  stops a `Segment.question_index` from pointing at a value that used to be
  valid but whose `Question` row was since deleted/reassigned; the route
  layer is the only place existence is ever checked, and only at
  upload/confirm time, not retroactively.
- **Per-client variation is now real, not hypothetical**: because `Question`
  is keyed on `client_id`, different clients genuinely can (and eventually
  will) have different question sets, text, VO audio, and talking points —
  this was flatly impossible under the old one-global-config scheme.

---

## 4. Status and lifecycle — every enum, every real transition

### `SegmentStatus` (on `Segment.status`)
Values: `recorded_local`, `uploaded`, `transcribing`, `transcribed`, `failed`.

Real transitions in code:
```
(row doesn't exist) → uploaded          [segments.ts, on confirm]
uploaded            → transcribing      [transcribeSegment.ts, job start]
transcribing        → transcribed       [transcribeSegment.ts, job success]
transcribing        → failed            [transcribeSegment.ts, job catch block]
```
`recorded_local` is never reached (see §1). There is **no transition back**
from `failed` to any other state — a failed segment stays `failed` forever
unless a human manually resets the DB row (no retry, §6/§9). A `failed`
segment here is a **transcription-pipeline failure only** — it says nothing
about render outcome (see below).

### `JobStatus` (on `Job.status`)
Values: `pending`, `processing`, `done`, `failed`.

Real transitions (`worker.ts`):
```
pending    → processing   [claimJob(), SKIP LOCKED]
processing → done         [handler resolves]
processing → failed       [handler throws]
```
No transition ever moves a row back to `pending`. **A crashed worker leaves
a job stuck at `processing` forever** — no other worker will reclaim it
(the claim query only selects `status = 'pending'`), no timeout exists.

### `RenderedVideoStatus` (on `RenderedVideo.status`)
Values: `pending`, `rendering`, `rendered`, `failed` (`pending` never
actually produced in practice — see §1).

Real transitions (`renderSegment.ts`):
```
(row doesn't exist) → rendering   [upsert, right after nexrender accepts the job]
rendering           → rendered    [nexrender job reaches "finished"]
rendering           → failed      [nexrender job ends non-"finished", or times out after 10 min]
```
No retry, no transition back to `rendering` from `failed`.

### What a distributor can genuinely be in, right now
- **No status field exists on `Distributor` at all.** Every seeded
  distributor is implicitly permanent/active — there is no way to represent
  "offboarded," "inactive," or "invited but not yet onboarded" in the schema
  today.
- A distributor's *progress* is entirely inferred by a dashboard from the
  `Segment`/`RenderedVideo` rows tied to them — there's no single
  "distributor lifecycle stage" field to read.

### What a video can genuinely be in, right now
Combine `Segment.status` × whether a `RenderedVideo` row exists × its
`status`, independently:
- No segment row at all → question never attempted.
- `Segment.status = uploaded` → uploaded, not yet processed.
- `Segment.status = transcribing` → mid-pipeline.
- `Segment.status = transcribed`, no `RenderedVideo` row → transcribed,
  render not yet queued/started (or the render job is still `pending`/
  `processing` in the `Job` table with no `RenderedVideo` row created yet —
  a `RenderedVideo` row is only created once nexrender *accepts* the job,
  not when the render job is queued).
- `Segment.status = transcribed`, `RenderedVideo.status = rendering` →
  render in progress.
- `Segment.status = transcribed`, `RenderedVideo.status = rendered` →
  fully done, playable.
- `Segment.status = transcribed`, `RenderedVideo.status = failed` →
  transcription succeeded, render permanently failed, no automatic retry.
- `Segment.status = failed` → transcription itself failed; no
  `RenderedVideo` row will ever be created for this segment (render is only
  ever queued from a *successful* transcription completion).

---

## 5. Distributor record — what exists vs. what needs a CRM

**What `Distributor` actually contains today** (full field list, repeated
from §1 for convenience): `id`, `client_id`, `name` (business name, e.g.
"Ramesh Traders"), `phone`, `invite_token`, `language_pref`, `created_at`.
That's the entire record. Plus its relation to one `Client` (`id`, `name`,
`branding_config`, `created_at`).

**Notably absent — no email field exists at all**, on either `Distributor`
or `Client`. Only `phone` is present.

**Fields a dashboard would need that must come from a CRM (not in this
schema at all)**:
- Email address
- Business category / industry vertical
- Years in business / "customer since" date
- Business address, city, region, or sales territory
- Assigned sales rep / account owner
- Purchase or order history (product bought, order value, purchase date)
- Business size (revenue tier, employee count)
- Distributor tier/segment classification
- GSTIN or other tax/registration ID
- Secondary contacts
- Communication/opt-in preferences
- Logo, photo, or any visual branding at the distributor level (only
  `Client.branding_config` exists, and only 2 clients have one)
- Contract or renewal dates
- Any engagement/login history (no session table exists — JWTs are
  stateless, nothing is recorded server-side per login, so "last active"
  cannot be derived even approximately)

---

## 6. Derivable aggregates — what's actually computable by SQL

**Per distributor:**
- Count of segments by `status` (uploaded/transcribing/transcribed/failed)
- Count of rendered videos by `status`
- Average `duration_seconds` across their segments
- Average `sentiment_score` / `highlight_score` across their segments (join `sentiment_results`)
- `is_relevant` / `moderation_flag` / `contains_complaint` rate
- First/last segment `created_at`/`updated_at` (a rough activity window — **not** a true "last login," see below)

**Per question (`question_index`):**
- Count of segments recorded at that index
- Average duration, sentiment, highlight score at that index
- Theme frequency (requires unnesting the `themes` JSON array)
- Render success/failure rate at that index
- Drop-off funnel: `COUNT(*) GROUP BY question_index` directly shows how many distributors reached each question

**Per client:**
- Distributor count (join)
- Aggregate sentiment/theme distribution across all of a client's distributors
- Render volume and failure rate across the client
- **Cannot** compute anything CRM-shaped (industry, region, tier) — not stored (§5)

**Across time:**
- Upload/completion/render throughput by day/week/month, via `created_at`/`updated_at` on `Segment`, `Transcript`, `SentimentResult`, `RenderedVideo`
- **Job-level processing latency is computable**: `Job.updated_at - Job.created_at` per job row (joined to `segment_id` via the JSON payload) gives a real duration for each `transcribe_segment`/`render_segment` run
- A "best testimonials" leaderboard, ordered by `highlight_score`/`sentiment_score`, with `best_quote` as the pull-quote — directly computable

**Flagged: looks computable but isn't:**
- **Per-status duration** (e.g. "how long did this segment sit in
  `transcribing` before becoming `transcribed`?") — **not computable.**
  `Segment.updated_at` is a single timestamp overwritten on every status
  change; no history of prior states or timestamps is retained. Only the
  `Job` table's `created_at`/`updated_at` (one row per job attempt) gives any
  real latency signal, and that's a proxy for the whole job run, not
  per-status granularity within it.
- **"Completion rate" against a per-client expected question count — now
  actually computable, unlike when this doc was first written.** `Question`
  is a real per-`client_id` table (§1, §3) now, so `COUNT(*) FROM questions
  WHERE client_id = X` **is** that client's expected question count — a
  distributor's completion rate against it is `COUNT(DISTINCT
  segments.question_index WHERE distributor_id = Y) / <that count>`. Still
  **not per-distributor** (no distributor-level override of which questions
  apply — it's uniform across a client's distributors), and not what
  `GET /dashboard/summary`'s `completion` field actually measures today —
  that endpoint's `completed`/`rate` is fraction-of-segments-that-reached-
  `status: "transcribed"`, a pipeline-success rate, not a question-coverage
  rate. A `Question`-count-based completion metric is a real, buildable
  addition someone could ask for, just not what exists today (§10 lists
  what `/dashboard/summary` actually returns).
- **Login frequency / last-active date** — no session/login table exists;
  JWT auth is stateless and nothing is recorded server-side per login.
  `Segment.created_at`/`updated_at` only proxy for *recording* activity, not
  app opens or logins.
- **View/download/share counts on rendered videos** — `getPlaybackUrl`
  generates a presigned S3 URL on request but **nothing logs that a URL was
  requested or that the video was actually watched**. Zero engagement
  telemetry exists.
- **Distributor "status"/lifecycle stage** — no field to aggregate on (§4).

---

## 7. Realistic distributions for fake data

**Everything in this section is an assumption for fixture-generation
purposes, not derived from real production data — the only real data points
this repo has ever produced are the two cited in §2: the pre-rewrite 3-video
smoke test (all positive, sentiment 0.85–0.9, n=3) and the single
post-rewrite live-verified example (n=1, negative-leaning, `contains_complaint:
true`).** Treat these as reasonable starting points to vary around, not
ground truth.

- **`sentiment_score` (-1 to 1)**: real customers who agree to record a
  testimonial skew positive by selection — suggest roughly 65–75% in
  `0.5–1.0`, ~20% in `0.0–0.5` (lukewarm/mixed), ~5–10% in `-1.0–0.0` (rare,
  but include some — an all-positive fixture set won't exercise a
  dashboard's negative-case UI at all).
- **`highlight_score` (0–1)**: loosely correlated with `sentiment_score` and
  `is_relevant`; suggest a distribution centered around `0.4–0.8`, with the
  top ~10% above `0.85` (these are your "leaderboard" candidates).
- **`themes`**: **no longer freely invented — draw only from the real fixed
  11-item vocabulary** (§2): `teacher_impact`, `discipline_and_habits`,
  `academic_knowledge`, `peer_relationships`, `financial_literacy_gap`,
  `communication_skills_gap`, `career_readiness`, `access_and_technology`,
  `pressure_and_values`, `confidence_and_growth`, `practical_learning_gap`.
  0–2 per segment (the schema caps at 2, not 2–4 as an earlier version of
  this doc suggested when themes were still freeform). A fixture generator
  using the old customer-service-themed pool (`"pricing"`, `"delivery
  speed"`, etc.) would now produce values this backend could never actually
  emit for a segment analyzed after 2026-09-16.
- **`is_relevant`**: mostly `true` (~90%+) — most people who finish
  recording do answer the question.
- **`moderation_flag`**: **meaning corrected 2026-09-16 — `true` now means
  unsuitable for external use, the opposite of what an earlier version of
  this doc said.** Suggest overwhelmingly `false` (most genuine answers,
  even critical ones, are fine to publish per the prompt's own instruction
  not to default to `true`) — reserve `true` for a small handful of fixture
  rows to exercise a "flagged, excluded from `/dashboard/highlights`" UI
  state. A fixture generator built against the old version of this doc will
  have every row backwards.
- **`emotional_tone`**: one of `heartfelt`, `humorous`, `matter_of_fact`,
  `passionate`, `other` (§2) — new field, no real distribution observed yet
  beyond the single live example in §2 (`matter_of_fact`). No strong prior;
  spread roughly evenly, weighted slightly toward `heartfelt`/`matter_of_fact`
  for an education-testimonial topic.
- **`contains_profanity`**: suggest a low rate (~2–5%) — independent of
  `moderation_flag` (a segment can have one without the other, per §2).
- **`contains_complaint`**: suggest ~15–20% `true`, independent of overall
  sentiment (a mostly-positive testimonial can still contain one gripe, per
  the prompt's own instruction) — pair with a populated `actionable_feedback`
  string only on those rows.
- **Language mix**: `Distributor.language_pref` and `Transcript.
  language_detected` are both free-form strings with **no enum constraint**.
  The only real values ever seeded are `"en"` and `"hi"` (3:2 split in the
  5 seeded accounts). **"Hinglish" is not a distinct value anywhere in this
  codebase** — the one real transcription test noted in `BUILD_STEPS.md`
  observed ElevenLabs return a single `language_code` (Hindi) while the
  transcript *text itself* was code-mixed Hindi/English — code-mixing shows
  up inside the text, not as a separate language tag. A fixture generator
  aiming for shape-accuracy should not invent a `"hinglish"` language value;
  if it wants code-mixed content, put it in the text under `"hi"` (or `"en"`)
  instead. **Marathi has never appeared anywhere in this repo's code, tests,
  or docs** — not excluded by the schema (free-form string), but not
  evidenced as something ElevenLabs Scribe has actually been confirmed to
  detect for this use case either. Suggest, for fixture variety: ~45% `en`,
  ~40% `hi`, ~15% `mr` if you want to exercise a 3-language UI — clearly
  labeled as invented, not confirmed-supported.
- **Completion/drop-off rate across questions**: no real funnel data exists.
  Suggest a fatigue-driven decline — each successive question retains
  roughly 85–95% of the distributors who reached the previous one (this
  matches the exact UX concern already on record in this project about
  single-flow multi-question recording causing drop-off — see `CLAUDE.md`).
- **Transcription failure rate**: suggest ~2–4% of segments landing in
  `Segment.status = "failed"` — network hiccups, ElevenLabs errors,
  malformed uploads. No real observed rate exists to calibrate against.
- **Render failure rate**: suggest ~3–6% of segments that reach
  `RenderedVideo` landing at `status = "failed"` — nexrender timeouts/errors.
  Also no real observed rate to calibrate against; the "stuck in
  `processing`" failure mode (§4/§9) is a separate, rarer case worth a small
  fraction of fixture rows (~1%) if the dashboard should show it at all.

---

## 8. Volume assumptions — 1,000 distributors, 7 questions each

**This scenario is now achievable by the code as it exists** — see §3.
There's no hardcoded `question_index` cap anymore and every `Question` row
is fully render-capable by construction; a 7-question client is purely a
matter of seeding 7 `Question` rows for it (`prisma/seed.ts` currently seeds
5 for every client — this is a data/provisioning gap now, not a code
capability gap, unlike when this doc was first written). The math below
still uses §7's assumed drop-off/failure rates and is still not derived from
real observed volume at this scale — that part hasn't changed.

**Segments** — applying an 85–95%-per-step retention curve to 1,000
starting distributors:

| Question | Retention from prior | Segments (rows) |
|---|---|---|
| 1 | — (95% start at all) | 950 |
| 2 | 95% | 900 |
| 3 | 92% | 830 |
| 4 | 89% | 740 |
| 5 | 87% | 640 |
| 6 | 85% | 540 |
| 7 | 82% | 440 |
| **Total** | | **~5,040 `Segment` rows** |

- **Transcripts / SentimentResults**: ~5,040 × (1 − 3% failure) ≈ **~4,890
  rows each** (both written together per successful segment, per §1/§2).
- **Jobs**: 1 `transcribe_segment` row per segment attempted (~5,040) + 1
  `render_segment` row per segment that finished transcription successfully
  (~4,890) ≈ **~9,930 `Job` rows total**.
- **RenderedVideos**: of the ~4,890 that reach render, applying a ~5%
  render-failure rate → **~4,645 at `status: "rendered"`, ~245 at `status:
  "failed"`** (plus a small, harder-to-pin-down number transiently at
  `"rendering"` at any given moment — not a steady-state count).

**Rough storage** (using the documented ~100MB/minute raw-footage figure
from `learnings.md`, an assumed ~45s average answer clip → ~75MB raw per
segment, the ~45MB real rendered-output size observed in `BUILD_STEPS.md`,
and noting captions/SRT/VTT are negligible in size):

| Segment outcome | Files retained in S3 | Approx. size | Count | Subtotal |
|---|---|---|---|---|
| Fully rendered | raw (~75MB) + captioned intermediate (~75MB) + rendered final (~45MB) | ~195MB | 4,645 | ~906 GB |
| Transcribed, render failed | raw + captioned intermediate | ~150MB | 245 | ~36 GB |
| Transcription failed (upload only) | raw only | ~75MB | ~150 | ~11 GB |
| **Total** | | | **5,040** | **~950 GB, call it ~1TB** |

This is a rough order-of-magnitude figure, not a precise estimate — actual
clip length and file size vary by phone/bitrate (the "different phone
ratios/quality" open item in `CLAUDE.md` means this is genuinely variable,
not a fixed constant). It also reflects the deliberate "extra full-size
video copy" tradeoff already flagged in this repo (§9 of `AUDIT_BACKEND.md`)
— three video-sized artifacts retained per fully-processed segment, not one.

**Superseded** — an earlier version of this doc had a "what's actually
possible with the code as it exists today" caveat here, capping this
scenario at 5 questions with only 3 render-capable. That cap no longer
exists (§3); the 7-question, ~5,040-segment table above is the real
achievable shape once 7 `Question` rows are seeded per client, not a
hypothetical requiring code changes.

---

## 9. Explicitly not available

Things a dashboard might reasonably want that this backend **cannot**
currently provide, given everything above:

- **Video view/download/share counts** — no engagement telemetry exists at all.
- **Login frequency, last-active date, session history** — stateless JWT auth, nothing recorded server-side per login.
- **Distributor lifecycle/status** (active, inactive, invited, offboarded) — no such field exists.
- **CRM-shaped fields**: email, industry, region/territory, sales rep, purchase history, business size, tier, tax ID — none exist (§5).
- **Per-status timing within a segment's pipeline** (e.g. time spent specifically in "transcribing") — only current status + one `updated_at` is retained, not a history.
- **Per-distributor custom question sets** — `Question` is per-`client_id`
  now (§1, §3), so per-*client* variation is real and available; there's
  still no per-*distributor* override within a client's question set.
- **Transcript text or caption files via any API** — written and stored, never returned by any route (§1).
- **Job error details via any API** — `Job.last_error` exists in the DB but no route exposes it; only visible in server logs.
- **A true "stuck" job indicator** — jobs stuck in `processing` after a worker crash are invisible to any query designed around normal status values; nothing marks them as anomalous.
- **Real invite-token-based onboarding data** — `invite_token` exists but functions only as an internal lookup key today, not an actual invite/redemption flow with its own timestamps or state.
- ~~**A `themes` taxonomy**~~ **Now exists** — as of the 2026-09-16 prompt
  rewrite, `themes` is constrained to a fixed 11-item enum (§2), enforced by
  Gemini's structured-output schema, not just prompt wording. This only
  applies to segments analyzed after that date; older rows can still carry
  old-prompt freeform theme strings.
- **Any signal for why a distributor dropped off mid-flow** (technical failure vs. chose to stop vs. app closed) — `Segment` rows simply don't exist for unattempted questions; the backend has no way to distinguish these cases.
- **Admin/company user accounts distinct from distributors** — no such
  identity exists; the closest thing is the `GET /dashboard/*` surface
  (§10), gated only by ordinary distributor auth (any of that client's
  seeded accounts) plus the `ENABLE_DASHBOARD_ENDPOINTS` flag, not a real
  separate admin role. `GET /segments/sentiment`, the older stand-in this
  doc used to reference here, no longer exists — removed once `/dashboard/*`
  superseded it.

---

## 10. `GET /dashboard/*` — the real admin/reporting surface, added this session

Source: `src/routes/dashboard.ts`. Added in the same session as the §2
prompt rewrite — this is what actually reads `sentiment_results` today; the
old `GET /segments/sentiment` test endpoint these superseded is gone.
**Updated 2026-09-17**: two small additions to `GET /dashboard/highlights`
plus one new endpoint, `GET /dashboard/response/:segment_id`, found necessary
while wiring the dashboard UI to real data — see their rows below.

**Updated 2026-09-18**: a `?theme=` filter on `GET /dashboard/highlights`
(makes every theme-based panel — barlists, treemap blocks, ring stats,
sentiment-by-theme rows — clickable through to real evidence via the same
detail drawer, no new endpoint or extraction needed) and a `video_url` field
on `GET /dashboard/response/:segment_id` (signed S3 GET URL for the
segment's own video, `null` when `moderation_flag` is `true` — same
"not individually surfaced" treatment `moderation_flag` already gets for
the quote on `/dashboard/highlights`) — see their rows below.

**Gating**: `ENABLE_DASHBOARD_ENDPOINTS` (default off — routes not
registered at all when off, same "404, not 403" treatment as every other
flag-gated router in this codebase). Deliberately its own flag, split from
the older, more generic `ENABLE_DEV_ENDPOINTS` (which gates nothing today).

**Auth/scoping**: same JWT as every other route (`Authorization: Bearer
<token>`, any seeded distributor account works), but every query here is
scoped by `client_id`, not the caller's own `distributor_id` — it reads
across **every** distributor under that client, on purpose (internal/company
data, no single distributor should see moderation/complaint judgements about
themselves or anyone else).

**Character**: all 9 routes are read-only, no LLM call. 8 of them are
SQL-aggregated (`prisma.$queryRaw` tagged templates, not the query builder —
needed for `jsonb_array_elements_text` theme-unnesting and
`FILTER (WHERE ...)` bucket counts); `GET /dashboard/response/:segment_id`
is the one exception — a single-row lookup via the regular Prisma query
builder, not raw SQL, since it's not an aggregate. Every count-based stat
returns the raw count alongside any percentage — small buckets aren't hidden.

| Route | Returns |
|---|---|
| `GET /dashboard/wordcloud?question_index=N&limit=100` | `{ question_index, transcript_count, words: [{word, count}] }` — code-only tokenization (no LLM) across `Transcript.text` for the client, optionally filtered to one question. `src/services/wordFrequency.ts`: Unicode letter-run matching (handles Devanagari as well as Latin), lowercased, English **and** Hindi **and** Marathi stopwords all applied to every transcript regardless of detected language — transcripts here are routinely code-mixed, so a single-language list would under-filter the other two. |
| `GET /dashboard/summary` | `{ total_responses, completion: {completed, rate, by_status}, sentiment_split: {total_analyzed, thresholds, positive, neutral, negative}, average_sentiment_by_question: [...] }` — `total_responses` counts every `Segment` regardless of status; `completion` is the fraction that reached `status: "transcribed"` (a pipeline-success rate, **not** the Question-count-based completion rate discussed in §6); `sentiment_split` buckets on fixed `sentiment_score` thresholds (`>= 0.3` positive, `<= -0.3` negative), only over segments with a `sentiment_result`. |
| `GET /dashboard/themes` | `{ themes: [{theme, count}], themes_with_complaint: [same, filtered to contains_complaint: true] }` — `jsonb_array_elements_text` unnest + `GROUP BY`. `theme` values are the §2 11-item vocabulary for segments analyzed after 2026-09-16; older rows may still carry old freeform strings. |
| `GET /dashboard/theme-sentiment` | `{ themes: [{theme, count, average_sentiment_score}] }` — per-theme average `sentiment_score`, the positive/negative lean per theme computed from existing data, no separate valence field. |
| `GET /dashboard/highlights?question_index=N&theme=<theme_name>&limit=10` | `{ question_index, theme: string\|null, highlights: [{segment_id, best_quote, highlight_score, sentiment_score, language, distributor_name, actionable_feedback}] }`, ordered by `highlight_score` desc. `question_index` **required** (`400` if missing/malformed). **Excludes `moderation_flag: true` rows** — the first real consumer of the corrected (§2) semantics. Pre-2026-09-16 rows are still under the old inverted meaning, so until reprocessed this filter under-includes old content (never over-includes/leaks anything), the safe failure direction. **`distributor_name` added 2026-09-17 — a deliberate, endpoint-specific exception to this router's "no identity" design** (internal-only viewing, two known people, most participants already personally known to them); does not extend to any other endpoint or a future client-facing version without a fresh decision. `actionable_feedback` (also added 2026-09-17) is `null` unless `contains_complaint` was true for that segment. **`theme` (added 2026-09-18)** — optional, must be one of `THEME_VALUES` (§2) or `400`; filters to segments whose `themes` array contains it, checked via `jsonb_array_elements_text`, not the `?` jsonb operator. |
| `GET /dashboard/response/:segment_id` | **Added 2026-09-17.** Single-segment lookup, not a list — `{ segment_id, question_index, video_url: string\|null, transcript: {text, language_detected, language_probability}|null, sentiment: {sentiment_score, themes, emotional_tone, summary, best_quote, is_relevant, moderation_flag, contains_profanity, contains_complaint, actionable_feedback, highlight_score, extracted}|null }`. `segment_id` must be a well-formed UUID (`400` otherwise); scoped by `client_id` like every other route here — a segment belonging to a different client is indistinguishable from a nonexistent one (`404` either way). `transcript`/`sentiment` are `null`, not a 404, when that stage just hasn't completed yet. No distributor identity field — unlike `/dashboard/highlights` above, not asked for here. **`video_url` (added 2026-09-18)** — signed S3 GET URL for `Segment.video_key` via the same `getPlaybackUrl` helper mobile playback uses (1hr expiry, generated fresh every request, nothing new stored); `null` when `moderation_flag` is `true`, same internal-only "not individually surfaced" reasoning as `distributor_name` above. |
| `GET /dashboard/teacher-impact` | `{ total_analyzed, mentions_teacher: {count, percentage}, teacher_contribution: [{teacher_contribution, count, percentage}] }` — reads `extracted->>'mentions_teacher'`/`extracted->>'teacher_contribution'` (Postgres JSON operators). Only populated for segments analyzed after 2026-09-16 — `extracted.mentions_teacher` didn't exist in that shape before. |
| `GET /dashboard/technical` | `{ devices: [{device_model, os_version, count}], resolutions: [{width, height, count}], average_duration_by_question: [{question_index, average_duration_seconds, count}] }` — from `Segment.capture_metadata` and `Segment.duration_seconds` (§1). Internal/QA use, not participant-facing. |
| `GET /dashboard/extraction-quality` | `{ total_analyzed, is_relevant: {count, percentage}, contains_profanity: {known_count, count, percentage}, highlight_score_distribution: {thresholds, high, mid, low} }` — a meta-view of the pipeline itself. `contains_profanity`'s `percentage` divides by `known_count` (rows where that nullable column is actually populated), not `total_analyzed`, so pre-2026-09-16 rows (always `null` there) don't dilute the rate. |

**Deliberately not built** (per explicit instruction when these were added,
not an oversight): a completion-funnel-across-questions endpoint, city/tenure
breakdowns, retake-frequency reporting.

Full request/response shapes with example JSON: `API_CONTRACT.md`'s
"Internal admin/reporting surface" section — that file is the source of
truth for exact shapes; this section exists to connect those endpoints back
to the underlying schema/semantics documented in §1–§2 above.
