import { GoogleGenAI, Type } from "@google/genai";
import { config } from "../config/env";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

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
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
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
  },
  required: [
    "sentiment_score",
    "themes",
    "summary",
    "best_quote",
    "is_relevant",
    "moderation_flag",
    "contains_complaint",
    "actionable_feedback",
    "highlight_score",
  ],
};

export async function analyzeSentiment(transcriptText: string): Promise<SentimentAnalysis> {
  const response = await ai.models.generateContent({
    model: "gemini-flash-latest",
    contents: `Analyze this customer testimonial transcript.

Extract sentiment, themes, and a one-to-two sentence summary. Also pull out the single most quotable verbatim moment (best_quote — copy it exactly, don't paraphrase), judge whether the response actually answers the question asked (is_relevant), flag whether it's safe to publish externally regardless of sentiment (moderation_flag), and check whether there's any genuine complaint or negative beat even inside an overall-positive response (contains_complaint) — if so, extract the specific complaint as actionable_feedback, otherwise leave it null. Finally, score highlight_score (0-1) for how strong a highlight-reel candidate this segment is, weighing relevance, sentiment strength, and quote quality together.

Transcript:
${transcriptText}`,
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
