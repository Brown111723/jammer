#!/usr/bin/env bash
#
# Finish an update after a new jammer.tar.gz has been extracted over ~/jammer.
#
# Normally run by the one-liner in README.md, which extracts the newest download and
# then calls this. It ships inside the tarball, so the update steps themselves are
# always current.
#
#   1. npm install        — picks up any dependency changes
#   2. git push           — publishes the new commits to GitHub
#   3. tidy downloads     — removes old jammer*.tar.gz so the next download gets a
#                           clean name instead of "jammer (3).tar.gz"
#   4. npm run dev        — starts the app
#
# Environment switches, mainly for testing:
#   JAMMER_NO_PUSH=1   skip the push
#   JAMMER_NO_RUN=1    don't start the dev server
#   JAMMER_KEEP_DOWNLOADS=1   leave the tarballs in Downloads

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

version=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
build=$(git rev-list --count HEAD 2>/dev/null || echo "?")
commit=$(git rev-parse --short HEAD 2>/dev/null || echo "?")

echo "==> Jammer v${version} · build ${build} · ${commit}"

echo "==> Installing dependencies"
if ! npm install --no-audit --no-fund --loglevel=error; then
  echo "!! npm install failed — fix that before running the app." >&2
  exit 1
fi

if [ "${JAMMER_NO_PUSH:-0}" != "1" ]; then
  echo "==> Pushing to GitHub"
  # A failed push (no token, offline) shouldn't stop you playing — say so and carry on.
  if ! git push -u origin main; then
    echo "!! Push failed. The app is updated locally; run 'git push' later." >&2
  fi
fi

if [ "${JAMMER_KEEP_DOWNLOADS:-0}" != "1" ] && [ -d "$HOME/storage/downloads" ]; then
  # Android names repeat downloads "jammer (1).tar.gz", "jammer (2).tar.gz"… Clearing
  # them means the next download is plain jammer.tar.gz again.
  rm -f "$HOME"/storage/downloads/jammer*.tar.gz 2>/dev/null && \
    echo "==> Cleared old jammer*.tar.gz from Downloads"
fi

echo "==> Updated to v${version} (build ${build}). Check the footer on the home page."

if [ "${JAMMER_NO_RUN:-0}" != "1" ]; then
  echo "==> Starting the app — open http://localhost:3000 (Ctrl+C to stop)"
  exec npm run dev
fi
