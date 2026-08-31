// Standalone verification for the normalization pass in src/services/ffmpeg.ts's
// burnCaptions — runs the exact same ffmpeg command against a local file so the
// scale/pad/orientation/format handling can be checked without running the
// worker, S3, or the rest of the transcribe_segment pipeline.
//
// Usage:
//   npx tsx scripts/normalize-video.ts <input> <output> [options]
//
// Options:
//   --srt <path>            Burn real captions instead of an empty track
//   --trim-start-ms <ms>    Same semantics as segment.trim_start_ms
//   --trim-end-ms <ms>      Same semantics as segment.trim_end_ms
import { mkdtemp, rm, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { burnCaptions } from "../src/services/ffmpeg";

// burnCaptions passes -reconnect/-reconnect_streamed/-reconnect_delay_max to
// ffmpeg — those are HTTP-protocol options and ffmpeg refuses to start at all
// if they're given a local file path instead. Serving the local file over a
// throwaway loopback HTTP server lets this script exercise the exact same
// command production runs (against a presigned S3 URL) rather than special-
// casing local paths inside burnCaptions itself.
async function serveLocalFile(filePath: string): Promise<{ url: string; close: () => Promise<void> }> {
  const { size } = await stat(filePath);
  const server = createServer((req, res) => {
    const range = req.headers.range;
    // ffmpeg seeks within the input via HTTP Range requests (same as it does
    // against a real S3 presigned URL) — without honoring these, a request
    // for e.g. bytes=500000- would silently get bytes 0-, corrupting decode.
    const match = range?.match(/^bytes=(\d+)-(\d*)$/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      res.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": size });
      createReadStream(filePath).pipe(res);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/input.mp4`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function parseArgs(argv: string[]) {
  const [input, output, ...rest] = argv;
  if (!input || !output) {
    console.error("Usage: npx tsx scripts/normalize-video.ts <input> <output> [--srt <path>] [--trim-start-ms <ms>] [--trim-end-ms <ms>]");
    process.exit(1);
  }

  let srtPath: string | undefined;
  let trimStartMs: number | undefined;
  let trimEndMs: number | undefined;

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--srt") {
      srtPath = value;
      i++;
    } else if (flag === "--trim-start-ms") {
      trimStartMs = Number(value);
      i++;
    } else if (flag === "--trim-end-ms") {
      trimEndMs = Number(value);
      i++;
    } else {
      console.error(`Unrecognized argument: ${flag}`);
      process.exit(1);
    }
  }

  return { input: resolve(input), output: resolve(output), srtPath, trimStartMs, trimEndMs };
}

async function main() {
  const { input, output, srtPath, trimStartMs, trimEndMs } = parseArgs(process.argv.slice(2));

  const workDir = await mkdtemp(join(tmpdir(), "normalize-video-"));
  try {
    const srtFilename = "captions.srt";
    if (srtPath) {
      await copyFile(resolve(srtPath), join(workDir, srtFilename));
    } else {
      // subtitles filter needs a file to reference; libass fails to sniff
      // the format of a genuinely empty file ("Unable to open"), so use a
      // single no-op cue instead — burns no visible text but still exercises
      // the exact same filter chain as production.
      await writeFile(join(workDir, srtFilename), "1\n00:00:00,000 --> 00:00:00,010\n \n\n");
    }

    const outputFilename = "normalized.mp4";
    console.log(`[normalize-video] input=${input} trimStartMs=${trimStartMs ?? "none"} trimEndMs=${trimEndMs ?? "none"}`);

    const { url: inputUrl, close } = await serveLocalFile(input);
    try {
      await burnCaptions(inputUrl, workDir, srtFilename, outputFilename, {
        trimStartMs: trimStartMs ?? null,
        trimEndMs: trimEndMs ?? null,
      });
    } finally {
      await close();
    }

    const data = await readFile(join(workDir, outputFilename));
    await writeFile(output, data);
    console.log(`[normalize-video] wrote ${output}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
