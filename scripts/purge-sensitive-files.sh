#!/usr/bin/env bash
# scripts/purge-sensitive-files.sh
# Removes data exports from the repository AND from its history.
# Do this on a fresh clone (git clone --mirror is fine). Needs: git, git-filter-repo (pip install git-filter-repo)
# STEP 0: make the repository PRIVATE on GitHub first (Settings > General > Danger Zone > Change visibility).
set -euo pipefail

FILES="users.csv payments.csv contact_messages.csv subscriptions.csv reports.csv entities.csv"

# 1. Stop tracking the files on the current branch (the .gitignore rule alone does NOT do this)
for f in $FILES; do git rm --cached --ignore-unmatch "$f"; done
git commit -m "Stop tracking data exports" || true

# 2. Remove them from every past commit
ARGS=""
for f in $FILES; do ARGS="$ARGS --path $f"; done
git filter-repo --invert-paths $ARGS --force

# 3. Re-add your remote (filter-repo removes it) and overwrite the remote history
# git remote add origin https://github.com/OWNER/REPO.git
# git push origin --force --all
# git push origin --force --tags

echo "Done. Now rotate every secret that ever existed in this repository (see CHK-03)."
