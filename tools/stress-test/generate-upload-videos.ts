// Generates upload-ready MP4 inputs from the 100 local VO files.
//
// Intentionally sequential: only one ffmpeg process runs at a time, so this
// batch stays predictable and does not contend heavily with normal work on
// the machine. This file does nothing until explicitly run.
//
// Run later from the repository root:
//   .\node_modules\.bin\tsx.cmd tools\stress-test\generate-upload-videos.ts
//
// Optional alternate visual source:
//   .\node_modules\.bin\tsx.cmd tools\stress-test\generate-upload-videos.ts --base "C:\path\to\base.mp4"

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ScriptEntry = {
  distributor_name: string;
  question_index: number;
  script_text: string;
};

type VideoManifestEntry = {
  distributor_name: string;
  question_index: number;
  audio_filename: string;
  video_filename: string;
  source_video: string;
  audio_duration_seconds: number;
  output_duration_seconds: number;
  bytes: number;
  generated_at: string;
};

type ProbeOutput = {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string }>;
};

const ROOT = __dirname;
const SCRIPTS_PATH = join(ROOT, "hinglish-distributor-scripts.json");
const AUDIO_DIR = join(ROOT, "audio");
const OUTPUT_DIR = join(ROOT, "videos");
const MANIFEST_PATH = join(ROOT, "video-manifest.json");
const DEFAULT_BASE_VIDEO = join(ROOT, "sample video.mp4");
const DURATION_TOLERANCE_SECONDS = 0.25;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function audioFilenameFor(entry: ScriptEntry, index: number): string {
  return `${String(index + 1).padStart(3, "0")}-${slug(entry.distributor_name)}-q${entry.question_index}.mp3`;
}

function videoFilenameFor(entry: ScriptEntry, index: number): string {
  return audioFilenameFor(entry, index).replace(/\.mp3$/i, ".mp4");
}

function parseBasePath(): string {
  const index = process.argv.indexOf("--base");
  if (index === -1) return DEFAULT_BASE_VIDEO;
  const candidate = process.argv[index + 1];
  if (!candidate) throw new Error("--base requires a path");
  return resolve(candidate);
}

async function probe(path: string): Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean }> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type",
    "-of",
    "json",
    path,
  ]);
  const data = JSON.parse(stdout) as ProbeOutput;
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not read a positive duration from ${path}`);
  return {
    duration,
    hasVideo: data.streams?.some((stream) => stream.codec_type === "video") ?? false,
    hasAudio: data.streams?.some((stream) => stream.codec_type === "audio") ?? false,
  };
}

async function fileExistsWithData(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function loadManifest(): Promise<VideoManifestEntry[]> {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as VideoManifestEntry[];
  } catch {
    return [];
  }
}

async function writeManifest(entries: VideoManifestEntry[]): Promise<void> {
  await writeFile(MANIFEST_PATH, `${JSON.stringify(entries, null, 2)}\n`);
}

async function createVideo(baseVideo: string, audioPath: string, outputPath: string): Promise<void> {
  // `-stream_loop -1` makes the video repeat only when a VO is longer than
  // the base. `-shortest` then ends the MP4 with the new VO exactly. The only
  // mapped audio stream is the VO, so the source video's original audio is
  // wholly discarded. Video stream-copy avoids an unnecessary visual encode;
  // the backend's actual normalization/render pipeline remains the component
  // that performs real visual re-encoding later.
  await execFileAsync("ffmpeg", [
    "-y",
    "-stream_loop",
    "-1",
    "-i",
    baseVideo,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-map_metadata",
    "-1",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath,
  ]);
}

async function main(): Promise<void> {
  const scripts = JSON.parse(await readFile(SCRIPTS_PATH, "utf8")) as ScriptEntry[];
  if (scripts.length !== 100) throw new Error(`Expected exactly 100 scripts, found ${scripts.length}`);

  const baseVideo = parseBasePath();
  const baseProbe = await probe(baseVideo);
  if (!baseProbe.hasVideo) throw new Error(`Base file has no video stream: ${baseVideo}`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const manifest = await loadManifest();
  const names = new Set<string>();

  console.log(
    `[videos] base=${baseVideo} duration=${baseProbe.duration.toFixed(3)}s scripts=${scripts.length} mode=sequential`,
  );

  for (const [index, entry] of scripts.entries()) {
    const audioFilename = audioFilenameFor(entry, index);
    const videoFilename = videoFilenameFor(entry, index);
    if (names.has(videoFilename)) throw new Error(`Duplicate output filename: ${videoFilename}`);
    names.add(videoFilename);

    const audioPath = join(AUDIO_DIR, audioFilename);
    const outputPath = join(OUTPUT_DIR, videoFilename);
    const audioProbe = await probe(audioPath);
    if (!audioProbe.hasAudio) throw new Error(`VO file has no audio stream: ${audioPath}`);

    if (await fileExistsWithData(outputPath)) {
      // A command-window interruption can leave a non-empty but incomplete
      // MP4 (without its final moov atom). It is not a usable output, so
      // remove only that exact failed file and let the normal creation path
      // below regenerate it. Valid completed files are never overwritten.
      try {
        await probe(outputPath);
      } catch {
        console.warn(`[videos] removing incomplete output ${videoFilename}; it will be regenerated`);
        await rm(outputPath, { force: true });
      }

      if (await fileExistsWithData(outputPath)) {
      // An interrupted run can finish ffmpeg's file write just before the
      // manifest write. Recover that result on resume rather than rendering
      // (and spending local CPU on) the same output again.
      if (!manifest.some((item) => item.video_filename === videoFilename)) {
        const existingProbe = await probe(outputPath);
        if (!existingProbe.hasVideo || !existingProbe.hasAudio) {
          throw new Error(`Existing output is missing a required stream: ${outputPath}`);
        }
        if (Math.abs(existingProbe.duration - audioProbe.duration) > DURATION_TOLERANCE_SECONDS) {
          throw new Error(
            `Existing output duration mismatch for ${videoFilename}: ` +
              `audio=${audioProbe.duration.toFixed(3)}s output=${existingProbe.duration.toFixed(3)}s`,
          );
        }
        const existingStats = await stat(outputPath);
        manifest.push({
          distributor_name: entry.distributor_name,
          question_index: entry.question_index,
          audio_filename: audioFilename,
          video_filename: videoFilename,
          source_video: baseVideo,
          audio_duration_seconds: Number(audioProbe.duration.toFixed(3)),
          output_duration_seconds: Number(existingProbe.duration.toFixed(3)),
          bytes: existingStats.size,
          generated_at: new Date().toISOString(),
        });
        await writeManifest(manifest);
        console.log(`[videos] recovered manifest entry for ${videoFilename}; no re-render`);
      }
      console.log(`[videos] ${index + 1}/100 skip ${videoFilename}; already exists`);
      continue;
      }
    }

    console.log(`[videos] ${index + 1}/100 start ${videoFilename}`);
    await createVideo(baseVideo, audioPath, outputPath);

    const outputProbe = await probe(outputPath);
    if (!outputProbe.hasVideo || !outputProbe.hasAudio) {
      throw new Error(`Output is missing a required stream: ${outputPath}`);
    }
    if (Math.abs(outputProbe.duration - audioProbe.duration) > DURATION_TOLERANCE_SECONDS) {
      throw new Error(
        `Duration mismatch for ${videoFilename}: audio=${audioProbe.duration.toFixed(3)}s output=${outputProbe.duration.toFixed(3)}s`,
      );
    }

    const outputStats = await stat(outputPath);
    const record: VideoManifestEntry = {
      distributor_name: entry.distributor_name,
      question_index: entry.question_index,
      audio_filename: audioFilename,
      video_filename: videoFilename,
      source_video: baseVideo,
      audio_duration_seconds: Number(audioProbe.duration.toFixed(3)),
      output_duration_seconds: Number(outputProbe.duration.toFixed(3)),
      bytes: outputStats.size,
      generated_at: new Date().toISOString(),
    };
    const existingIndex = manifest.findIndex((item) => item.video_filename === videoFilename);
    if (existingIndex >= 0) manifest[existingIndex] = record;
    else manifest.push(record);
    await writeManifest(manifest);

    console.log(
      `[videos] ${index + 1}/100 done ${videoFilename}; duration=${record.output_duration_seconds}s bytes=${record.bytes}`,
    );
  }

  console.log(`[videos] complete. Outputs are in ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
