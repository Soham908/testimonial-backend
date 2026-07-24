import { config } from "../config/env";

export type NexrenderAsset =
  | { type: "text"; layerName: string; value: string }
  | { type: "video" | "audio" | "image"; layerName: string; src: string };

export type NexrenderJobPayload = {
  template: { id: string; composition: string };
  assets: NexrenderAsset[];
  upload?: {
    provider: string;
    prefix: string;
    outputUrl: string;
    params: Record<string, string>;
  };
};

export type NexrenderJob = {
  id: string;
  status: string;
  outputUrl: string | null;
  stats?: { error?: string | null };
};

const TERMINAL_STATUSES = new Set(["finished", "error", "manually_cancelled"]);
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

function headers() {
  return {
    Authorization: `Bearer ${config.NEXRENDER_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function createJob(payload: NexrenderJobPayload): Promise<NexrenderJob> {
  const res = await fetch(`${config.NEXRENDER_SERVER_URL}/v2/jobs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`nexrender job creation failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as NexrenderJob;
}

export async function getJob(id: string): Promise<NexrenderJob> {
  const res = await fetch(`${config.NEXRENDER_SERVER_URL}/v2/jobs/${id}`, {
    headers: headers(),
  });
  if (!res.ok) {
    throw new Error(`nexrender get job failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as NexrenderJob;
}

export async function pollJobUntilDone(id: string): Promise<NexrenderJob> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await getJob(id);
    if (TERMINAL_STATUSES.has(job.status)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`nexrender job ${id} did not finish within ${POLL_TIMEOUT_MS}ms`);
}
