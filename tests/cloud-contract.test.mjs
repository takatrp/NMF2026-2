import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const cloud = fs.readFileSync(path.join(root, "cloud.js"), "utf8");
const config = fs.readFileSync(path.join(root, "supabase-config.js"), "utf8");
const schema = fs.readFileSync(path.join(root, "supabase", "schema.sql"), "utf8");

test("browser config contains only the expected public Supabase values", () => {
  assert.match(config, /https:\/\/gqlnxaolwdzkgoyrpdpt\.supabase\.co/);
  assert.match(config, /sb_publishable_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(config, /service_role|sb_secret_/i);
});

test("cloud actions use optimistic-locking RPC contracts", () => {
  for (const rpc of [
    "load_shared_seminar_plan",
    "save_owned_seminar_plan",
    "save_shared_seminar_plan",
    "rotate_seminar_plan_share_tokens"
  ]) {
    assert.ok(cloud.includes(`"${rpc}"`), `${rpc} is missing`);
  }
  assert.ok(cloud.includes("p_expected_revision"));
  assert.ok(cloud.includes("PLAN_CONFLICT"));
  assert.doesNotMatch(cloud, /\.from\("seminar_plans"\)\s*\.insert\(/);
  assert.match(cloud, /p_plan_id:\s*null/);
});

test("database access is authenticated, owner-scoped, and token-safe", () => {
  assert.match(schema, /alter table public\.seminar_plans enable row level security/i);
  assert.match(schema, /using \(\(select auth\.uid\(\)\) = owner_id\)/i);
  assert.match(schema, /grant execute[\s\S]+load_shared_seminar_plan\(uuid\)[\s\S]+to authenticated/i);
  const sharedLoad = schema.match(
    /create or replace function public\.load_shared_seminar_plan[\s\S]+?\$function\$;/i
  )?.[0] || "";
  assert.doesNotMatch(sharedLoad.match(/returns table \([\s\S]+?\)/i)?.[0] || "", /view_token|edit_token/i);
});

test("cloud UI includes auth, plans, sharing, and conflict recovery", () => {
  for (const id of [
    "cloudAuthModal",
    "cloudPlansModal",
    "cloudShareModal",
    "cloudSaveBtn",
    "cloudReloadBtn",
    "cloudViewLink",
    "cloudEditLink"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test("card edits stay in a draft until the completion button is pressed", () => {
  assert.match(html, /let editDraft=null/);
  assert.match(html, /function updateEditDraft\(/);
  assert.match(html, /function commitEditModal\(/);
  assert.match(html, /editModalDone'\)\.onclick=commitEditModal/);
  assert.doesNotMatch(html, /addEventListener\('input',e=>updateSelected/);
});

test("cloud plans reopen from the URL and refresh only when local work is clean", () => {
  assert.match(cloud, /getOwnedPlanIdFromUrl/);
  assert.match(cloud, /searchParams\.set\("plan", planId\)/);
  assert.match(cloud, /refreshLatestWhenSafe/);
  assert.match(cloud, /window\.hasPendingCardEdit/);
  assert.match(cloud, /payloadSignature\(\) !== cloud\.lastSavedSignature/);
  assert.match(html, /function cloudStatePayload\(\)/);
});

test("snapshot sharing and JSON fallback remain available", () => {
  assert.ok(html.includes("スナップショット共有"));
  assert.ok(html.includes("JSON保存"));
  assert.ok(html.includes("JSON読込"));
  assert.ok(html.includes("nmf_session_plan_v512_live.json"));
});
