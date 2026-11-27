#!/usr/bin/env node
/**
 * Doctine · builds dist/doctine-oracle-stack.zip for Oracle Resource Manager: the Terraform files in
 * infra/oracle-a1/terraform plus the first-boot file (cloud-init.yaml) beside them. Run: node tools/oracle-stack.mjs
 * Uploading the zip and running **Plan** creates nothing; **Apply** needs the owner's approval (infra/oracle-a1/README.md).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readdirSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname, tf = join(root, "infra/oracle-a1/terraform"), out = join(root, "dist/doctine-oracle-stack.zip");
const stage = mkdtempSync(join(tmpdir(), "oracle-stack-"));
const files = readdirSync(tf).filter((f) => f.endsWith(".tf"));
for (const f of files) copyFileSync(join(tf, f), join(stage, f));
copyFileSync(join(root, "infra/oracle-a1/cloud-init.yaml"), join(stage, "cloud-init.yaml"));
mkdirSync(join(root, "dist"), { recursive: true });
rmSync(out, { force: true });
execFileSync("zip", ["-q", "-X", "-j", out, ...[...files, "cloud-init.yaml"].map((f) => join(stage, f))]);
rmSync(stage, { recursive: true, force: true });
console.log(`oracle-stack: ${out} (${[...files, "cloud-init.yaml"].join(", ")}) sha256 ${createHash("sha256").update(readFileSync(out)).digest("hex")}`);
