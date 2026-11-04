#!/usr/bin/env bash
# One command, one place: build the unsigned IPA on GitHub and drop it at
# ~/IPA/HardlyReader-unsigned.ipa. No version in the name, no new folder.
set -euo pipefail

REPO=hardlysleeping/hardlyread
WORKFLOW=ios-unsigned.yml
DEST="$HOME/IPA/HardlyReader-unsigned.ipa"

mkdir -p "$HOME/IPA"
cd "$(dirname "$0")/.."

# `--ref` is not optional: `gh workflow run` with no ref dispatches the file on
# the repo's DEFAULT branch, which here is `main` (the public release line) while
# the work lives on `master`. A dispatch after a fix on master built `main`'s
# older head and handed over an IPA without the fix in it.
REF="${1:-master}"
echo "sha: $(git rev-parse --short HEAD) (building $REF)"
gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$REF" -f ref="$REF" -f runner=macos-15
sleep 8
RUN=$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --limit 1 --json databaseId -q '.[0].databaseId')
echo "run: https://github.com/$REPO/actions/runs/$RUN"

gh run watch "$RUN" --repo "$REPO" --exit-status --interval 20 >/dev/null

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gh run download "$RUN" --repo "$REPO" -D "$TMP"
IPA=$(find "$TMP" -name '*.ipa' | head -1)
[ -n "$IPA" ] || { echo "no .ipa in the artifact" >&2; exit 1; }
cp -f "$IPA" "$DEST"

ls -l "$DEST"
echo "IPA: $DEST"
