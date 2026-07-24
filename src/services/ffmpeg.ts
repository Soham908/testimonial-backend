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

// The subtitles filter's filename is part of a filtergraph string where ":"
// is a syntactic separator — an absolute Windows path (drive-letter colon)
// breaks its parser even when escaped (tested: single and double backslash
// escapes both fail with "Unable to parse... as image size"). Running ffmpeg
// with cwd set to the working directory and passing bare relative filenames
// sidesteps the whole escaping problem instead of fighting it.
export async function burnCaptions(
  inputUrl: string,
  workDir: string,
  srtFilename: string,
  outputFilename: string,
): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "2",
      "-i",
      inputUrl,
      "-vf",
      `subtitles=${srtFilename}`,
      "-c:a",
      "copy",
      outputFilename,
    ],
    { cwd: workDir },
  );
}
