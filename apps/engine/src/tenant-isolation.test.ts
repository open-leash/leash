import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard sessions are bound to the user's current organization", async () => {
  const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const sessionQuery = source.slice(source.indexOf("async function getDashboardSession"), source.indexOf("async function getClientOrDashboardSession"));
  assert.match(sessionQuery, /ds\.organization_id = u\.organization_id/);
  assert.match(sessionQuery, /u\.status = 'active'/);
});

test("client tokens reject disabled users and stale tenant sessions", async () => {
  const source = await readFile(new URL("./db.ts", import.meta.url), "utf8");
  assert.match(source, /token_hash = \$1 and status = 'active'/);
  assert.match(source, /ds\.organization_id = u\.organization_id/);
  assert.match(source, /u\.status = 'active'/);
  assert.match(source, /update desktop_credentials dc/);
  assert.match(source, /dc\.token_hash = \$1/);
  assert.match(source, /dc\.computer_id as desktop_computer_id/);
  assert.match(source, /ds\.provider <> 'desktop_enrollment'/);
});

test("every desktop enrollment path uses a stable installation and per-device credential", async () => {
  const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const tokenEnrollment = source.slice(source.indexOf('app.post("/v1/enroll"'), source.indexOf('app.post("/v1/session-monitoring"'));
  assert.match(tokenEnrollment, /A shared deployment token cannot create a Leash identity/);
  assert.doesNotMatch(tokenEnrollment, /insert into users/);
  const desktopEnrollment = source.slice(source.indexOf('app.post("/v1/desktop/enroll"'), source.indexOf('app.post("/v1/desktop/agents"'));
  const inventory = source.slice(source.indexOf('app.post("/v1/desktop/agents"'), source.indexOf('app.post("/v1/agents/:kind/monitoring"'));
  for (const route of [tokenEnrollment, desktopEnrollment, inventory]) {
    assert.match(route, /installIdentity\.length < 16/);
    assert.match(
      route,
      /on conflict \(user_id, install_identity\) where user_id is not null and install_identity is not null/,
    );
  }
  for (const route of [tokenEnrollment, desktopEnrollment]) {
    assert.match(route, /insert into desktop_credentials/);
  }
  assert.match(tokenEnrollment, /existingUser\.status !== "active"/);
  assert.match(tokenEnrollment, /!existingUser\.same_installation/);
  assert.match(tokenEnrollment, /enrollment_identity_requires_sign_in/);
  assert.doesNotMatch(tokenEnrollment, /hostname = \$2 and install_identity is null/);
  assert.doesNotMatch(desktopEnrollment, /hostname = \$2 and install_identity is null/);
  assert.doesNotMatch(inventory, /hostname = \$2 and install_identity is null/);
  assert.match(inventory, /session\.source === "client" && session\.computerId/);
  assert.match(desktopEnrollment, /with claimable as/);
  assert.match(desktopEnrollment, /and 1 = \(/);
  assert.match(inventory, /install_identity = coalesce\(install_identity, \$6\)/);
  assert.match(inventory, /install_identity = \$6 or install_identity is null/);
  assert.match(inventory, /install_identity = \$6/);
  assert.match(source, /if \(user\.desktop_computer_id\)/);
  assert.match(source, /A managed Cloud/);
  assert.match(source, /cannot bypass hosted device capacity/);
  const migration = await readFile(
    new URL("../infra/postgres/migrations/0047_device_credentials_and_membership_grants.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /drop constraint if exists computers_user_id_hostname_key/);
  assert.match(migration, /computers_user_install_identity_uidx/);
});

test("known enrollment capacity failures have safe HTTP status codes", async () => {
  const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const mapper = source.slice(source.indexOf("function statusCodeForError"), source.indexOf("function isEvaluationResponse"));
  assert.match(mapper, /Cloud trial protects one computer per person/);
  assert.match(mapper, /Personal Cloud protects up to two computers/);
  assert.match(mapper, /stable Leash installation identity/);
  assert.match(mapper, /Leash Cloud account is not active/);
});

test("only organization administrators receive organization-wide dashboard scope", async () => {
  const source = await readFile(new URL("./server.ts", import.meta.url), "utf8");
  const roleGuard = source.slice(source.indexOf("function isDashboardAccessRole"), source.indexOf("function isAllowedCorsOrigin"));
  for (const role of ["owner", "admin", "ciso", "cio", "security_admin"]) assert.match(roleGuard, new RegExp(`\"${role}\"`));
  for (const role of ["analyst", "responder", "viewer", "engineer"]) assert.doesNotMatch(roleGuard, new RegExp(`\"${role}\"`));
});
