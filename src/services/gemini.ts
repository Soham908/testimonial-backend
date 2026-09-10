import { ApiError, GoogleGenAI, Type } from "@google/genai";
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

export type SentimentAnalysis = {
  sentiment_score: number;
  themes: string[];
  summary: string;
  best_quote: string;
  is_relevant: boolean;
  moderation_flag: boolean;
  contains_complaint: boolean;
  actionable_feedback: string | null;
  highlight_score: number;
  extracted: Record<string, unknown>;
};

const CORE_PROPERTIES = {
  sentiment_score: {
    type: Type.NUMBER,
    description: "Overall sentiment from -1 (very negative) to 1 (very positive)",
  },
  themes: {
    type: Type.ARRAY,
    items: { type: Type.STRING },
    description: "Short theme/topic tags mentioned in the testimonial",
  },
  summary: {
    type: Type.STRING,
    description: "One or two sentence summary of the testimonial",
  },
  best_quote: {
    type: Type.STRING,
    description:
      "A verbatim sentence or two copied directly from the transcript — the single most usable, quotable moment. Not a paraphrase.",
  },
  is_relevant: {
    type: Type.BOOLEAN,
    description:
      "Whether the response actually answers the question that was asked, as opposed to being off-topic or a non-answer.",
  },
  moderation_flag: {
    type: Type.BOOLEAN,
    description:
      "Whether this content is safe to publish externally (appropriateness — offensive language, inappropriate content), independent of sentiment. true means it is safe to publish.",
  },
  contains_complaint: {
    type: Type.BOOLEAN,
    description:
      "True if there is a genuine negative beat or complaint anywhere in the response, even if the overall testimonial resolves positively.",
  },
  actionable_feedback: {
    type: Type.STRING,
    nullable: true,
    description:
      "If contains_complaint is true, the specific complaint or suggestion in plain text. Null if contains_complaint is false.",
  },
  highlight_score: {
    type: Type.NUMBER,
    description:
      "0-1 composite score for how strong a candidate this segment is for a highlight reel, weighing relevance, sentiment strength, and quote quality together.",
  },
};

const CORE_FIELD_NAMES = Object.keys(CORE_PROPERTIES);

// A question's extraction_spec: an array of scalar field descriptors, e.g.
// [{ "name": "biggest_challenge", "type": "string", "description": "..." }].
// This is the entire mechanism for adding a new extracted value — no code
// change, just a row edit on Question.extraction_spec.
type ExtractionFieldSpec = {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  nullable?: boolean;
};

const EXTRACTION_TYPE_MAP: Record<ExtractionFieldSpec["type"], Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  boolean: Type.BOOLEAN,
};

function isExtractionFieldSpec(value: unknown): value is ExtractionFieldSpec {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    (v.type === "string" || v.type === "number" || v.type === "boolean")
  );
}

// Malformed entries are dropped rather than thrown on — a typo in one
// question's extraction_spec shouldn't take down analysis of the nine core
// fields, which every report depends on.
function parseExtractionSpec(extractionSpec: unknown): ExtractionFieldSpec[] {
  if (!Array.isArray(extractionSpec)) return [];
  return extractionSpec.filter(isExtractionFieldSpec);
}

function buildResponseSchema(fields: ExtractionFieldSpec[]) {
  const extractedProperties: Record<string, unknown> = {};
  const extractedRequired: string[] = [];
  for (const field of fields) {
    extractedProperties[field.name] = {
      type: EXTRACTION_TYPE_MAP[field.type],
      description: field.description,
      ...(field.nullable && { nullable: true }),
    };
    if (!field.nullable) extractedRequired.push(field.name);
  }

  return {
    type: Type.OBJECT,
    properties: {
      ...CORE_PROPERTIES,
      extracted: {
        type: Type.OBJECT,
        description:
          fields.length > 0
            ? "Question-specific extracted values — see the field list in the prompt."
            : "No question-specific fields apply here; return an empty object.",
        properties: extractedProperties,
        ...(extractedRequired.length > 0 && { required: extractedRequired }),
      },
    },
    required: [...CORE_FIELD_NAMES, "extracted"],
  };
}

function buildExtractionInstructions(fields: ExtractionFieldSpec[]): string {
  if (fields.length === 0) {
    return 'This question has no question-specific fields defined. Return an empty object for "extracted".';
  }
  const fieldList = fields
    .map((f) => `- ${f.name} (${f.type}${f.nullable ? ", nullable" : ""}): ${f.description}`)
    .join("\n");
  return `Also extract these question-specific fields into "extracted":\n${fieldList}`;
}

export async function analyzeSentiment(
  transcriptText: string,
  languageDetected: string,
  questionText: string,
  extractionSpec: unknown,
): Promise<SentimentAnalysis> {
  const fields = parseExtractionSpec(extractionSpec);

  const response = await generateContentWithRetry({
    // Pinned, not "-latest" - that alias is what silently put this on
    // gemini-3.8-flash (confirmed via the quota-exceeded error's model
    // field), the newest and most quota-constrained model in the family
    // (5 RPM / 20 RPD on the free tier). gemini-3.5-flash-lite gets 15 RPM
    // / 500 RPD instead - plenty of headroom for sentiment/theme
    // extraction, which doesn't need the newest model's extra reasoning
    // depth. Revisit if extraction quality ever seems to suffer for it.
    model: "gemini-3.5-flash-lite",
    contents: `Analyze this customer testimonial transcript. It is in ${languageDetected}.

The question the person was asked: "${questionText}"

Extract sentiment, themes, and a one-to-two sentence summary. Also pull out the single most quotable verbatim moment (best_quote — copy it exactly, don't paraphrase), judge whether the response actually answers the question asked (is_relevant), flag whether it's safe to publish externally regardless of sentiment (moderation_flag), and check whether there's any genuine complaint or negative beat even inside an overall-positive response (contains_complaint) — if so, extract the specific complaint as actionable_feedback, otherwise leave it null. Score highlight_score (0-1) for how strong a highlight-reel candidate this segment is, weighing relevance, sentiment strength, and quote quality together.

${buildExtractionInstructions(fields)}

Transcript:
${transcriptText}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: buildResponseSchema(fields),
    },
  });

  if (!response.text) {
    throw new Error("Gemini returned no text in response");
  }

  return JSON.parse(response.text) as SentimentAnalysis;
}
