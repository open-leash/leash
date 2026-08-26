import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const server = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "server.ts"),
  "utf8",
);

test("a new work domain creates an unfinished Business workspace", () => {
  const resolver = server.slice(
    server.indexOf("async function resolveManagedMobileOrganization"),
    server.indexOf("async function initialOrganizationLoginRole"),
  );
  assert.match(resolver, /audience === "organization" && domainSlug/);
  assert.match(resolver, /organizationNameFromDomain\(domain\)/);
  assert.match(resolver, /setup_completed, current_step/);
  assert.match(resolver, /false, 1, 'cloud'/);
  assert.match(resolver, /defaultUserRole: "admin"/);
});

test("Business auth can issue a restricted Desktop token during the original exchange", () => {
  assert.match(server, /issueDesktopEnrollmentToken: body\.desktopEnrollment === true/);
  assert.match(server, /const desktopEnrollmentToken = issueDesktopEnrollmentToken/);
  assert.match(server, /'desktop_enrollment'/);
  assert.match(server, /Date\.now\(\) \+ 10 \* 60 \* 1000/);
  assert.match(server, /\.\.\.\(desktopEnrollmentToken \? \{ desktopEnrollmentToken \} : \{\}\)/);
  assert.match(server, /"desktop_enrollment"/);
  assert.match(server, /ds\.provider = 'desktop_enrollment'/);
  assert.match(server, /set revoked_at = now\(\), last_seen_at = now\(\)/);
});

test("returning administrators keep their role while a provisional bootstrap can promote its first user", () => {
  assert.match(server, /when users\.organization_id is distinct from excluded\.organization_id then excluded\.role/);
  assert.match(server, /when users\.role in \('owner', 'admin', 'ciso', 'security_admin'\) then users\.role/);
  assert.match(server, /else excluded\.role/);
});

test("Business signup rejects consumer email providers before creating a company", () => {
  const classifier = server.slice(
    server.indexOf("function isPersonalEmailDomain"),
    server.indexOf("async function canUseCloudOwnerLogin"),
  );
  for (const domain of ["gmail.com", "outlook.com", "yahoo.com", "icloud.com", "proton.me", "gmx.com", "mail.com"]) {
    assert.match(classifier, new RegExp(`"${domain.replace(".", "\\.")}"`));
  }
  assert.match(server, /Use your company Google Workspace or Microsoft 365 account/);
});
