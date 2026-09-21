import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Version and build number, baked in at build/dev start.
 *
 *   version — semver from package.json, bumped by hand once per delivered iteration.
 *   build   — the git commit count, so it rises automatically with every commit and
 *             two different builds can never show the same number.
 *   commit  — short hash, so a screenshot of the footer identifies the exact code.
 *
 * Git can be missing (a zip download, a stripped container), so every lookup falls
 * back rather than failing the build over a label.
 */
function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dev overlay badge sits bottom-left, exactly on top of the chord diagram.
  devIndicators: false,
  images: {
    // Spotify serves album art from these CDNs.
    remotePatterns: [{ protocol: "https", hostname: "i.scdn.co" }],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BUILD_NUMBER: git("rev-list --count HEAD") || "0",
    NEXT_PUBLIC_COMMIT: git("rev-parse --short HEAD") || "unknown",
  },
};

export default nextConfig;
