import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import {
  getDownloadUrl,
  uploadTextObject,
  uploadFileObject,
  objectExists,
  buildCaptionedVideoKey,
} from "../services/s3";
import { extractAudio, burnCaptions } from "../services/ffmpeg";
import { transcribeAudio } from "../services/elevenlabs";
import { buildSrt, buildVtt } from "../services/captions";
import { analyzeSentiment } from "../services/gemini";
import { localizeQuestion } from "../services/questions";
import { config } from "../config/env";
import type { JobRow } from "./types";

function captionKey(videoKey: string, ext: "srt" | "vtt"): string {
  return videoKey.replace(/\.[^.]+$/, `.${ext}`);
}

async function timeStage<T>(
  segmentId: string,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  console.log(`[transcribe_segment] segment=${segmentId} stage=${stage} starting`);
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
    include: { distributor: true },
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

    const captionedVideoKey = buildCaptionedVideoKey(segment.video_key);
    if (!(await objectExists(captionedVideoKey))) {
      await timeStage(segment_id, "ffmpeg_burn_captions", async () => {
        const [videoUrl, srtUrl] = await Promise.all([
          getDownloadUrl(segment.video_key),
          getDownloadUrl(transcript.srt_key),
        ]);
        const srtRes = await fetch(srtUrl);
        const srtText = await srtRes.text();
        await writeFile(join(tmpDir, "captions.srt"), srtText);

        await burnCaptions(videoUrl, tmpDir, "captions.srt", "captioned.mp4", {
          trimStartMs: segment.trim_start_ms,
          trimEndMs: segment.trim_end_ms,
        });
        await uploadFileObject(captionedVideoKey, join(tmpDir, "captioned.mp4"), "video/mp4");
      });
    }

    const existingSentiment = await prisma.sentimentResult.findUnique({ where: { segment_id } });
    if (!existingSentiment) {
      const question = await prisma.question.findUnique({
        where: {
          client_id_index: { client_id: segment.distributor.client_id, index: segment.question_index },
        },
      });
      if (!question) {
        throw new Error(
          `No question configured for client ${segment.distributor.client_id} at index ${segment.question_index}`,
        );
      }
      const { text: questionText } = localizeQuestion(question, segment.distributor.language_pref);

      const analysis = await timeStage(segment_id, "gemini_analyze_sentiment", () =>
        analyzeSentiment(transcript.text, transcript.language_detected, questionText, question.extraction_spec),
      );
      await timeStage(segment_id, "db_write_sentiment", () =>
        prisma.sentimentResult.create({
          data: {
            segment_id,
            sentiment_score: analysis.sentiment_score,
            themes: analysis.themes,
            summary: analysis.summary,
            best_quote: analysis.best_quote,
            is_relevant: analysis.is_relevant,
            moderation_flag: analysis.moderation_flag,
            contains_complaint: analysis.contains_complaint,
            actionable_feedback: analysis.actionable_feedback,
            highlight_score: analysis.highlight_score,
            extracted: analysis.extracted as Prisma.InputJsonValue,
          },
        }),
      );
    }

    // A segment is complete once uploaded and transcribed - "transcribed"
    // is the terminal Segment.status regardless of whether rendering is
    // enabled (render completion is tracked separately, on RenderedVideo).
    await prisma.segment.update({ where: { id: segment_id }, data: { status: "transcribed" } });

    // render_segment depends on the captioned video this job just produced, so
    // it's queued here rather than alongside transcribe_segment at confirm-time
    // — still fires per-segment, just triggered by this job's completion
    // instead of upload confirm. Guard against duplicate queuing on retries.
    // Gated on ENABLE_REEL_RENDERING: the branded template isn't ready for
    // this build, so no render job (and no nexrender call) should ever be
    // created - rendering code itself stays intact, just never triggered.
    if (config.ENABLE_REEL_RENDERING) {
      const existingRenderJob = await prisma.job.findFirst({
        where: { type: "render_segment", payload: { path: ["segment_id"], equals: segment_id } },
      });
      if (!existingRenderJob) {
        await prisma.job.create({ data: { type: "render_segment", payload: { segment_id } } });
      }
    } else {
      console.log(`[transcribe_segment] segment=${segment_id} reel rendering disabled - skipping render_segment`);
    }

    console.log(`[transcribe_segment] segment=${segment_id} stage=TOTAL ms=${Date.now() - handlerStart}`);
  } catch (err) {
    await prisma.segment.update({ where: { id: segment_id }, data: { status: "failed" } });
    throw err;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
