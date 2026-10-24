# Deploying Wraith

This document describes the deploy process and how to tell which commit is live.

## Approach chosen

The repo now ships **both** a deploy workflow and this manual procedure. The workflow is the primary path; this document is the fallback and the explanation of what the workflow does.

Why both:

- **Automation** is the only thing that actually closes the gap described in the issue. A manual procedure that depends on someone remembering to click is the bug.
- **A documented manual path** is required because the workflow can be disabled, the Render hook can be rotated, and a deploy that fails halfway needs a human to finish it.

The workflow does not click a button in a dashboard. It calls the Render deploy hook and then **verifies the live commit matches the commit it just built**. A deploy that succeeds but serves the wrong SHA is the same failure as not deploying at all, so the workflow fails in that case.

## Reporting the running commit

The commit is reported at `$GET/status` under the `commit` field:

```json
{
  "commit": {
    "sha": "4f2a1c9e8d3b7c65a49087f6e5d4c3b2a1098776",
    "short": "4f2a1c9",
    "branch": "main",
    "commitTime": "2026-10-20T12:00:00Z"
  },
  ...
}
```

The value comes from the build, not from a file someone updates by hand. Specifically:

1. `scripts/generate-version.ts` runs as the first step of `npm run build`.
2. It reads `GIT_COMMIT_SHA`, `GIT_BRANCH` and `GIT_COMMIT_TIME` from the environment if set, and otherwise falls back to git in the checkout.
3. It writes the result to `src/generated/version.ts`, which is compiled into `dist/generated/version.js`.
4. `src/index.ts` imports that module and serves it from `/status`.

The generated file is gitignored and never committed. If a build is made outside CI, the value is still taken from the checkout at build time, not at run time.

If the build happens without a git checkout and without `GIT_COMMIT_SHA`, the value is the literal string `unknown`. That is deliberate: a unknown SHA is visible and wrong, whereas a fallback to something plausible would hide the problem.

## Automated deploy (primary)

`.github/workflows/deploy.yml` runs on every push to `main`. It:

1. Installs dependencies and generates the Prisma client.
2. Runs `npm run typecheck` and `npm test`.
3. Runs `npm run build`, passing `GIT_COMMIT_SHA`, `GIT_BRANCH` and `GIT_COMMIT_TIME` from the workflow context.
4. Asserts that `dist/generated/version.js` reports the expected SHA. This is the guard that the build actually embedded the commit.
5. Calls the Render deploy hook and polls the deploy until it reaches `live`.
6. Fetches `/status` from the production URL and fails the job if the live commit does not match the commit that was built.

Steps 5 and 6 are skipped if the required secrets are not set, so the workflow still verifies the build on forks and in repos without deploy credentials.

### Required secrets

Set these in GitHub repo settings under Secrets and variables → Actions:

| Secret | Purpose |
| --- | --- |
| `RENDER_DEPLOY_HOOK` | Render deploy hook URL for the web service. |
| `WRAITH_PRODUCT_URL` | Base URL of the deployed service, e.g. `https://wraith.example.com`. Used to verify `/status`. |

If `RENDER_DEPLOY_HOOK` is not set, the workflow builds and verifies the build but does not deploy. That is intentional -- a fork pushing to `main` should not deploy to production.

## Manual deploy (fallback)

Use this when the workflow is unavailable or when a deploy failed partway.

1. Confirm the commit you intend to deploy is on `main`:

   ```sh
   git fetch origin main
   git rev-parse origin/main
   ```

2. Build locally from that commit and verify the embedded SHA:

   ```sh
   git checkout origin/main
   npm ci
   npm run db:generate
   npm run typecheck
   npm test
   npm run build
   node -e "console.log(require('./dist/generated/version.js').BUILD_COMMIT_SHA)"
   ```

The printed SHA must equal `git rev-parse HEAD`. If it does not, stop -- the build is not of the commit you think it is.

3. Trigger the Render deploy hook:

   ```sh
   curl -sX POST -H "Content-Type: application/json" \
     -d '{"clearCache":"doNotClear"}' \
     "$RENDER_DEPLOY_HOOK"
   ```

The response contains a deploy id. Record it.

4. Wait for the deploy to reach `live` in the Render dashboard (Service → Events), or poll the deploy by id with the Render API.

5. Verify the live commit:

   ```sh
   curl -sf "$WRAITH_PRODUCT_URL/status" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('tend',()=>console.log(JSON.parse(s).commit.sha))"
   ```

The printed SHA must equal the commit you built. If it does not, the deploy is not complete -- do not report it as done.

## Why the live commit is the source of truth

A successful deploy hook call only means Render accepted the request. It does not mean the new build started, and it certainly does not mean the new build is serving traffic. The only thing that proves the deploy landed is `/status` reporting the SHA that was built. That is why the workflow and this document both end with that check.

## What this does not do

- It does not apply Prisma migrations. Neither `build` nor `start` does, and the workflow does not change that. A schema change still needs its migration applied as a separate, deliberate step.
- It does not roll back. Render retains the previous deploy; roll back is a dashboard action and is out of scope here.
- It does not deploy to more than one service. If a second service is added, a second hook and a second verification step are needed.
