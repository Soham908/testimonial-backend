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

export interface LocalizedQuestion {
  text: string;
  vo_key: string;
}

export function localizeQuestion(question: Question, languagePref: string): LocalizedQuestion {
  const language = resolveLanguage(languagePref);
  switch (language) {
    case "hi":
      return { text: question.text_hi, vo_key: question.vo_key_hi };
    case "mr":
      return { text: question.text_mr, vo_key: question.vo_key_mr };
    case "en":
      return { text: question.text_en, vo_key: question.vo_key_en };
  }
}
