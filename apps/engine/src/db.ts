import crypto from "node:crypto";
import { Pool } from "pg";

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://openleash:openleash@localhost:9543/openleash"
});

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function getUserByToken(token: string) {
  const tokenHash = hashToken(token);
  const desktop = await pool.query(
    `update desktop_credentials dc
     set last_seen_at = now()
     from users u
     where dc.user_id = u.id
       and dc.organization_id = u.organization_id
       and dc.token_hash = $1
       and dc.revoked_at is null
       and u.status = 'active'
     returning u.id, u.email, u.display_name, u.organization_id,
               dc.computer_id as desktop_computer_id`,
    [tokenHash],
  );
  if (desktop.rows[0]) {
    return desktop.rows[0] as {
      id: string;
      email: string;
      display_name: string;
      organization_id?: string | null;
      desktop_computer_id?: string | null;
    };
  }
  const result = await pool.query(
    "select id, email, display_name, organization_id from users where token_hash = $1 and status = 'active' limit 1",
    [tokenHash]
  );
  if (result.rows[0]) {
    return result.rows[0] as {
      id: string;
      email: string;
      display_name: string;
      organization_id?: string | null;
      desktop_computer_id?: string | null;
    };
  }

  const session = await pool.query(
    `update dashboard_sessions ds
     set last_seen_at = now()
     from users u
     where ds.user_id = u.id
       and ds.organization_id = u.organization_id
       and u.status = 'active'
       and ds.token_hash = $1
       and ds.provider <> 'desktop_enrollment'
       and ds.revoked_at is null
       and ds.expires_at > now()
     returning u.id, u.email, u.display_name, u.organization_id`,
    [hashToken(token)]
  );
  return session.rows[0] as
    | {
        id: string;
        email: string;
        display_name: string;
        organization_id?: string | null;
        desktop_computer_id?: string | null;
      }
    | undefined;
}

export async function ensureDevToken() {
  const token = process.env.OPENLEASH_DEV_TOKEN;
  if (!token) return;
  if (process.env.NODE_ENV === "production" && process.env.OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED !== "1") {
    throw new Error("OPENLEASH_DEV_TOKEN is set in production. Remove it or set OPENLEASH_ALLOW_PROD_DEV_TOKEN_SEED=1 explicitly.");
  }
  const organizationSlug = String(process.env.OPENLEASH_DEV_ORG_SLUG ?? "").trim();
  const organizationName = String(process.env.OPENLEASH_DEV_ORG_NAME ?? "Individual Open Source").trim();
  const deploymentMode = String(process.env.OPENLEASH_DEPLOYMENT_MODE ?? "private").trim();
  const organization = organizationSlug
    ? await pool.query<{ id: string }>(
        `insert into organizations (name, slug, setup_completed, current_step, deployment_mode)
         values ($1, $2, true, 6, $3)
         on conflict (slug) do update set
           name = excluded.name,
           setup_completed = true,
           current_step = greatest(organizations.current_step, excluded.current_step),
           deployment_mode = excluded.deployment_mode,
           updated_at = now()
         returning id`,
        [organizationName, organizationSlug, deploymentMode === "cloud" ? "cloud" : "private"]
      )
    : undefined;
  const organizationId = organization?.rows[0]?.id ?? null;
  const developerEmail = String(process.env.OPENLEASH_DEV_EMAIL ?? "dev-user@openleash.local").trim().toLowerCase();
  const developerName = String(process.env.OPENLEASH_DEV_NAME ?? "Local developer").trim();
  const user = await pool.query<{ id: string }>(
    `insert into users (email, display_name, role, token_hash, organization_id)
     values ($1, $2, 'owner', $3, $4)
     on conflict (email) do update set
       display_name = excluded.display_name,
       role = excluded.role,
       token_hash = excluded.token_hash,
       organization_id = coalesce(excluded.organization_id, users.organization_id)
     returning id`,
    [developerEmail, developerName, hashToken(token), organizationId]
  );
  const developerUserId = user.rows[0].id;
  const legacy = await pool.query<{ id: string }>("select id from users where email = 'dev@openleash.local' limit 1");
  const legacyUserId = legacy.rows[0]?.id;
  if (legacyUserId && legacyUserId !== developerUserId) {
    await pool.query("update conversation_events set user_id = $1 where user_id = $2", [developerUserId, legacyUserId]);
    await pool.query("update evaluations set user_id = $1 where user_id = $2", [developerUserId, legacyUserId]);
    await pool.query(
      `update computers c
       set user_id = $1
       where c.user_id = $2
         and not exists (
           select 1 from computers existing
           where existing.user_id = $1 and existing.hostname = c.hostname
         )`,
      [developerUserId, legacyUserId]
    );
    await pool.query("update computers set user_id = null where user_id = $1", [legacyUserId]);
    await pool.query("delete from users where id = $1", [legacyUserId]);
  }
}
