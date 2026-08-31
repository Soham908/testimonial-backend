import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// inputUrl is expected to be a presigned HTTPS URL — ffmpeg reads only the byte
// ranges it needs via HTTP range requests rather than us downloading the whole
// object first, and the reconnect flags cover transient network hiccups on that
// remote read.
export async function extractAudio(inputUrl: string, outputPath: string): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "2",
    "-i",
    inputUrl,
    "-vn",
    "-acodec",
    "libmp3lame",
    outputPath,
  ]);
}

// Canonical output shape every segment is normalized to, regardless of
// source phone/orientation — see the CLAUDE.md note on After Effects
// ignoring the source rotation flag and cropping the footage.
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;

export interface BurnCaptionsOptions {
  // Absolute offsets (ms) into the source clip. Not sent by the app yet —
  // always undefined/null today — but accepted now so this works the moment
  // it starts sending them.
  trimStartMs?: number | null;
  trimEndMs?: number | null;
}

// The subtitles filter's filename is part of a filtergraph string where ":"
// is a syntactic separator — an absolute Windows path (drive-letter colon)
// breaks its parser even when escaped (tested: single and double backslash
// escapes both fail with "Unable to parse... as image size"). Running ffmpeg
// with cwd set to the working directory and passing bare relative filenames
// sidesteps the whole escaping problem instead of fighting it.
//
// This same pass also normalizes orientation/format: source videos are
// stored landscape with a rotation flag that After Effects ignores, so we
// re-encode here to bake correct orientation into the pixels and discard the
// flag. Deliberately relies on ffmpeg's automatic rotation handling at
// decode (no -noautorotate, no transpose filter) so the chain is
// orientation-agnostic — it reshapes whatever frame ffmpeg hands it rather
// than applying a fixed rotation that would be correct for only one device.
export async function burnCaptions(
  inputUrl: string,
  workDir: string,
  srtFilename: string,
  outputFilename: string,
  options: BurnCaptionsOptions = {},
): Promise<void> {
  const { trimStartMs, trimEndMs } = options;

  const args = ["-y", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "2"];
  // -ss/-to as input options (before -i) are absolute offsets into the
  // input's own timeline, independent of each other — exactly what
  // trim_start_ms/trim_end_ms represent.
  if (trimStartMs != null) {
    args.push("-ss", (trimStartMs / 1000).toFixed(3));
  }
  if (trimEndMs != null) {
    args.push("-to", (trimEndMs / 1000).toFixed(3));
  }
  args.push("-i", inputUrl);

  const filterChain = [
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
    `fps=${OUTPUT_FPS}`,
    `subtitles=${srtFilename}`,
    "format=yuv420p",
  ].join(",");

  args.push(
    "-vf",
    filterChain,
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    outputFilename,
  );

  await execFileAsync("ffmpeg", args, { cwd: workDir });
  await logOutputProbe(workDir, outputFilename);
}

interface FfprobeSideData {
  side_data_type?: string;
  rotation?: number;
}

interface FfprobeStream {
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: FfprobeSideData[];
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string };
}

// Verification only, not enforcement — logs what the normalization pass
// actually produced so a bad encode is visible without failing the job.
async function logOutputProbe(workDir: string, outputFilename: string): Promise<void> {
  try {
    // Full -show_streams/-show_format (rather than a narrow -show_entries
    // list) because rotation isn't always the legacy `rotate` tag — many
    // modern encoders (e.g. Android camera output) store it as a Display
    // Matrix side_data entry instead, which -show_entries can't select.
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", outputFilename],
      { cwd: workDir },
    );
    const probe = JSON.parse(stdout) as FfprobeOutput;
    const stream = probe.streams?.[0];
    const displayMatrixRotation = stream?.side_data_list?.find(
      (sd) => sd.side_data_type === "Display Matrix",
    )?.rotation;
    const rotation = stream?.tags?.rotate ?? (displayMatrixRotation != null ? String(displayMatrixRotation) : "none");
    console.log(
      `[ffmpeg] normalize_probe output=${outputFilename} ` +
        `resolution=${stream?.width}x${stream?.height} ` +
        `sar=${stream?.sample_aspect_ratio ?? "unknown"} ` +
        `fps=${stream?.r_frame_rate ?? "unknown"} ` +
        `rotation=${rotation} ` +
        `duration=${probe.format?.duration ?? "unknown"}s ` +
        `bitrate=${probe.format?.bit_rate ?? stream?.bit_rate ?? "unknown"}`,
    );
  } catch (err) {
    console.log(
      `[ffmpeg] normalize_probe output=${outputFilename} ffprobe failed: ${(err as Error).message}`,
    );
  }
}
