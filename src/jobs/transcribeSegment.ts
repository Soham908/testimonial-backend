import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../db/prisma";
import { getDownloadUrl, uploadTextObject } from "../services/s3";
import { extractAudio } from "../services/ffmpeg";
import { transcribeAudio } from "../services/elevenlabs";
import { buildSrt, buildVtt } from "../services/captions";
import { analyzeSentiment } from "../services/gemini";
import type { JobRow } from "./types";

function captionKey(videoKey: string, ext: "srt" | "vtt"): string {
  return videoKey.replace(/\.[^.]+$/, `.${ext}`);
}

async function timeStage<T>(
  segmentId: string,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    console.log(`[transcribe_segment] segment=${segmentId} stage=${stage} ms=${Date.now() - start}`);
  }
}

export async function transcribeSegmentHandler(job: JobRow): Promise<void> {
  const { segment_id } = job.payload as { segment_id: string };
  const handlerStart = Date.now();

  const segment = await prisma.segment.update({
    where: { id: segment_id },
    data: { status: "transcribing" },
  });

  const tmpDir = await mkdtemp(join(tmpdir(), `segment-${segment_id}-`));
  const audioPath = join(tmpDir, "audio.mp3");

  try {
    let transcript = await prisma.transcript.findUnique({ where: { segment_id } });

    if (!transcript) {
      await timeStage(segment_id, "ffmpeg_extract_audio", async () => {
        const videoUrl = await getDownloadUrl(segment.video_key);
        await extractAudio(videoUrl, audioPath);
      });
      const result = await timeStage(segment_id, "elevenlabs_transcribe", () =>
        transcribeAudio(audioPath),
      );

      const srtKey = captionKey(segment.video_key, "srt");
      const vttKey = captionKey(segment.video_key, "vtt");
      await timeStage(segment_id, "s3_upload_captions", async () => {
        await uploadTextObject(srtKey, buildSrt(result.words), "application/x-subrip");
        await uploadTextObject(vttKey, buildVtt(result.words), "text/vtt");
      });

      transcript = await timeStage(segment_id, "db_write_transcript", () =>
        prisma.transcript.create({
          data: {
            segment_id,
            text: result.text,
            language_detected: result.language_detected,
            srt_key: srtKey,
            vtt_key: vttKey,
          },
        }),
      );
    }

    const existingSentiment = await prisma.sentimentResult.findUnique({ where: { segment_id } });
    if (!existingSentiment) {
      const analysis = await timeStage(segment_id, "gemini_analyze_sentiment", () =>
        analyzeSentiment(transcript.text),
      );
      await timeStage(segment_id, "db_write_sentiment", () =>
        prisma.sentimentResult.create({
          data: {
            segment_id,
            sentiment_score: analysis.sentiment_score,
            themes: analysis.themes,
            summary: analysis.summary,
          },
        }),
      );
    }

    await prisma.segment.update({ where: { id: segment_id }, data: { status: "transcribed" } });
    console.log(`[transcribe_segment] segment=${segment_id} stage=TOTAL ms=${Date.now() - handlerStart}`);
  } catch (err) {
    await prisma.segment.update({ where: { id: segment_id }, data: { status: "failed" } });
    throw err;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
