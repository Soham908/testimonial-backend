import { ApiError, GoogleGenAI, Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { config } from "../config/env";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

// Gemini occasionally returns a transient 503 ("model currently
// experiencing high demand") or 429 (rate limited) under load - both are
// documented by Google as usually short-lived. Worth retrying in-process
// because src/worker.ts never re-queues a failed job on its own (it only
// ever polls for status='pending') - without this, one transient spike
// permanently fails the whole transcribe_segment job and its segment gets
// stuck at status="failed". Any other error (bad request, auth, a
// genuinely malformed schema) is not retried - those won't succeed on a
// second try. Capped at 3 retries (4 attempts total, ~33s of added
// waiting worst case) - long enough to ride out a short spike without one
// stuck job blocking the single-worker queue behind it for minutes.
const RETRYABLE_STATUS_CODES = new Set([429, 503]);
const RETRY_DELAYS_MS = [3000, 10000, 20000]; // between attempts 1->2, 2->3, 3->4
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The SDK stringifies Google's full error body into err.message (see
// ApiError in @google/genai) - {"error":{"code","message","status",
// "details":[...]}}. A bare 429 status doesn't say *why*: it could be a
// per-minute rate limit (clears in seconds) or a per-day quota already
// spent (clears on Google's daily reset, hours away) - same status code,
// wildly different recovery time. The `details` array disambiguates: a
// QuotaFailure names the specific quotaId/quotaMetric that tripped, and a
// RetryInfo (when present) carries Google's own recommended wait. Parsed
// defensively - a message that isn't this JSON shape (or an error with no
// structured details) just falls back to "keep the existing behavior".
function parseGoogleError(message: string): { isDailyQuotaExhausted: boolean; retryDelayMs: number | null } {
  try {
    const body = JSON.parse(message) as { error?: { details?: Array<Record<string, unknown>> } };
    const details = body.error?.details ?? [];

    const quotaFailure = details.find((d) => String(d["@type"]).includes("QuotaFailure"));
    const violations = (quotaFailure?.violations as Array<{ quotaId?: string; quotaMetric?: string }>) ?? [];
    const isDailyQuotaExhausted = violations.some(
      (v) => v.quotaId?.includes("PerDay") || v.quotaMetric?.includes("PerDay"),
    );

    const retryInfo = details.find((d) => String(d["@type"]).includes("RetryInfo"));
    const rawDelay = retryInfo?.retryDelay as string | undefined;
    const retryDelayMs = rawDelay ? Math.round(parseFloat(rawDelay) * 1000) : null;

    return { isDailyQuotaExhausted, retryDelayMs };
  } catch {
    return { isDailyQuotaExhausted: false, retryDelayMs: null };
  }
}

async function generateContentWithRetry(
  params: Parameters<typeof ai.models.generateContent>[0],
): ReturnType<typeof ai.models.generateContent> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      if (!(err instanceof ApiError) || !RETRYABLE_STATUS_CODES.has(err.status)) throw err;

      const { isDailyQuotaExhausted, retryDelayMs } = parseGoogleError(err.message);
      if (isDailyQuotaExhausted) {
        // No in-process wait fixes this - the daily cap resets on
        // Google's clock, not within this call. Fail immediately (instead
        // of burning ~33s hammering a call that cannot succeed) so the
        // job-level retry queue in src/worker.ts backs off on its own
        // schedule instead of every attempt wasting the same dead time.
        console.warn(`[gemini] daily quota exhausted (status ${err.status}) - not retrying in-process`);
        throw err;
      }
      if (attempt >= MAX_ATTEMPTS) throw err;

      // Prefer Google's own recommended wait over our fixed schedule when
      // it gives us one - it knows its own quota window better than we do.
      const delay = retryDelayMs ?? RETRY_DELAYS_MS[attempt - 1] ?? 20000;
      console.warn(
        `[gemini] transient error (status ${err.status}) on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
}

// Fixed vocabularies the model must choose from - enforced by the response
// schema below (Gemini structured output rejects values outside `enum`),
// not just requested in prose. Exported so callers/tests can validate
// against the same source of truth instead of duplicating the list.
export const THEME_VALUES = [
  "teacher_impact",
  "discipline_and_habits",
  "academic_knowledge",
  "peer_relationships",
  "financial_literacy_gap",
  "communication_skills_gap",
  "career_readiness",
  "access_and_technology",
  "pressure_and_values",
  "confidence_and_growth",
  "practical_learning_gap",
] as const;

export const EMOTIONAL_TONE_VALUES = ["heartfelt", "humorous", "matter_of_fact", "passionate", "other"] as const;

export const TEACHER_CONTRIBUTION_VALUES = [
  "inspiration",
  "discipline",
  "confidence",
  "mentorship",
  "career_direction",
] as const;

export const LIFE_SKILL_VALUES = [
  "communication",
  "financial_literacy",
  "leadership",
  "teamwork",
  "problem_solving",
] as const;

export type Theme = (typeof THEME_VALUES)[number];
export type EmotionalTone = (typeof EMOTIONAL_TONE_VALUES)[number];
export type TeacherContribution = (typeof TEACHER_CONTRIBUTION_VALUES)[number];
export type LifeSkill = (typeof LIFE_SKILL_VALUES)[number];

export type SentimentAnalysis = {
  sentiment_score: number;
  themes: Theme[];
  emotional_tone: EmotionalTone;
  summary: string;
  best_quote: string;
  is_relevant: boolean;
  // true means unsuitable for external/client-facing use - see the
  // description on RESPONSE_SCHEMA.moderation_flag below for the exact
  // bar. Not the inverse of "safe to publish" naming this field used
  // before the 2026-09-16 prompt rewrite.
  moderation_flag: boolean;
  contains_profanity: boolean;
  contains_complaint: boolean;
  actionable_feedback: string | null;
  highlight_score: number;
  extracted: {
    mentions_teacher: boolean;
    teacher_contribution: TeacherContribution | null;
    life_skills_mentioned: LifeSkill[];
  };
};

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    sentiment_score: {
      type: Type.NUMBER,
      description: "Overall sentiment from -1 (very negative) to 1 (very positive)",
    },
    themes: {
      type: Type.ARRAY,
      items: { type: Type.STRING, format: "enum", enum: [...THEME_VALUES] },
      maxItems: "2",
      description: "0 to 2 themes, chosen only from the fixed enum list",
    },
    emotional_tone: { type: Type.STRING, format: "enum", enum: [...EMOTIONAL_TONE_VALUES] },
    summary: { type: Type.STRING, description: "1-2 sentences, third person, neutral tone" },
    best_quote: {
      type: Type.STRING,
      description: "Verbatim excerpt from the transcript, in its original language/script - not a paraphrase.",
    },
    is_relevant: {
      type: Type.BOOLEAN,
      description: "Whether the answer actually addresses the question asked.",
    },
    moderation_flag: {
      type: Type.BOOLEAN,
      description:
        "True if unsuitable for external/client-facing use: hate speech/slurs, sexual content, content that " +
        "could embarrass or endanger the speaker if shown publicly, or a direct complaint about Zeist " +
        "Interactive/this app/the recording process itself. A genuine, thoughtful answer - even a critical or " +
        "negative one about the speaker's own education - should almost always be false. Do not default to true.",
    },
    contains_profanity: {
      type: Type.BOOLEAN,
      description: "True if the transcript contains swear words or crude language, independent of moderation_flag.",
    },
    contains_complaint: {
      type: Type.BOOLEAN,
      description: "True if the speaker expresses dissatisfaction with some aspect of their own education.",
    },
    actionable_feedback: {
      type: Type.STRING,
      nullable: true,
      description: "If contains_complaint is true, the specific complaint/suggestion in plain text; null otherwise.",
    },
    highlight_score: {
      type: Type.NUMBER,
      description: "0-1 composite score for how strong a highlight-reel candidate this segment is.",
    },
    extracted: {
      type: Type.OBJECT,
      properties: {
        mentions_teacher: { type: Type.BOOLEAN },
        teacher_contribution: {
          type: Type.STRING,
          format: "enum",
          enum: [...TEACHER_CONTRIBUTION_VALUES],
          nullable: true,
          description: "Null when mentions_teacher is false.",
        },
        life_skills_mentioned: {
          type: Type.ARRAY,
          items: { type: Type.STRING, format: "enum", enum: [...LIFE_SKILL_VALUES] },
          maxItems: "3",
          description: "Only skills explicitly referenced by the speaker - never infer one that isn't present.",
        },
      },
      required: ["mentions_teacher", "teacher_contribution", "life_skills_mentioned"],
    },
  },
  required: [
    "sentiment_score",
    "themes",
    "emotional_tone",
    "summary",
    "best_quote",
    "is_relevant",
    "moderation_flag",
    "contains_profanity",
    "contains_complaint",
    "actionable_feedback",
    "highlight_score",
    "extracted",
  ],
};

function buildPrompt(transcriptText: string, questionText: string): string {
  return `You are analyzing a single video-testimonial transcript from an internal test of a
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
      "financial_literacy", "leadership", "teamwork", "problem_solving" —
      include a skill ONLY if the speaker explicitly references it, never infer
      one that isn't actually present in the text>]
  }
}

FIXED THEME LIST — themes must be chosen only from this list, exactly as
written. Do not invent new theme names, do not use synonyms, do not return
more than 2:
- teacher_impact
- discipline_and_habits
- academic_knowledge
- peer_relationships
- financial_literacy_gap
- communication_skills_gap
- career_readiness
- access_and_technology
- pressure_and_values
- confidence_and_growth
- practical_learning_gap

MODERATION_FLAG — this field means "unsuitable for external/client-facing use."
Set it to true ONLY if the content contains: hate speech or slurs, sexual
content, content that could embarrass or endanger the speaker if shown
publicly, or a direct, specific complaint about Zeist Interactive, this app,
or the recording process itself (as opposed to a complaint about the
speaker's own education, which is normal and expected content, NOT a
moderation issue). A genuine, thoughtful answer — even a critical or negative
one about education — should almost always be moderation_flag: false. Do not
default to true. Do not flag content merely for being negative in tone.
Profanity alone does not automatically require moderation_flag: true — use
your judgment on severity, and record it separately via contains_profanity
regardless of your moderation_flag decision.

CONTAINS_COMPLAINT — true if the speaker expresses dissatisfaction with some
aspect of their own education (this is a normal, expected answer to several
of these questions, and is unrelated to moderation_flag).

EMOTIONAL_TONE — judge only from the words and phrasing actually used in the
transcript. Do not infer anything about vocal tone, pacing, or delivery —
you do not have access to audio, only text.

BEST_QUOTE — must be copied verbatim from the transcript, not paraphrased or
translated. If the strongest moment is in Hindi or Marathi script, keep it in
that script.

Transcript:
"""
${transcriptText}
"""

Question asked: "${questionText}"`;
}

export async function analyzeSentiment(transcriptText: string, questionText: string): Promise<SentimentAnalysis> {
  const response = await generateContentWithRetry({
    // Pinned, not "-latest" - that alias is what silently put this on
    // gemini-3.8-flash (confirmed via the quota-exceeded error's model
    // field), the newest and most quota-constrained model in the family
    // (5 RPM / 20 RPD on the free tier). gemini-3.5-flash-lite gets 15 RPM
    // / 500 RPD instead - plenty of headroom for sentiment/theme
    // extraction, which doesn't need the newest model's extra reasoning
    // depth. Revisit if extraction quality ever seems to suffer for it.
    model: "gemini-3.5-flash-lite",
    contents: buildPrompt(transcriptText, questionText),
    config: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  if (!response.text) {
    throw new Error("Gemini returned no text in response");
  }

  return JSON.parse(response.text) as SentimentAnalysis;
}
