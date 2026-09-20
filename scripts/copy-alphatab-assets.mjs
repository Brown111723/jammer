/**
 * alphaTab ships its SMuFL music font and worker script as package assets that must be
 * served over HTTP — they can't be bundled. Next.js serves /public statically, so copy
 * them there after install.
 *
 * If you skip this, alphaTab renders boxes instead of noteheads and the failure looks
 * like a font problem rather than a missing-file problem.
 */

import { cp, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules", "@coderline", "alphatab", "dist");
const dest = join(root, "public", "alphatab");

try {
  await access(src);
} catch {
  console.warn(
    "[jammer] @coderline/alphatab not installed yet — skipping asset copy. " +
      "Run `npm install` again if tab rendering shows missing glyphs.",
  );
  process.exit(0);
}

await mkdir(dest, { recursive: true });

for (const entry of ["font", "soundfont", "alphaTab.min.js", "alphaTab.worker.min.js"]) {
  try {
    await cp(join(src, entry), join(dest, entry), { recursive: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

console.log("[jammer] alphaTab assets copied to public/alphatab/");
