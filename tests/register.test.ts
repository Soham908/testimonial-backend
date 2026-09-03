import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const ZEIST_CLIENT_ID = "zeist-client-id";

const findUniqueMock = vi.fn(async () => ({ id: ZEIST_CLIENT_ID, name: "Zeist" }));
const createMock = vi.fn(
  async ({ data }: { data: { client_id: string; name: string; phone: string | null } }) => ({
    id: "new-distributor-id",
    client_id: data.client_id,
    name: data.name,
    phone: data.phone,
  }),
);

vi.mock("../src/db/prisma", () => ({
  prisma: {
    client: { findUnique: findUniqueMock },
    distributor: { create: createMock },
  },
}));

const ORIGINAL_FLAG = process.env.ENABLE_SELF_REGISTRATION;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_SELF_REGISTRATION;
  else process.env.ENABLE_SELF_REGISTRATION = ORIGINAL_FLAG;
});

async function loadRegisterRouter(enabled: boolean) {
  vi.resetModules();
  process.env.ENABLE_SELF_REGISTRATION = enabled ? "true" : "false";
  const { registerRouter } = await import("../src/routes/register");
  return registerRouter;
}

function appWith(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return app;
}

describe("POST /register (ENABLE_SELF_REGISTRATION)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is unreachable when the flag is off (default)", async () => {
    const registerRouter = await loadRegisterRouter(false);
    const res = await request(appWith(registerRouter)).post("/register").send({ name: "Someone" });

    expect(res.status).toBe(404);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates a distributor under the hardcoded internal-test client and ignores a client_id in the body", async () => {
    const registerRouter = await loadRegisterRouter(true);
    const res = await request(appWith(registerRouter))
      .post("/register")
      .send({ name: "  Test Person  ", phone: "555-0000", client_id: "attacker-supplied-client-id" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
    const createArgs = createMock.mock.calls[0][0];
    expect(createArgs.data.client_id).toBe(ZEIST_CLIENT_ID);
    expect(createArgs.data.name).toBe("Test Person");
    expect(createArgs.data.phone).toBe("555-0000");

    const decoded = jwt.verify(res.body.token, process.env.SESSION_SECRET as string) as {
      distributor_id: string;
      client_id: string;
    };
    expect(decoded.client_id).toBe(ZEIST_CLIENT_ID);
    expect(decoded.distributor_id).toBe("new-distributor-id");
  });

  it("stores phone as null when omitted, not an empty string", async () => {
    const registerRouter = await loadRegisterRouter(true);
    const res = await request(appWith(registerRouter)).post("/register").send({ name: "No Phone" });

    expect(res.status).toBe(201);
    expect(createMock.mock.calls[0][0].data.phone).toBeNull();
  });

  it("rejects a missing or blank name with 400, without creating anything", async () => {
    const registerRouter = await loadRegisterRouter(true);

    const res1 = await request(appWith(registerRouter)).post("/register").send({});
    expect(res1.status).toBe(400);

    const res2 = await request(appWith(registerRouter)).post("/register").send({ name: "   " });
    expect(res2.status).toBe(400);

    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string phone with 400", async () => {
    const registerRouter = await loadRegisterRouter(true);
    const res = await request(appWith(registerRouter)).post("/register").send({ name: "Someone", phone: 12345 });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });
});
