/** Create upload-ready Round 2 MP4s from the Round 2 ElevenLabs MP3s. */

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type ScriptEntry = { distributor_name: string; question_index: number; script_text: string };
type Probe = { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
type VideoEntry = { distributor_name: string; question_index: number; audio_filename: string; video_filename: string; source_video: string; audio_duration_seconds: number; output_duration_seconds: number; bytes: number; generated_at: string };

const ROOT = __dirname;
const INPUT_PATH = join(ROOT, "round-2-negative-scripts.json");
const AUDIO_DIR = join(ROOT, "round-2", "audio");
const OUTPUT_DIR = join(ROOT, "round-2", "videos");
const MANIFEST_PATH = join(ROOT, "round-2", "video-manifest.json");
const DEFAULT_BASE = join(ROOT, "sample video.mp4");
const TOLERANCE = 0.25;

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); }
function audioFilename(entry: ScriptEntry, index: number): string { return `r2-${String(index + 1).padStart(3, "0")}-${slug(entry.distributor_name)}-q${entry.question_index}.mp3`; }
function videoFilename(entry: ScriptEntry, index: number): string { return audioFilename(entry, index).replace(/\.mp3$/i, ".mp4"); }
function basePath(): string { const i = process.argv.indexOf("--base"); return i < 0 ? DEFAULT_BASE : resolve(process.argv[i + 1] ?? ""); }

async function probe(filePath: string): Promise<{ duration: number; hasVideo: boolean; hasAudio: boolean }> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", filePath]);
  const data = JSON.parse(stdout) as Probe;
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not read duration from ${filePath}`);
  return { duration, hasVideo: data.streams?.some(({ codec_type }) => codec_type === "video") ?? false, hasAudio: data.streams?.some(({ codec_type }) => codec_type === "audio") ?? false };
}
async function existsWithData(filePath: string): Promise<boolean> { try { return (await stat(filePath)).size > 0; } catch { return false; } }
async function loadManifest(): Promise<VideoEntry[]> { try { return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as VideoEntry[]; } catch { return []; } }
async function saveManifest(entries: VideoEntry[]): Promise<void> { await writeFile(MANIFEST_PATH, `${JSON.stringify(entries, null, 2)}\n`); }

async function createVideo(baseVideo: string, audioPath: string, outputPath: string, audioDuration: number): Promise<void> {
  // Explicit -t avoids a stream-copy edge case where a VO just below the
  // base-video duration can leave one extra copied GOP in the MP4.
  await execFileAsync("ffmpeg", ["-y", "-stream_loop", "-1", "-i", baseVideo, "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-t", audioDuration.toFixed(3), "-shortest", "-movflags", "+faststart", outputPath]);
}

async function main(): Promise<void> {
  const scripts = JSON.parse(await readFile(INPUT_PATH, "utf8")) as ScriptEntry[];
  if (scripts.length !== 50) throw new Error(`Expected 50 Round 2 scripts; found ${scripts.length}`);
  const baseVideo = basePath();
  const base = await probe(baseVideo);
  if (!base.hasVideo) throw new Error(`Base file has no video stream: ${baseVideo}`);
  await mkdir(OUTPUT_DIR, { recursive: true });
  const manifest = await loadManifest();
  console.log(`[round-2-videos] base=${baseVideo} duration=${base.duration.toFixed(3)}s scripts=${scripts.length} mode=sequential`);

  for (const [index, entry] of scripts.entries()) {
    const audioName = audioFilename(entry, index);
    const videoName = videoFilename(entry, index);
    const audioPath = join(AUDIO_DIR, audioName);
    const outputPath = join(OUTPUT_DIR, videoName);
    const audio = await probe(audioPath);
    if (!audio.hasAudio) throw new Error(`VO has no audio stream: ${audioPath}`);
    if (await existsWithData(outputPath)) {
      try {
        const existing = await probe(outputPath);
        if (!existing.hasVideo || !existing.hasAudio || Math.abs(existing.duration - audio.duration) > TOLERANCE) await rm(outputPath, { force: true });
      } catch { await rm(outputPath, { force: true }); }
    }
    if (await existsWithData(outputPath)) {
      if (!manifest.some((item) => item.video_filename === videoName)) {
        const existing = await probe(outputPath);
        if (!existing.hasVideo || !existing.hasAudio || Math.abs(existing.duration - audio.duration) > TOLERANCE) throw new Error(`Existing output failed validation: ${outputPath}`);
        const size = (await stat(outputPath)).size;
        manifest.push({ distributor_name: entry.distributor_name, question_index: entry.question_index, audio_filename: audioName, video_filename: videoName, source_video: baseVideo, audio_duration_seconds: Number(audio.duration.toFixed(3)), output_duration_seconds: Number(existing.duration.toFixed(3)), bytes: size, generated_at: new Date().toISOString() });
        await saveManifest(manifest);
      }
      console.log(`[round-2-videos] ${index + 1}/50 skip ${videoName}`);
      continue;
    }
    console.log(`[round-2-videos] ${index + 1}/50 start ${videoName}`);
    await createVideo(baseVideo, audioPath, outputPath, audio.duration);
    const output = await probe(outputPath);
    if (!output.hasVideo || !output.hasAudio || Math.abs(output.duration - audio.duration) > TOLERANCE) throw new Error(`Output validation failed for ${videoName}`);
    const record: VideoEntry = { distributor_name: entry.distributor_name, question_index: entry.question_index, audio_filename: audioName, video_filename: videoName, source_video: baseVideo, audio_duration_seconds: Number(audio.duration.toFixed(3)), output_duration_seconds: Number(output.duration.toFixed(3)), bytes: (await stat(outputPath)).size, generated_at: new Date().toISOString() };
    const oldIndex = manifest.findIndex((item) => item.video_filename === videoName);
    if (oldIndex >= 0) manifest[oldIndex] = record; else manifest.push(record);
    await saveManifest(manifest);
    console.log(`[round-2-videos] ${index + 1}/50 done ${videoName}; duration=${record.output_duration_seconds}s bytes=${record.bytes}`);
  }
  console.log(`[round-2-videos] complete. Outputs are in ${OUTPUT_DIR}`);
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
