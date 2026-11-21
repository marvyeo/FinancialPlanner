---
name: ship-app
description: Ship a static GitHub-Pages app (Financial Planner and sibling apps): pull, test, update the project state file, bump the service-worker cache, commit, merge to main, push, verify. Use when the user says "ship", "deploy", "merge to main" or "push this live".
---
# Ship an app

Works for any of Marvin's static apps that have `docs/PROJECT_STATE.md`, optional `tests/`, and a `sw.js` cache name. Only Marvin develops these apps; Caroline just uses them.

1. `git pull`; read `docs/PROJECT_STATE.md` (RESUME HERE block, Next chat name).
2. Run the tests if any (`node tests/*.test.js`). Stop on failures and report them.
3. Bump the `CACHE` version string in `sw.js` (`...-vN` → `-vN+1`) if app files changed, so phones pick up the new build.
4. Update `docs/PROJECT_STATE.md` in the same commit: dated change-log line, any section the change made wrong, RESUME HERE block, Next chat name +1.
5. Commit with the attribution trailers the session gives. Never commit personal data (cards, statements, merchants.json, xlsx): these repos are public.
6. Deploy ONLY when Marvin has said so for this change: `git fetch origin main`, check `git merge-base --is-ancestor origin/main HEAD` (fast-forward) else merge main in and re-test, then `git push origin HEAD:main`. Also push the dev branch.
7. Tell Marvin the live URL, to hard-reload once (service-worker cache), and what to check first.
Never force-push, never skip tests to get green.
