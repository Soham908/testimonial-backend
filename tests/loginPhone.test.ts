import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const REGISTERED_PHONE = "9876543210";
const PASSWORD = "secret123";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 10);

const findUniqueMock = vi.fn(async ({ where }: { where: { phone: string } }) => {
  if (where.phone === REGISTERED_PHONE) {
    return {
      id: "distributor-id",
      client_id: "zeist-client-id",
      password_hash: PASSWORD_HASH,
    };
  }
  return null;
});

vi.mock("../src/db/prisma", () => ({
  prisma: {
    distributor: { findUnique: findUniqueMock },
  },
}));

const ORIGINAL_FLAG = process.env.ENABLE_SELF_REGISTRATION;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_SELF_REGISTRATION;
  else process.env.ENABLE_SELF_REGISTRATION = ORIGINAL_FLAG;
});

async function loadLoginPhoneRouter(enabled: boolean) {
  vi.resetModules();
  process.env.ENABLE_SELF_REGISTRATION = enabled ? "true" : "false";
  const { loginPhoneRouter } = await import("../src/routes/loginPhone");
  return loginPhoneRouter;
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

describe("POST /login/phone (ENABLE_SELF_REGISTRATION)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is unreachable when the flag is off (default)", async () => {
    const router = await loadLoginPhoneRouter(false);
    const res = await request(appWith(router)).post("/login/phone").send({ phone: REGISTERED_PHONE, password: PASSWORD });

    expect(res.status).toBe(404);
  });

  it("logs in with a differently-formatted but matching phone number", async () => {
    const router = await loadLoginPhoneRouter(true);
    const res = await request(appWith(router))
      .post("/login/phone")
      .send({ phone: "+91 98765-43210", password: PASSWORD });

    expect(res.status).toBe(200);
    const decoded = jwt.verify(res.body.token, process.env.SESSION_SECRET as string) as {
      distributor_id: string;
      client_id: string;
    };
    expect(decoded.distributor_id).toBe("distributor-id");
    expect(decoded.client_id).toBe("zeist-client-id");
  });

  it("rejects an unknown phone with a generic 401, not a distinguishable error", async () => {
    const router = await loadLoginPhoneRouter(true);
    const res = await request(appWith(router)).post("/login/phone").send({ phone: "0000000000", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid phone or password");
  });

  it("rejects a wrong password with the same generic 401 message as an unknown phone", async () => {
    const router = await loadLoginPhoneRouter(true);
    const res = await request(appWith(router))
      .post("/login/phone")
      .send({ phone: REGISTERED_PHONE, password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid phone or password");
  });

  it("rejects a missing phone or password with 400", async () => {
    const router = await loadLoginPhoneRouter(true);
    const res = await request(appWith(router)).post("/login/phone").send({ phone: REGISTERED_PHONE });

    expect(res.status).toBe(400);
  });
});
