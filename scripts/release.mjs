// `npm run release 0.2.0`: sets the version everywhere, commits it, tags it and pushes.
// The tag starts .github/workflows/release.yml, which builds and publishes the release.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: npm run release 0.2.0");
  process.exit(1);
}

const run = (command) => execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

if (run("git status --porcelain")) {
  console.error("Commit or stash your changes first, so the release holds exactly what is in git.");
  process.exit(1);
}
if (run("git tag --list v" + version)) {
  console.error(`v${version} already exists.`);
  process.exit(1);
}

const edit = (file, change) => writeFileSync(file, change(readFileSync(file, "utf8")));
const json = (text) => text.replace(/"version": "[^"]+"/, `"version": "${version}"`);

edit("apps/desktop/src-tauri/tauri.conf.json", json);
edit("package.json", json);
edit("apps/desktop/package.json", json);
edit("Cargo.toml", (text) => text.replace(/^version = "[^"]+"/m, `version = "${version}"`));
run("cargo update --workspace");
run("npm install --package-lock-only --ignore-scripts");

run("git add -A");
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
run(`git push origin HEAD v${version}`);
console.log(`Pushed v${version}. Follow the build in the Actions tab.`);
