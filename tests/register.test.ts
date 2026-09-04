import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const ZEIST_CLIENT_ID = "zeist-client-id";
const VALID_BODY = { name: "Test Person", phone: "9876543210", password: "secret123" };

const findUniqueMock = vi.fn(async () => ({ id: ZEIST_CLIENT_ID, name: "Zeist" }));
const createMock = vi.fn(
  async ({
    data,
  }: {
    data: { client_id: string; name: string; phone: string; password_hash: string };
  }) => ({
    id: "new-distributor-id",
    client_id: data.client_id,
    name: data.name,
    phone: data.phone,
    password_hash: data.password_hash,
  }),
);

class FakePrismaKnownRequestError extends Error {
  code: string;
  constructor(code: string) {
    super("mock prisma error");
    this.code = code;
  }
}

vi.mock("../src/db/prisma", () => ({
  prisma: {
    client: { findUnique: findUniqueMock },
    distributor: { create: createMock },
  },
}));

vi.mock("@prisma/client", () => ({
  Prisma: { PrismaClientKnownRequestError: FakePrismaKnownRequestError },
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
    const res = await request(appWith(registerRouter)).post("/register").send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates a distributor under the hardcoded internal-test client, normalizes phone, hashes the password, and ignores a client_id in the body", async () => {
    const registerRouter = await loadRegisterRouter(true);
    const res = await request(appWith(registerRouter))
      .post("/register")
      .send({
        name: "  Test Person  ",
        phone: "+91 98765-43210",
        password: "secret123",
        client_id: "attacker-supplied-client-id",
      });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(1);
    const createArgs = createMock.mock.calls[0][0];
    expect(createArgs.data.client_id).toBe(ZEIST_CLIENT_ID);
    expect(createArgs.data.name).toBe("Test Person");
    expect(createArgs.data.phone).toBe("9876543210");
    expect(createArgs.data.password_hash).not.toBe("secret123");
    expect(bcrypt.compareSync("secret123", createArgs.data.password_hash)).toBe(true);

    const decoded = jwt.verify(res.body.token, process.env.SESSION_SECRET as string) as {
      distributor_id: string;
      client_id: string;
    };
    expect(decoded.client_id).toBe(ZEIST_CLIENT_ID);
    expect(decoded.distributor_id).toBe("new-distributor-id");
  });

  it("rejects a missing or blank name with 400, without creating anything", async () => {
    const registerRouter = await loadRegisterRouter(true);

    const res1 = await request(appWith(registerRouter)).post("/register").send({
      phone: VALID_BODY.phone,
      password: VALID_BODY.password,
    });
    expect(res1.status).toBe(400);

    const res2 = await request(appWith(registerRouter))
      .post("/register")
      .send({ ...VALID_BODY, name: "   " });
    expect(res2.status).toBe(400);

    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid phone with 400, without creating anything", async () => {
    const registerRouter = await loadRegisterRouter(true);

    const res1 = await request(appWith(registerRouter)).post("/register").send({
      name: VALID_BODY.name,
      password: VALID_BODY.password,
    });
    expect(res1.status).toBe(400);

    const res2 = await request(appWith(registerRouter))
      .post("/register")
      .send({ ...VALID_BODY, phone: "12345" });
    expect(res2.status).toBe(400);

    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects a missing or too-short password with 400, without creating anything", async () => {
    const registerRouter = await loadRegisterRouter(true);

    const res1 = await request(appWith(registerRouter)).post("/register").send({
      name: VALID_BODY.name,
      phone: VALID_BODY.phone,
    });
    expect(res1.status).toBe(400);

    const res2 = await request(appWith(registerRouter))
      .post("/register")
      .send({ ...VALID_BODY, password: "abc" });
    expect(res2.status).toBe(400);

    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 409 with a generic message when the phone is already registered", async () => {
    createMock.mockImplementationOnce(async () => {
      throw new FakePrismaKnownRequestError("P2002");
    });
    const registerRouter = await loadRegisterRouter(true);
    const res = await request(appWith(registerRouter)).post("/register").send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("phone_already_registered");
  });
});
