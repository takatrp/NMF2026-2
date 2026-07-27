import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const XLSX = require(path.join(root, "vendor", "xlsx.full.min.js"));
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
  assert.match(schema, /grant execute[\s\S]+load_public_seminar_plan\(\)[\s\S]+to anon, authenticated/i);
  const sharedLoad = schema.match(
    /create or replace function public\.load_shared_seminar_plan[\s\S]+?\$function\$;/i
  )?.[0] || "";
  assert.doesNotMatch(sharedLoad.match(/returns table \([\s\S]+?\)/i)?.[0] || "", /view_token|edit_token/i);
  const publicLoad = schema.match(
    /create or replace function public\.load_public_seminar_plan[\s\S]+?\$function\$;/i
  )?.[0] || "";
  assert.doesNotMatch(publicLoad, /owner_id|view_token|edit_token/i);
});

test("cloud UI includes auth, plans, sharing, and conflict recovery", () => {
  for (const id of [
    "cloudAuthModal",
    "cloudPlansModal",
    "cloudShareModal",
    "cloudSaveBtn",
    "cloudPublishBtn",
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
  assert.match(html, /function hasEditDraftChanges\(/);
  assert.ok(html.includes("入力中の変更を破棄しますか？この操作は元に戻せません。"));
  assert.doesNotMatch(html, /addEventListener\('input',e=>updateSelected/);
});

test("cloud plans reopen from the URL and refresh only when local work is clean", () => {
  assert.match(cloud, /getOwnedPlanIdFromUrl/);
  assert.match(cloud, /searchParams\.set\("plan", planId\)/);
  assert.match(cloud, /refreshLatestWhenSafe/);
  assert.match(cloud, /window\.hasPendingCardEdit/);
  assert.match(cloud, /payloadSignature\(\) !== cloud\.lastSavedSignature/);
  assert.match(cloud, /function loadLatestOwnedPlan\(/);
  assert.match(cloud, /\.order\("updated_at", \{ ascending: false \}\)/);
  assert.match(cloud, /\.limit\(1\)/);
  assert.match(cloud, /if \(!wasSignedIn\) await loadLatestOwnedPlan\(\)/);
  assert.match(html, /function cloudStatePayload\(\)/);
});

test("the normal URL loads a designated public plan without login", () => {
  assert.match(cloud, /function loadPublicPlan\(/);
  assert.match(cloud, /\.rpc\("load_public_seminar_plan"\)/);
  assert.match(cloud, /applyCloudPlan\(row, "public", "", false\)/);
  assert.match(cloud, /await loadPublicPlan\(true\)/);
  assert.match(cloud, /cloud\.current\?\.access === "public"/);
  assert.match(cloud, /cloudReloadBtn/);
  assert.match(cloud, /function publishCurrentPlan\(/);
  assert.match(cloud, /\.rpc\("publish_owned_seminar_plan"/);
});

test("the progress script exports a speaker-by-speaker Excel workbook", () => {
  assert.match(html, /id="downloadExcelBtn"/);
  assert.match(html, /function buildScriptWorkbookRows\(/);
  assert.match(html, /\['パート（タイトル・時間）','天野先生','大森先生','松本'\]/);
  assert.match(html, /return \[part,s\.prompt\|\|'',s\.speakerB\|\|'',s\.speakerA\|\|''\]/);
  assert.match(html, /const blob=new Blob\(\[workbookData\]/);
  assert.match(html, /document\.body\.appendChild\(link\)/);
  assert.match(html, /setTimeout\(\(\)=>URL\.revokeObjectURL\(downloadUrl\),1000\)/);
  assert.match(html, /Excelファイルを保存できませんでした/);
  assert.ok(html.includes("NMF第2分科会_進行台本.xlsx"));
});

test("the Excel workbook keeps its speaker-by-speaker rows", () => {
  const rows = [
    ["パート（タイトル・時間）", "天野先生", "大森先生", "松本"],
    ["1. テスト\n0〜10分（10分）", "問い", "大森先生の内容", "松本の内容"]
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "進行台本");
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true });
  const reopened = XLSX.read(output, { type: "array" });
  assert.deepEqual(
    XLSX.utils.sheet_to_json(reopened.Sheets["進行台本"], { header: 1 }),
    rows
  );
});

test("snapshot sharing and JSON fallback remain available", () => {
  assert.ok(html.includes("スナップショット共有"));
  assert.ok(html.includes("JSON保存"));
  assert.ok(html.includes("JSON読込"));
  assert.ok(html.includes("nmf_session_plan_v515_live.json"));
});
