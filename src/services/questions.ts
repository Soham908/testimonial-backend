import type { Question } from "@prisma/client";

export type SupportedLanguage = "en" | "hi" | "mr";

const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = ["en", "hi", "mr"];

function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

// Distributor.language_pref is a free-form string (not a DB enum), so a
// value outside the three languages we actually have content for falls back
// to English rather than surfacing an empty/undefined field to the app.
export function resolveLanguage(languagePref: string): SupportedLanguage {
  return isSupportedLanguage(languagePref) ? languagePref : "en";
}

// Shape of Question.talking_points — see the schema comment. Stored as one
// JSON object (not per-language columns like text_en/hi/mr) since these are
// UI nudges, not queried/reported on the way the fixed text columns are.
interface TalkingPoints {
  en: string[];
  hi: string[] | null;
  mr: string[] | null;
}

function isTalkingPoints(value: unknown): value is TalkingPoints {
  return typeof value === "object" && value !== null && Array.isArray((value as TalkingPoints).en);
}

export interface LocalizedQuestion {
  text: string;
  vo_key: string;
  // Null when talking_points is missing entirely, or when the resolved
  // language's array hasn't been translated yet (hi/mr today) — no
  // fallback to English, since untranslated nudges wouldn't be usable.
  talking_points: string[] | null;
}

export function localizeQuestion(question: Question, languagePref: string): LocalizedQuestion {
  const language = resolveLanguage(languagePref);
  const points = isTalkingPoints(question.talking_points) ? question.talking_points[language] : null;

  switch (language) {
    case "hi":
      return { text: question.text_hi, vo_key: question.vo_key_hi, talking_points: points };
    case "mr":
      return { text: question.text_mr, vo_key: question.vo_key_mr, talking_points: points };
    case "en":
      return { text: question.text_en, vo_key: question.vo_key_en, talking_points: points };
  }
}
