import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { createApp } from "../src/app";

const schema = "anfas_auth_test_" + randomBytes(8).toString("hex");
process.env.DATABASE_SCHEMA = schema;
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c search_path=${schema}`,
});
let app: Awaited<ReturnType<typeof createApp>>;
let base: string;
let cookie = "";
const credentials = {
  email: "local-test@example.test",
  password: "Strong-test-password-123",
};

async function start() {
  app = await createApp();
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
}

async function call(
  route: string,
  body?: unknown,
  options: { origin?: string; cookie?: string; header?: boolean } = {},
) {
  return fetch(base + "/api/auth/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: options.origin ?? "http://127.0.0.1:5173",
      ...(options.header === false ? {} : { "X-Anfas-Client": "web" }),
      Cookie: options.cookie ?? cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

before(async () => {
  await db.query(`CREATE SCHEMA ${schema}`);
  await start();
});
after(async () => {
  await app?.close();
  await db.query(`DROP SCHEMA ${schema} CASCADE`);
  await db.end();
});

test("anonymous, validation and CSRF rejection", async () => {
  assert.equal((await call("me")).status, 401);
  assert.equal(
    (await call("register", { email: "bad", password: "short" })).status,
    400,
  );
  assert.equal(
    (await call("register", credentials, { origin: "https://foreign.example" }))
      .status,
    403,
  );
  assert.equal(
    (await call("register", credentials, { header: false })).status,
    403,
  );
});

test("registration normalizes email, returns only public user fields and a secure session cookie", async () => {
  const response = await call("register", {
    ...credentials,
    email: " LOCAL-TEST@EXAMPLE.TEST ",
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.user.email, credentials.email);
  assert.match(body.user.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(body.user).sort(), ["createdAt", "email", "id"]);
  const setCookie = response.headers.get("set-cookie")!;
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\/api/i);
  assert.equal(response.headers.get("cache-control"), "no-store");
  cookie = setCookie.split(";")[0];
  const row = (await db.query("SELECT password_hash FROM users")).rows[0];
  assert.notEqual(row.password_hash, credentials.password);
  const session = (await db.query("SELECT token_hash FROM sessions")).rows[0];
  assert.notEqual(session.token_hash, cookie.split("=")[1]);
  assert.equal((await call("me")).status, 200);
});

test("duplicate email and wrong password are rejected", async () => {
  assert.equal((await call("register", credentials)).status, 409);
  assert.equal(
    (await call("login", { ...credentials, password: "incorrect-password" }))
      .status,
    401,
  );
  assert.equal(
    (await call("login", { ...credentials, email: "unknown@example.test" }))
      .status,
    401,
  );
});

test("sessions and users survive restart; logout revokes the old token", async () => {
  await app.close();
  await start();
  assert.equal((await call("me")).status, 200);
  assert.equal((await call("logout", {})).status, 200);
  assert.equal((await call("me")).status, 401);
  const response = await call("login", credentials);
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await call("me")).status, 200);
});

test("expired and forged sessions are rejected", async () => {
  await db.query("UPDATE sessions SET expires_at = '2000-01-01'");
  assert.equal((await call("me")).status, 401);
  assert.equal(
    (await call("me", undefined, { cookie: "anfas_session=" + "a".repeat(64) }))
      .status,
    401,
  );
});

test("concurrent registration creates one user, and login has rate limiting", async () => {
  const responses = await Promise.all(
    [1, 2].map(() =>
      call("register", { ...credentials, email: "race@example.test" }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  let status = 0;
  for (let i = 0; i < 11; i++)
    status = (
      await call("login", { ...credentials, password: "incorrect-password" })
    ).status;
  assert.equal(status, 429);
});
