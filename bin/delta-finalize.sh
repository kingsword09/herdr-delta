#!/bin/sh
# delta.bridge finalize — land a reviewed round on the real repository.
#
# Usage:
#   delta.bridge.finalize [--mode direct|pr-squash] [--message MSG]
#
# Modes:
#   direct     commit the project working tree's uncommitted changes on the
#              current branch and push.
#   pr-squash  create a branch, commit, push, open a PR, and squash-merge it.
#
# The round to finalize is the one recorded by dispatch in the plugin state
# (finalize-<workspace>.env). --mode overrides the remembered merge mode.

set -eu
cd "$(dirname "$0")/.."
. lib/common.sh

MODE="${MERGE:-direct}"
MSG=""
while [ $# -gt 0 ]; do
    case "$1" in
    --mode)    MODE="$2"; shift 2 ;;
    --message) MSG="$2"; shift 2 ;;
    *)         die "unknown argument: $1" ;;
    esac
done
case "$MODE" in
direct|pr-squash) ;;
*) die "mode must be direct or pr-squash" ;;
esac

ff="$STATE_DIR/finalize-$(workspace_external_id).env"
[ -f "$ff" ] || die "no finalized round recorded for this workspace; run dispatch first"
. "$ff"
PROJECT_DIR="${PROJECT_DIR:?finalize record has no PROJECT_DIR}"
MERGE_TID="${THREAD_ID:-}"

[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ] || die "no uncommitted changes in $PROJECT_DIR to land"

MSG="${MSG:-delta.bridge: land round ${MERGE_TID:-<unknown thread>}}"
git -C "$PROJECT_DIR" add -A

if [ "$MODE" = "direct" ]; then
    git -C "$PROJECT_DIR" commit -m "$MSG"
    git -C "$PROJECT_DIR" push || echo "delta.bridge: push failed; push manually" >&2
    echo "committed and pushed to the current branch in $PROJECT_DIR"
else
    branch="delta-bridge/$(date +%Y%m%d-%H%M%S)"
    git -C "$PROJECT_DIR" checkout -b "$branch"
    git -C "$PROJECT_DIR" commit -m "$MSG"
    git -C "$PROJECT_DIR" push -u origin "$branch" || die "push of $branch failed"
    pr_url="$(cd "$PROJECT_DIR" && gh pr create --title "$MSG" --body "Landed from Delta thread ${MERGE_TID:-} via herdr-delta." --head "$branch" 2>/dev/null)" \
        || die "gh pr create failed (is gh authenticated?)"
    (cd "$PROJECT_DIR" && gh pr merge "$branch" --squash --delete-branch) \
        || die "gh pr merge --squash failed; finish the PR manually: $pr_url"
    echo "squash-merged $branch into the default branch (pr: $pr_url)"
fi
