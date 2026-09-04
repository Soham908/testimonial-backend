// One-off import of the user's own trimmed/split VO recordings
// (assets/audio/new_vo/*.m4a - a single per-language take covering all 5
// questions, split into 5 files by the user after recording) - replaces the
// earlier ElevenLabs-generated placeholders. Converts each m4a to mp3 (the
// vo_key_* columns are already fixed to .mp3, seeded at question-creation
// time - converting here keeps that convention intact rather than touching
// schema/code for a different extension), saves the result into
// assets/audio/vo/ (same local naming as generate-vo.ts, for consistency),
// and uploads to every seeded client's vo_key_{lang} S3 path. Also re-saves
// each touched Question row (same vo_key value) so Prisma's @updatedAt
// fires - the S3 object is overwritten in place under the same key, so
// without this write Question.updated_at would never reflect the new audio,
// and the frontend's per-question staleness check (API_CONTRACT.md) would
// never invalidate a cached clip. Run with `npm run import-vo`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { uploadFileObject } from "../src/services/s3";

const execFileAsync = promisify(execFile);

const SOURCE_DIR = join(__dirname, "..", "assets", "audio", "new_vo");
const LOCAL_OUT_DIR = join(__dirname, "..", "assets", "audio", "vo");

const CLIENT_NAMES = ["IFB Appliances", "Voltas", "Zeist"] as const;

// User-confirmed mapping: the split index in the filename maps directly to
// question order - unsuffixed file is question 1, then (1)-(4) are
// questions 2-5 in sequence.
const SPLIT_SUFFIX_FOR_QUESTION: Record<number, string> = {
  1: "",
  2: " (1)",
  3: " (2)",
  4: " (3)",
  5: " (4)",
};

const LANG_FILE_TAG: Record<"en" | "hi" | "mr", string> = {
  en: "en",
  hi: "hn", // user's file naming uses "hn", not "hi"
  mr: "mr",
};

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function convertToMp3(sourcePath: string, destPath: string): Promise<void> {
  await execFileAsync("ffmpeg", ["-y", "-i", sourcePath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", destPath]);
}

async function main() {
  await mkdir(LOCAL_OUT_DIR, { recursive: true });

  const clients = await Promise.all(
    CLIENT_NAMES.map((name) => prisma.client.findUniqueOrThrow({ where: { name } })),
  );

  for (const lang of ["en", "hi", "mr"] as const) {
    for (let index = 1; index <= 5; index++) {
      const suffix = SPLIT_SUFFIX_FOR_QUESTION[index];
      const sourceFile = join(SOURCE_DIR, `question1_${LANG_FILE_TAG[lang]}${suffix}.m4a`);
      const destFile = join(LOCAL_OUT_DIR, `q${index}_${lang}.mp3`);

      console.log(`[import-vo] q${index} ${lang}: ${sourceFile} -> ${destFile}`);
      await convertToMp3(sourceFile, destFile);

      for (const client of clients) {
        const key = `static/question-vo/${client.id}/${lang}/${index}.mp3`;
        await uploadFileObject(key, destFile, "audio/mpeg");
        console.log(`  uploaded: s3://.../${key}`);

        const voKeyField = `vo_key_${lang}` as const;
        await prisma.question.update({
          where: { client_id_index: { client_id: client.id, index } },
          data: { [voKeyField]: key },
        });
      }
    }
  }

  console.log("\n[import-vo] done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
