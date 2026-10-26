/**
 * Opt-in Stage 4 stress runner.
 *
 * This program never calls the remote API unless --execute is supplied.
 * It only submits uploads; it intentionally does not wait for the async
 * normalization, transcription, sentiment, or render jobs to complete.
 *
 * Example dry run (local validation only):
 *   npx tsx tools/stress-test/run-upload-stress-test.ts
 *
 * One-distributor smoke test (all five videos), when the deployed registration route is enabled:
 *   npx tsx tools/stress-test/run-upload-stress-test.ts --execute --smoke
 *
 * Full run (defaults to five distributors in parallel):
 *   npx tsx tools/stress-test/run-upload-stress-test.ts --execute --concurrency 5
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

type Script = { distributor_name: string; question_index: number; script_text: string };
type VideoManifestEntry = {
  distributor_name: string;
  question_index: number;
  video_filename: string;
  output_duration_seconds: number;
  bytes: number;
};
type ApiResponse = { response: Response; body: unknown; text: string; elapsed_ms: number };
type QuestionResult = {
  question_index: number;
  video_file: string;
  local_bytes: number;
  duration_seconds: number;
  upload_url_ms?: number;
  put_ms?: number;
  confirm_ms?: number;
  total_ms: number;
  status: "submitted" | "failed" | "skipped";
  video_key?: string;
  error?: string;
};
type DistributorResult = {
  distributor_name: string;
  distributor_id: string | null;
  register_ms?: number;
  profile_ms?: number;
  questions_catalog_ms?: number;
  total_ms: number;
  status: "submitted" | "failed";
  error?: string;
  questions: QuestionResult[];
};

const ROOT = __dirname;
const RESULTS_DIR = path.join(ROOT, "stress-results");
const DEFAULT_BASE_URL = "https://insight-backend.thezeist.com";

function argValue(name: string): string | undefined {
  const position = process.argv.indexOf(name);
  return position >= 0 ? process.argv[position + 1] : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function generatedRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function endpoint(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

function errorText(response: Response, body: unknown, text: string): string {
  const detail = typeof body === "object" && body !== null ? JSON.stringify(body) : text;
  return `HTTP ${response.status} ${response.statusText}: ${detail.slice(0, 2_000)}`;
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<ApiResponse> {
  const started = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text.length ? JSON.parse(text) : null;
  } catch {
    // Keep non-JSON response text for the error log.
  }
  return { response, body, text, elapsed_ms: Math.round(performance.now() - started) };
}

function requireObject(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} was not an object`);
  }
  return value as Record<string, unknown>;
}

function phoneFor(runId: string, distributorIndex: number): string {
  const hash = createHash("sha256").update(`${runId}:phone:${distributorIndex}`).digest("hex");
  return `9${(parseInt(hash.slice(0, 8), 16) % 1_000_000_000).toString().padStart(9, "0")}`;
}

function passwordFor(_runId: string, _distributorIndex: number): string {
  // These are synthetic internal-test accounts, not production credentials.
  return "password";
}

async function loadInputs(scriptsPath: string, manifestPath: string, videoDir: string): Promise<{ scriptsByDistributor: Map<string, Script[]>; videos: Map<string, VideoManifestEntry> }> {
  const [scriptsRaw, manifestRaw] = await Promise.all([readFile(scriptsPath, "utf8"), readFile(manifestPath, "utf8")]);
  const scripts = JSON.parse(scriptsRaw) as Script[];
  const manifest = JSON.parse(manifestRaw) as VideoManifestEntry[];
  const scriptsByDistributor = new Map<string, Script[]>();
  const videos = new Map<string, VideoManifestEntry>();

  for (const script of scripts) {
    const entries = scriptsByDistributor.get(script.distributor_name) ?? [];
    entries.push(script);
    scriptsByDistributor.set(script.distributor_name, entries);
  }
  for (const entry of manifest) {
    videos.set(`${entry.distributor_name}\u0000${entry.question_index}`, entry);
  }

  if (scripts.length === 0 || manifest.length !== scripts.length) {
    throw new Error(`Expected one video manifest entry per script; found ${scripts.length} scripts / ${manifest.length} videos.`);
  }
  for (const [name, entries] of scriptsByDistributor) {
    if (entries.length !== 5 || new Set(entries.map(({ question_index }) => question_index)).size !== 5) {
      throw new Error(`${name} does not have exactly five distinct questions.`);
    }
    for (const script of entries) {
      const video = videos.get(`${name}\u0000${script.question_index}`);
      if (!video) throw new Error(`Video manifest is missing ${name}, question ${script.question_index}.`);
      const filePath = path.join(videoDir, video.video_filename);
      const fileInfo = await stat(filePath);
      if (fileInfo.size !== video.bytes || fileInfo.size === 0) {
        throw new Error(`Unexpected file size for ${video.video_filename}; expected ${video.bytes}, found ${fileInfo.size}.`);
      }
    }
  }
  return { scriptsByDistributor, videos };
}

async function putVideo(uploadUrl: string, filePath: string): Promise<number> {
  const bytes = await readFile(filePath);
  const started = performance.now();
  const response = await fetch(uploadUrl, { method: "PUT", body: bytes, signal: AbortSignal.timeout(120_000) });
  const elapsed = Math.round(performance.now() - started);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorText(response, text, text));
  }
  return elapsed;
}

async function runQuestion(
  baseUrl: string,
  token: string,
  script: Script,
  video: VideoManifestEntry,
  videoDir: string,
): Promise<QuestionResult> {
  const started = performance.now();
  const base: Omit<QuestionResult, "total_ms" | "status"> = {
    question_index: script.question_index,
    video_file: path.relative(ROOT, path.join(videoDir, video.video_filename)),
    local_bytes: video.bytes,
    duration_seconds: video.output_duration_seconds,
  };
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const uploadRequest = await requestJson(
      endpoint(baseUrl, "/segments/upload-url"),
      { method: "POST", headers: authHeaders, body: JSON.stringify({ question_index: script.question_index }) },
      30_000,
    );
    if (!uploadRequest.response.ok) throw new Error(errorText(uploadRequest.response, uploadRequest.body, uploadRequest.text));
    const uploadBody = requireObject(uploadRequest.body, "upload-url response");
    if (typeof uploadBody.upload_url !== "string" || typeof uploadBody.video_key !== "string") {
      throw new Error("upload-url response did not contain string upload_url and video_key fields.");
    }
    const putMs = await putVideo(uploadBody.upload_url, path.join(videoDir, video.video_filename));
    const confirmRequest = await requestJson(
      endpoint(baseUrl, "/segments/confirm"),
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          question_index: script.question_index,
          video_key: uploadBody.video_key,
          duration: video.output_duration_seconds,
          trim_start_ms: null,
          trim_end_ms: null,
        }),
      },
      30_000,
    );
    if (!confirmRequest.response.ok) throw new Error(errorText(confirmRequest.response, confirmRequest.body, confirmRequest.text));
    return {
      ...base,
      upload_url_ms: uploadRequest.elapsed_ms,
      put_ms: putMs,
      confirm_ms: confirmRequest.elapsed_ms,
      total_ms: Math.round(performance.now() - started),
      status: "submitted",
      video_key: uploadBody.video_key,
    };
  } catch (cause) {
    return {
      ...base,
      total_ms: Math.round(performance.now() - started),
      status: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

async function runDistributor(
  baseUrl: string,
  runId: string,
  distributorIndex: number,
  distributorName: string,
  scripts: Script[],
  videos: Map<string, VideoManifestEntry>,
  videoDir: string,
): Promise<DistributorResult> {
  const started = performance.now();
  const result: DistributorResult = { distributor_name: distributorName, distributor_id: null, total_ms: 0, status: "failed", questions: [] };
  try {
    const registration = await requestJson(
      endpoint(baseUrl, "/register"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: distributorName, phone: phoneFor(runId, distributorIndex), password: passwordFor(runId, distributorIndex) }),
      },
      30_000,
    );
    result.register_ms = registration.elapsed_ms;
    if (!registration.response.ok) throw new Error(errorText(registration.response, registration.body, registration.text));
    const registrationBody = requireObject(registration.body, "register response");
    if (typeof registrationBody.token !== "string") throw new Error("register response did not contain a token.");
    const token = registrationBody.token;

    const profile = await requestJson(
      endpoint(baseUrl, "/distributors/me"),
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      30_000,
    );
    result.profile_ms = profile.elapsed_ms;
    if (!profile.response.ok) throw new Error(errorText(profile.response, profile.body, profile.text));
    const profileBody = requireObject(profile.body, "profile response");
    const distributor = requireObject(profileBody.distributor, "profile response.distributor");
    if (typeof distributor.id !== "string") throw new Error("profile response did not contain distributor.id.");
    result.distributor_id = distributor.id;

    // The contract explicitly says not to assume 1..N: confirm that this
    // distributor's client currently exposes every question we will submit.
    const catalog = await requestJson(
      endpoint(baseUrl, "/distributors/me/questions"),
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      30_000,
    );
    result.questions_catalog_ms = catalog.elapsed_ms;
    if (!catalog.response.ok) throw new Error(errorText(catalog.response, catalog.body, catalog.text));
    const catalogBody = requireObject(catalog.body, "questions response");
    if (!Array.isArray(catalogBody.questions)) throw new Error("questions response did not contain a questions array.");
    const availableIndexes = new Set(
      catalogBody.questions
        .filter((question): question is Record<string, unknown> => typeof question === "object" && question !== null)
        .map((question) => question.index)
        .filter((index): index is number => typeof index === "number" && Number.isInteger(index)),
    );
    const missingIndexes = scripts.map(({ question_index }) => question_index).filter((index) => !availableIndexes.has(index));
    if (missingIndexes.length) throw new Error(`Current client does not expose required question indexes: ${missingIndexes.join(", ")}.`);

    for (const script of scripts.sort((a, b) => a.question_index - b.question_index)) {
      const video = videos.get(`${distributorName}\u0000${script.question_index}`);
      if (!video) throw new Error(`No local video entry for question ${script.question_index}.`);
      const question = await runQuestion(baseUrl, token, script, video, videoDir);
      result.questions.push(question);
      const tag = `${slug(distributorName)} q${script.question_index}`;
      console.log(`[${question.status.toUpperCase()}] ${tag} ${question.total_ms}ms${question.error ? ` — ${question.error}` : ""}`);
    }
    result.status = result.questions.every(({ status }) => status === "submitted") ? "submitted" : "failed";
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : String(cause);
    console.error(`[DISTRIBUTOR FAILED] ${distributorName} — ${result.error}`);
  }
  result.total_ms = Math.round(performance.now() - started);
  return result;
}

async function main(): Promise<void> {
  const execute = hasArg("--execute");
  const smoke = hasArg("--smoke");
  const baseUrl = argValue("--base-url") ?? process.env.STRESS_BASE_URL ?? DEFAULT_BASE_URL;
  const runId = argValue("--run-id") ?? generatedRunId();
  const concurrency = Number(argValue("--concurrency") ?? "5");
  const scriptsPath = path.resolve(argValue("--scripts") ?? path.join(ROOT, "hinglish-distributor-scripts.json"));
  const manifestPath = path.resolve(argValue("--manifest") ?? path.join(ROOT, "video-manifest.json"));
  const videoDir = path.resolve(argValue("--video-dir") ?? path.join(ROOT, "videos"));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error("--concurrency must be an integer from 1 to 20.");

  const { scriptsByDistributor, videos } = await loadInputs(scriptsPath, manifestPath, videoDir);
  const distributors = [...scriptsByDistributor.entries()].sort(([left], [right]) => left.localeCompare(right));
  const selected = smoke ? distributors.slice(0, 1) : distributors;
  const totalBytes = [...videos.values()].reduce((total, video) => total + video.bytes, 0);
  console.log(`Validated ${videos.size} local videos (${(totalBytes / 1_000_000_000).toFixed(2)} GB).`);
  const plannedVideos = selected.reduce((total, [, scripts]) => total + scripts.length, 0);
  console.log(`Plan: ${selected.length} distributors, ${plannedVideos} videos, concurrency ${Math.min(concurrency, selected.length)}.`);
  console.log(`Target: ${baseUrl}`);
  if (!execute) {
    console.log("Dry run only: no network request was made. Add --execute only when ready for remote writes.");
    return;
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  const resultsPath = path.join(RESULTS_DIR, `stress-run-${runId}.json`);
  const results: DistributorResult[] = [];
  const started = performance.now();
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= selected.length) return;
      const [name, scripts] = selected[index];
      const distributor = await runDistributor(baseUrl, runId, index + 1, name, scripts, videos, videoDir);
      results.push(distributor);
      await writeFile(resultsPath, `${JSON.stringify({ run_id: runId, base_url: baseUrl, in_progress: true, distributors: results }, null, 2)}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
  const wallClockMs = Math.round(performance.now() - started);
  results.sort((left, right) => left.distributor_name.localeCompare(right.distributor_name));
  const questions = results.flatMap(({ questions: entries }) => entries);
  const report = {
    run_id: runId,
    base_url: baseUrl,
    started_at: new Date(Date.now() - wallClockMs).toISOString(),
    completed_at: new Date().toISOString(),
    concurrency: Math.min(concurrency, selected.length),
    wall_clock_ms: wallClockMs,
    processing_waited_for: false,
    summary: {
      distributors_submitted: results.filter(({ status }) => status === "submitted").length,
      distributors_failed: results.filter(({ status }) => status === "failed").length,
      videos_submitted: questions.filter(({ status }) => status === "submitted").length,
      videos_failed: questions.filter(({ status }) => status === "failed").length,
    },
    distributor_ids: results.map(({ distributor_name, distributor_id, status }) => ({ distributor_name, distributor_id, status })),
    distributors: results,
  };
  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nSubmission complete in ${(wallClockMs / 1_000).toFixed(2)}s. Results: ${resultsPath}`);
  console.log(JSON.stringify(report.summary));
  console.log("Distributor IDs:");
  for (const item of report.distributor_ids) console.log(`- ${item.distributor_name}: ${item.distributor_id ?? "NOT CREATED"} (${item.status})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
