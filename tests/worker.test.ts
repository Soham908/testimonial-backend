import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    job: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

const { prisma } = await import("../src/db/prisma");
const { claimJob, reapStuckJobs, processJob, backoffDelayMs, handlers } = await import("../src/worker");

function baseJob(overrides: Partial<Parameters<typeof processJob>[0]> = {}) {
  return {
    id: "job-1",
    type: "transcribe_segment",
    payload: { segment_id: "seg-1" },
    status: "processing",
    attempts: 0,
    max_attempts: 3,
    run_after: new Date("2026-01-01T00:00:00Z"),
    lock_token: "11111111-1111-1111-1111-111111111111",
    last_error: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete handlers.transcribe_segment;
});

describe("backoffDelayMs", () => {
  it("doubles per attempt and caps at the configured ceiling", () => {
    expect(backoffDelayMs(1)).toBe(30_000);
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(backoffDelayMs(3)).toBe(120_000);
    expect(backoffDelayMs(10)).toBe(10 * 60 * 1000); // capped, not 30_000 * 2^9
  });
});

describe("claimJob", () => {
  it("returns null when no row is claimable", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    await expect(claimJob()).resolves.toBeNull();
  });

  it("stamps the claim with a fresh lock token", async () => {
    const row = baseJob();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([row]);

    const result = await claimJob();
    expect(result).toEqual(row);

    // Tagged-template calls land as (stringsArray, ...interpolatedValues) -
    // the lock token is the first interpolated value in claimJob's SQL.
    const args = vi.mocked(prisma.$queryRaw).mock.calls[0];
    const lockToken = args[1] as string;
    expect(lockToken).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("processJob - success", () => {
  it("marks the job done when the handler succeeds and the lock is still held", async () => {
    handlers.transcribe_segment = vi.fn(async () => {});
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 1 });

    const job = baseJob();
    await processJob(job);

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: { id: job.id, lock_token: job.lock_token },
      data: { status: "done" },
    });
  });

  it("does not throw when the lock was reclaimed out from under a slow-but-not-dead worker", async () => {
    handlers.transcribe_segment = vi.fn(async () => {});
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 0 });

    await expect(processJob(baseJob())).resolves.toBeUndefined();
  });
});

describe("processJob - failure", () => {
  it("requeues with backoff and increments attempts when under the ceiling", async () => {
    handlers.transcribe_segment = vi.fn(async () => {
      throw new Error("transient failure");
    });
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 1 });

    const job = baseJob({ attempts: 0, max_attempts: 3 });
    await processJob(job);

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: { id: job.id, lock_token: job.lock_token },
      data: expect.objectContaining({
        attempts: 1,
        status: "pending",
        last_error: expect.stringContaining("transient failure"),
        run_after: expect.any(Date),
        lock_token: null,
      }),
    });
    const call = vi.mocked(prisma.job.updateMany).mock.calls[0][0];
    expect(call.data.run_after.getTime()).toBeGreaterThan(Date.now());
  });

  it("moves to terminal failed once attempts reaches max_attempts, without touching run_after", async () => {
    handlers.transcribe_segment = vi.fn(async () => {
      throw new Error("still broken");
    });
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 1 });

    const job = baseJob({ attempts: 2, max_attempts: 3 }); // this failure is the 3rd
    await processJob(job);

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: { id: job.id, lock_token: job.lock_token },
      data: {
        attempts: 3,
        status: "failed",
        run_after: job.run_after,
        last_error: expect.stringContaining("still broken"),
        lock_token: null,
      },
    });
  });

  it("does not throw when the lock was reclaimed before the failure could be recorded", async () => {
    handlers.transcribe_segment = vi.fn(async () => {
      throw new Error("boom");
    });
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 0 });

    await expect(processJob(baseJob())).resolves.toBeUndefined();
  });
});

describe("reapStuckJobs", () => {
  it("does nothing when no job is stuck", async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValue(null);
    await reapStuckJobs();
    expect(prisma.job.updateMany).not.toHaveBeenCalled();
  });

  it("reclaims a stale job back to pending with backoff when under the ceiling", async () => {
    const stale = baseJob({ attempts: 1, max_attempts: 5 });
    vi.mocked(prisma.job.findFirst).mockResolvedValue(stale);
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 1 });

    await reapStuckJobs();

    const call = vi.mocked(prisma.job.updateMany).mock.calls[0][0];
    expect(call.where).toEqual({ id: stale.id, status: "processing", updated_at: stale.updated_at });
    expect(call.data.attempts).toBe(2);
    expect(call.data.status).toBe("pending");
    expect(call.data.lock_token).toBeNull();
    expect(call.data.run_after.getTime()).toBeGreaterThan(Date.now());
  });

  it("moves a stale job straight to terminal failed once it's exhausted its attempts", async () => {
    const stale = baseJob({ attempts: 4, max_attempts: 5 });
    vi.mocked(prisma.job.findFirst).mockResolvedValue(stale);
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 1 });

    await reapStuckJobs();

    const call = vi.mocked(prisma.job.updateMany).mock.calls[0][0];
    expect(call.data.attempts).toBe(5);
    expect(call.data.status).toBe("failed");
    expect(call.data.run_after).toBe(stale.run_after);
  });

  it("no-ops (doesn't throw) when another reaper already reclaimed the same row first", async () => {
    const stale = baseJob();
    vi.mocked(prisma.job.findFirst).mockResolvedValue(stale);
    vi.mocked(prisma.job.updateMany).mockResolvedValue({ count: 0 });

    await expect(reapStuckJobs()).resolves.toBeUndefined();
  });
});
