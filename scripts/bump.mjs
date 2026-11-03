#!/usr/bin/env node
/**
 * Sets one version everywhere Obsidian looks for it.
 *
 * `package.json` and `manifest.json` carry the version, and `versions.json`
 * maps it to the `minAppVersion` it was built against. Obsidian checks that map
 * when it decides whether an install may update, so a release without the
 * entry is invisible to clients on older apps.
 *
 *   node scripts/bump.mjs 0.2.0
 *
 * No dependencies: this runs before `npm ci` in a release, and a bump that
 * needs an install is a bump that cannot be scripted.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Semver as specified: x.y.z, optional prerelease/build, no leading zeroes.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const version = process.argv[2];

if (!version) {
  console.error("usage: node scripts/bump.mjs <version>   (for example 0.2.0)");
  process.exit(2);
}

if (!SEMVER.test(version)) {
  console.error(`not a semver version: ${version}`);
  process.exit(1);
}

if (version.includes("-") || version.includes("+")) {
  console.warn(
    "warning: Obsidian expects a plain x.y.z version; prerelease and build suffixes may be rejected",
  );
}

const readJson = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
const writeJson = (file, value) => {
  writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`);
};

const pkg = readJson("package.json");
const manifest = readJson("manifest.json");
const minAppVersion = manifest.minAppVersion;

if (typeof minAppVersion !== "string" || !SEMVER.test(minAppVersion)) {
  console.error("manifest.json has no usable minAppVersion");
  process.exit(1);
}

const versions = existsSync(join(root, "versions.json")) ? readJson("versions.json") : {};

pkg.version = version;
manifest.version = version;
versions[version] = minAppVersion;

writeJson("package.json", pkg);
writeJson("manifest.json", manifest);
writeJson("versions.json", versions);

console.log(`version ${version} (minAppVersion ${minAppVersion})`);
console.log(`tag it with: git tag obsidian-v${version}`);
