import type { TranscriptWord } from "./elevenlabs";

const MAX_WORDS_PER_CUE = 10;

function chunkWords(words: TranscriptWord[]): TranscriptWord[][] {
  const relevant = words.filter((w) => w.type !== "spacing");
  const chunks: TranscriptWord[][] = [];
  for (let i = 0; i < relevant.length; i += MAX_WORDS_PER_CUE) {
    chunks.push(relevant.slice(i, i + MAX_WORDS_PER_CUE));
  }
  return chunks;
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, "0");
}

function formatSrtTime(seconds: number): string {
  const totalMs = Math.round(seconds * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function formatVttTime(seconds: number): string {
  return formatSrtTime(seconds).replace(",", ".");
}

export function buildSrt(words: TranscriptWord[]): string {
  return chunkWords(words)
    .map((chunk, i) => {
      const first = chunk[0]!;
      const last = chunk[chunk.length - 1]!;
      const text = chunk.map((w) => w.text).join(" ");
      return `${i + 1}\n${formatSrtTime(first.start)} --> ${formatSrtTime(last.end)}\n${text}\n`;
    })
    .join("\n");
}

export function buildVtt(words: TranscriptWord[]): string {
  const cues = chunkWords(words)
    .map((chunk) => {
      const first = chunk[0]!;
      const last = chunk[chunk.length - 1]!;
      const text = chunk.map((w) => w.text).join(" ");
      return `${formatVttTime(first.start)} --> ${formatVttTime(last.end)}\n${text}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${cues}`;
}
