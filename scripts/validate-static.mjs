import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const cloud = fs.readFileSync(path.join(root, "cloud.js"), "utf8");
const config = fs.readFileSync(path.join(root, "supabase-config.js"), "utf8");

const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
if (inlineScripts.length !== 1) {
  throw new Error(`Expected one inline script, found ${inlineScripts.length}`);
}

new vm.Script(inlineScripts[0][1], { filename: "index.inline.js" });
new vm.Script(cloud, { filename: "cloud.js" });
new vm.Script(config, { filename: "supabase-config.js" });

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
const duplicateIds = [...html.matchAll(/\bid="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((id, index, ids) => ids.indexOf(id) !== index);
if (duplicateIds.length) {
  throw new Error(`Duplicate HTML ids: ${[...new Set(duplicateIds)].join(", ")}`);
}

const cloudIds = new Set([...cloud.matchAll(/\bbyId\("([^"]+)"\)/g)].map((match) => match[1]));
const missingIds = [...cloudIds].filter((id) => !htmlIds.has(id));
if (missingIds.length) {
  throw new Error(`cloud.js references missing ids: ${missingIds.join(", ")}`);
}

if (!html.includes("v5.14 Live")) throw new Error("Visible version is not v5.14 Live");
if (!config.includes("sb_publishable_")) throw new Error("Publishable key is not configured");
if (/service_role|sb_secret_/i.test(config)) throw new Error("Secret Supabase key found in browser config");

console.log(`Static build validation passed: ${htmlIds.size} ids, ${cloudIds.size} cloud bindings`);
