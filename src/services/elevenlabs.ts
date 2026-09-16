import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { config } from "../config/env";

export type TranscriptWord = {
  text: string;
  start: number;
  end: number;
  type: "word" | "spacing" | "audio_event";
};

export type TranscriptionResult = {
  text: string;
  language_detected: string;
  // Scribe's own confidence in language_detected (0-1) - a real,
  // free technical-QA signal the API already returns on every single-
  // channel response, previously received and discarded. See
  // Transcript.language_probability.
  language_probability: number;
  words: TranscriptWord[];
};

export async function transcribeAudio(filePath: string): Promise<TranscriptionResult> {
  const fileBuffer = await readFile(filePath);
  const form = new FormData();
  form.append("model_id", "scribe_v1");
  form.append("timestamps_granularity", "word");
  form.append("file", new Blob([fileBuffer]), basename(filePath));

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": config.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs transcription failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    text: string;
    language_code: string;
    language_probability: number;
    words: TranscriptWord[];
  };

  return {
    text: data.text,
    language_detected: data.language_code,
    language_probability: data.language_probability,
    words: data.words ?? [],
  };
}
