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
