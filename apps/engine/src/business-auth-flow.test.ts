import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const server = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "server.ts"),
  "utf8",
);

test("a new full work domain creates an unfinished Business workspace", () => {
  const resolver = server.slice(
    server.indexOf("async function resolveManagedMobileOrganization"),
    server.indexOf("async function initialOrganizationLoginRole"),
  );
  assert.match(resolver, /resolveOrganizationForWorkDomain\(domain\)/);
  assert.match(resolver, /organization_domains/);
  assert.match(resolver, /normalized_domain = \$1/);
  assert.doesNotMatch(resolver, /split_part\(lower\(u\.email\), '@', 2\) = \$1/);
  assert.match(resolver, /slugifyTenant\(domain\)/);
  assert.match(resolver, /organizationNameFromDomain\(domain\)/);
  assert.match(resolver, /setup_completed, current_step/);
  assert.match(resolver, /false, 1, 'cloud'/);
  assert.match(resolver, /initialOrganizationLoginRole\(organization\.id\)/);
  assert.match(resolver, /'domainJoinPolicy', 'invite_only'/);
  assert.match(resolver, /pg_advisory_xact_lock/);
  assert.doesNotMatch(resolver, /domain\.split\("\."\)\[0\]/);
  assert.match(resolver, /always creates a distinct company workspace/);
});

test("Personal workspaces are isolated and conversion creates a clean Business identity", () => {
  const personal = server.slice(
    server.indexOf("async function resolvePersonalCloudOrganization"),
    server.indexOf("async function resolveOrganizationForWorkDomain"),
  );
  assert.match(personal, /openleash-personal-workspace:/);
  assert.match(personal, /personal-\$\{suffix\}/);
  assert.match(personal, /'accountAudience', 'individual'/);
  assert.match(personal, /isolatedPersonalWorkspaceAt/);
  const conversion = server.slice(
    server.indexOf("async function retirePersonalAccountForBusiness"),
    server.indexOf("async function authorizeBusinessProvisioning"),
  );
  assert.match(conversion, /provider_subscription_id/);
  assert.match(conversion, /lower\(status\) in \('cancelled','canceled'\)/);
  assert.match(conversion, /coalesce\(ends_at,current_period_end\) > now\(\)/);
  assert.match(conversion, /set status='cancelled'/);
  assert.match(conversion, /never bills both accounts/);
  assert.match(conversion, /set revoked_at = coalesce\(revoked_at, now\(\)\)/);
  assert.match(conversion, /convertedToBusinessOrganizationId/);
  assert.match(conversion, /token_hash = null/);
  assert.match(conversion, /status = 'disabled'/);
  assert.doesNotMatch(conversion, /split_part\(lower\(u\.email\)/);
});

test("company-domain login elects one initial admin and then requires an exact invitation", () => {
  const provisioning = server.slice(
    server.indexOf("async function createDashboardSessionFromProfile"),
    server.indexOf("async function mobilePendingApprovals"),
  );
  assert.match(provisioning, /authorizeBusinessProvisioning/);
  assert.match(provisioning, /openleash-business-membership/);
  assert.match(provisioning, /bootstrapAdminClaimed/);
  assert.match(provisioning, /Number\(bootstrap\.rows\[0\]\?\.member_count/);
  assert.match(provisioning, /normalized_email = lower\(\$2\)/);
  assert.match(provisioning, /consumed_at is null/);
  assert.match(provisioning, /expires_at > now\(\)/);
  assert.match(provisioning, /Ask its administrator to invite your exact work email/);
  assert.match(provisioning, /set consumed_at = coalesce\(consumed_at, now\(\)\)/);
});

test("company-domain storage is canonical, unique, and honest about verification", () => {
  const migration = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../infra/postgres/migrations/0046_canonical_organization_domains.sql",
    ),
    "utf8",
  );
  assert.match(migration, /normalized_domain text primary key/);
  assert.match(migration, /organization_id uuid not null references organizations/);
  assert.match(migration, /status text not null default 'observed'/);
  assert.match(migration, /oauth_email_domain/);
});

test("OAuth provisioning never moves an existing email between workspaces", () => {
  const provisioning = server.slice(
    server.indexOf("async function createDashboardSessionFromProfile"),
    server.indexOf("async function issueDesktopEnrollmentToken"),
  );
  assert.match(
    provisioning,
    /where users\.organization_id = excluded\.organization_id/,
  );
  assert.doesNotMatch(
    provisioning,
    /on conflict \(email\) do update set\s+organization_id = excluded\.organization_id/,
  );
  assert.match(provisioning, /already belongs to another Leash workspace/);
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

test("returning workspace administrators keep their role", () => {
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

test("custom-scheme OAuth callbacks are exact and bound to a one-time PKCE verifier", () => {
  const authStart = server.slice(
    server.indexOf('app.post("/v1/mobile/auth/start"'),
    server.indexOf('app.get("/v1/mobile/dev-auth/callback"'),
  );
  const authExchange = server.slice(
    server.indexOf('app.post("/v1/mobile/auth/exchange"'),
    server.indexOf('app.post("/v1/mobile/auth/handoff"'),
  );
  const redirectGuard = server.slice(
    server.indexOf("function isAllowedAuthRedirectUri"),
    server.indexOf("function defaultMobileProviders"),
  );
  assert.match(authStart, /codeChallengeMethod !== "S256"/);
  assert.match(authStart, /validPkceValue\(codeChallenge\)/);
  assert.match(authStart, /codeChallenge: codeChallenge \|\| undefined/);
  assert.match(authExchange, /codeVerifier: codeVerifier \|\| undefined/);
  assert.match(server, /code_challenge is not distinct from \$7::text/);
  assert.match(redirectGuard, /url\.hostname === "auth"/);
  assert.match(redirectGuard, /url\.pathname === "\/callback"/);
  assert.doesNotMatch(redirectGuard, /url\.protocol === "openleash:"\) return true/);

  const migration = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../infra/postgres/migrations/0049_oauth_pkce.sql",
    ),
    "utf8",
  );
  assert.match(migration, /add column if not exists code_challenge text/);
});
