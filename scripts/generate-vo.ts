// One-off generation of question VO audio via ElevenLabs TTS (eleven_v3),
// for all 5 education questions in en/hi/mr. Uploads to every seeded
// client's vo_key_{lang} S3 path (question text/audio is identical across
// IFB/Voltas/Zeist today) and also saves a local copy under
// assets/audio/vo/ for manual QC (listening, pronunciation-checking) before
// treating these as real. Also re-saves each touched Question row (same
// vo_key value) so Prisma's @updatedAt fires - the S3 object is overwritten
// in place under the same key, so without this write Question.updated_at
// would never reflect the new audio, and the frontend's per-question
// staleness check (API_CONTRACT.md) would never invalidate a cached clip.
// Run with `npm run generate-vo`.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { config } from "../src/config/env";
import { uploadFileObject } from "../src/services/s3";

const VOICE_ID = "mCQMfsqGDT6IDkEKR20a"; // "Jeevan" - user-selected
const MODEL_ID = "eleven_v3";
const LANGUAGES = ["en", "hi", "mr"] as const;
type Lang = (typeof LANGUAGES)[number];

const CLIENT_NAMES = ["IFB Appliances", "Voltas", "Zeist"] as const;

const LOCAL_OUT_DIR = join(__dirname, "..", "assets", "audio", "vo");

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Light v3 audio tags for a more natural, less flat-robotic delivery - kept
// minimal since these are short single-sentence prompts, not narration.
// Tags are bracket directives to the model, given in English regardless of
// the spoken language (v3's documented convention).
const DELIVERY_TAG: Record<number, string> = {
  1: "[warmly]",
  2: "[warmly]",
  3: "[thoughtfully]",
  4: "[curiously]",
  5: "[curiously]",
};

function taggedText(index: number, text: string): string {
  return `${DELIVERY_TAG[index] ?? ""} ${text}`.trim();
}

async function synthesize(text: string): Promise<Buffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": config.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
    },
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  await mkdir(LOCAL_OUT_DIR, { recursive: true });

  const clients = await Promise.all(
    CLIENT_NAMES.map((name) => prisma.client.findUniqueOrThrow({ where: { name } })),
  );

  // Question text is identical across all 3 clients today (same seeded
  // education set) - only need one client's rows to get the text.
  const questions = await prisma.question.findMany({
    where: { client_id: clients[0].id },
    orderBy: { index: "asc" },
  });

  const textFor: Record<number, Record<Lang, string>> = {};
  for (const q of questions) {
    textFor[q.index] = { en: q.text_en, hi: q.text_hi, mr: q.text_mr };
  }

  for (const q of questions) {
    for (const lang of LANGUAGES) {
      const text = taggedText(q.index, textFor[q.index][lang]);
      console.log(`[generate-vo] q${q.index} ${lang}: "${text}"`);

      const audio = await synthesize(text);

      const localPath = join(LOCAL_OUT_DIR, `q${q.index}_${lang}.mp3`);
      await writeFile(localPath, audio);
      console.log(`  saved local: ${localPath} (${audio.length} bytes)`);

      for (const client of clients) {
        const key = `static/question-vo/${client.id}/${lang}/${q.index}.mp3`;
        await uploadFileObject(key, localPath, "audio/mpeg");
        console.log(`  uploaded: s3://.../${key}`);

        const voKeyField = `vo_key_${lang}` as const;
        await prisma.question.update({
          where: { client_id_index: { client_id: client.id, index: q.index } },
          data: { [voKeyField]: key },
        });
      }
    }
  }

  console.log("\n[generate-vo] done - listen to assets/audio/vo/*.mp3 before trusting these.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
