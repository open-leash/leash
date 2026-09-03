#!/usr/bin/env node
import fs from "node:fs";

const checks = [
  ["desktop installer", "scripts/install-openleash-personal.sh"],
  ["desktop packaging", "electron-builder.personal.yml"],
  ["desktop package", "apps/desktop/package.json"],
  ["Engine image", "apps/engine/Dockerfile"],
  ["personal open-source compose", "deploy/docker/individual-open-source.compose.yml"],
  ["Feature registry", "apps/engine/src/plugins/feature-runtime.ts"],
  ["Feature runtime tests", "apps/engine/src/plugins/feature-runtime.test.ts"],
  ["public setup guide", "README.md"],
];

const contentChecks = [
  ["installer supports Personal Open Source", "scripts/install-openleash-personal.sh", /--open-source/],
  ["desktop package registers the OpenLeash callback protocol", "electron-builder.personal.yml", /schemes:\s*\n\s*- openleash/],
  ["README supports Personal Open Source", "README.md", /Personal Open Source \(BYOK\)/],
  ["Features execute in process", "apps/engine/src/plugins/feature-runtime.ts", /BUILTIN_FEATURE_HANDLERS/],
  ["manifests declare built-in runtime", "packages/shared/src/index.ts", /runtime:\s*"builtin"/],
  ["Engine exposes its personal port", "apps/engine/Dockerfile", /EXPOSE\s+9318(?:\s|$)/],
  ["personal compose excludes dashboards", "deploy/docker/individual-open-source.compose.yml", /services:/],
];

const forbidden = [
  ["public dashboard workspace", "package.json", /apps\/dashboard-(?:api|web)/],
  ["public identity provider", ".gitmodules", /IdentityLoader/],
  ["public Feature repository", ".gitmodules", /plugins\/plugin-/],
  ["container Feature runtime", "scripts/docker-images.mjs", /plugin-(?:gateway|token-saver|blast-radius)/],
  ["dashboard in personal compose", "deploy/docker/individual-open-source.compose.yml", /dashboard-(?:api|web)/],
];

const failures = [];
for (const [label, file] of checks) {
  if (!fs.existsSync(file)) failures.push(`${label}: missing ${file}`);
}
for (const [label, file, pattern] of contentChecks) {
  if (!fs.existsSync(file) || !pattern.test(fs.readFileSync(file, "utf8"))) {
    failures.push(`${label}: ${file} did not match ${pattern}`);
  }
}
for (const [label, file, pattern] of forbidden) {
  if (fs.existsSync(file) && pattern.test(fs.readFileSync(file, "utf8"))) {
    failures.push(`${label}: ${file} unexpectedly matched ${pattern}`);
  }
}

const rootPackage = JSON.parse(fs.readFileSync("package.json", "utf8"));
const desktopPackage = JSON.parse(fs.readFileSync("apps/desktop/package.json", "utf8"));
if (rootPackage.version !== desktopPackage.version) failures.push("root and desktop versions differ");
if (failures.length) {
  console.error("Deployment readiness failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log("Leash personal deployment readiness ok");
