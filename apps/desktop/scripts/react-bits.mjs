// Adds React Bits components from reactbits.dev's registry (the one named in components.json) to src/components.
// It does what `npx shadcn add @react-bits/<name>` does, except that it never installs dependencies: the registry
// asks for motion@^12, and shadcn would install that over our motion 14. It lists what a component needs instead.
//
//   npm run react-bits -- BlurText-TS-CSS GlassSurface-TS-CSS
//
// Pick the TS-CSS variant: Meridian is TypeScript with plain CSS, no Tailwind. Add --force to replace a file.

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const force = args.includes("--force");
const names = args.filter((a) => !a.startsWith("--"));
if (names.length === 0) {
  console.error("Name at least one component, for example: npm run react-bits -- BlurText-TS-CSS");
  process.exit(1);
}

const registry = JSON.parse(await readFile(join(root, "components.json"), "utf8")).registries["@react-bits"];
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const have = { ...pkg.dependencies, ...pkg.devDependencies };
/** "motion@^12.23.12" is motion, "@react-three/fiber@^9" is @react-three/fiber. */
const packageOf = (spec) => spec.slice(0, spec.lastIndexOf("@") > 0 ? spec.lastIndexOf("@") : spec.length);
const exists = (path) => access(path).then(() => true, () => false);

const needed = new Set();
for (const name of names) {
  const url = registry.replace("{name}", name);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: ${res.status} from ${url}. Check the name on reactbits.dev, with its -TS-CSS ending.`);
  const item = await res.json();
  // Each component in a folder of its own, whatever the registry calls its paths: BlurText/BlurText.tsx, but GlassSurface.css.
  const folder = name.replace(/-(JS|TS)-(CSS|TW)$/, "");
  for (const file of item.files ?? []) {
    const path = `${folder}/${basename(file.path)}`;
    const to = join(root, "src", "components", path);
    if ((await exists(to)) && !force) {
      console.log(`kept      src/components/${path} (already there; --force replaces it)`);
      continue;
    }
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, file.content);
    console.log(`added     src/components/${path}`);
  }
  for (const spec of item.dependencies ?? []) if (!have[packageOf(spec)]) needed.add(spec);
  for (const other of item.registryDependencies ?? []) console.log(`also needs ${other} from the registry`);
}
if (needed.size > 0) console.log(`\nStill to install: npm i ${[...needed].map(packageOf).join(" ")}`);
else console.log("\nEverything it imports is already installed.");
