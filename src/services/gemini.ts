import { GoogleGenAI, Type } from "@google/genai";
import { config } from "../config/env";

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

export type SentimentAnalysis = {
  sentiment_score: number;
  themes: string[];
  summary: string;
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
  },
  required: ["sentiment_score", "themes", "summary"],
};

export async function analyzeSentiment(transcriptText: string): Promise<SentimentAnalysis> {
  const response = await ai.models.generateContent({
    model: "gemini-flash-latest",
    contents: `Analyze this customer testimonial transcript for sentiment and themes:\n\n${transcriptText}`,
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
