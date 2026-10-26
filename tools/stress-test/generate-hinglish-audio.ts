import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

type ScriptEntry = {
  distributor_name: string;
  question_index: number;
  script_text: string;
};

type ManifestEntry = {
  distributor_name: string;
  question_index: number;
  filename: string;
  characters: number;
  estimated_usd: number;
  bytes: number;
  generated_at: string;
};

const ROOT = __dirname;
const INPUT_PATH = join(ROOT, "hinglish-distributor-scripts.json");
const OUTPUT_DIR = join(ROOT, "audio");
const MANIFEST_PATH = join(ROOT, "audio-manifest.json");

// Existing project-selected multilingual voice. Flash v2.5 supports
// multilingual generation and costs $0.05 per 1,000 API characters.
const VOICE_ID = "mCQMfsqGDT6IDkEKR20a";
const MODEL_ID = "eleven_flash_v2_5";
const USD_PER_1K_CHARS = 0.05;
const EXPECTED_CHARACTERS = 100_000;
const MAX_ALLOWED_CHARACTERS = 110_000;
const MAX_RETRIES = 4;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function filenameFor(entry: ScriptEntry, index: number): string {
  return `${String(index + 1).padStart(3, "0")}-${slug(entry.distributor_name)}-q${entry.question_index}.mp3`;
}

function estimatedUsd(characters: number): number {
  return Number(((characters / 1000) * USD_PER_1K_CHARS).toFixed(4));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function synthesize(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is required");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: MODEL_ID,
          apply_text_normalization: "auto",
        }),
      },
    );

    if (response.ok) return Buffer.from(await response.arrayBuffer());

    const body = await response.text();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_RETRIES) {
      throw new Error(`ElevenLabs TTS failed (${response.status}): ${body}`);
    }
    const delay = 1000 * 2 ** (attempt - 1);
    console.warn(`[audio] ElevenLabs ${response.status}; retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
    await sleep(delay);
  }
  throw new Error("Unreachable retry state");
}

async function fileExistsWithData(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function loadManifest(): Promise<ManifestEntry[]> {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as ManifestEntry[];
  } catch {
    return [];
  }
}

async function main() {
  const sampleOnly = process.argv.includes("--sample");
  const scripts = JSON.parse(await readFile(INPUT_PATH, "utf8")) as ScriptEntry[];
  if (scripts.length !== 100) throw new Error(`Expected 100 scripts; found ${scripts.length}`);

  const totalCharacters = scripts.reduce((sum, script) => sum + script.script_text.length, 0);
  if (totalCharacters > MAX_ALLOWED_CHARACTERS) {
    throw new Error(
      `Refusing generation: ${totalCharacters} characters exceeds ${MAX_ALLOWED_CHARACTERS} hard cap around the ${EXPECTED_CHARACTERS} estimate.`,
    );
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const manifest = await loadManifest();
  const selected = sampleOnly ? scripts.slice(0, 1) : scripts;
  let generatedCharacters = 0;
  let generatedCount = 0;
  let skippedCount = 0;

  console.log(
    `[audio] model=${MODEL_ID} voice=${VOICE_ID} scripts=${selected.length}/${scripts.length} ` +
      `source_chars=${totalCharacters} estimated_full_cost=$${estimatedUsd(totalCharacters).toFixed(4)} ` +
      `hard_cap=${MAX_ALLOWED_CHARACTERS}`,
  );

  for (const entry of selected) {
    const originalIndex = scripts.indexOf(entry);
    const filename = filenameFor(entry, originalIndex);
    const outputPath = join(OUTPUT_DIR, filename);
    const characters = entry.script_text.length;

    if (await fileExistsWithData(outputPath)) {
      skippedCount++;
      // A process can be interrupted after writeFile succeeds but before the
      // manifest write. Recover that locally saved result on the next run
      // instead of needlessly re-calling (and re-billing) ElevenLabs.
      if (!manifest.some((item) => item.filename === filename)) {
        const existing = await stat(outputPath);
        manifest.push({
          distributor_name: entry.distributor_name,
          question_index: entry.question_index,
          filename,
          characters,
          estimated_usd: estimatedUsd(characters),
          bytes: existing.size,
          generated_at: new Date().toISOString(),
        });
        await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`[audio] recovered manifest entry for ${filename}; no API call made`);
      }
      console.log(`[audio] ${originalIndex + 1}/100 skip ${filename}; cumulative_new_chars=${generatedCharacters}`);
      continue;
    }

    if (generatedCharacters + characters > MAX_ALLOWED_CHARACTERS) {
      throw new Error(`Hard cap reached before ${filename}; stopping with ${generatedCharacters} newly generated characters.`);
    }

    const audio = await synthesize(entry.script_text);
    await writeFile(outputPath, audio);
    generatedCharacters += characters;
    generatedCount++;

    const record: ManifestEntry = {
      distributor_name: entry.distributor_name,
      question_index: entry.question_index,
      filename,
      characters,
      estimated_usd: estimatedUsd(characters),
      bytes: audio.length,
      generated_at: new Date().toISOString(),
    };
    const oldIndex = manifest.findIndex((item) => item.filename === filename);
    if (oldIndex >= 0) manifest[oldIndex] = record;
    else manifest.push(record);
    await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(
      `[audio] ${originalIndex + 1}/100 saved ${filename}; chars=${characters}; ` +
        `cumulative_new_chars=${generatedCharacters}; estimated_new_cost=$${estimatedUsd(generatedCharacters).toFixed(4)}`,
    );
  }

  console.log(
    `[audio] complete generated=${generatedCount} skipped=${skippedCount} ` +
      `new_chars=${generatedCharacters} estimated_new_cost=$${estimatedUsd(generatedCharacters).toFixed(4)}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
