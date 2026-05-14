# .github

Shared GitHub Actions workflows for the oneoffworld organization.

## Reusable Workflows

### `slack-notify.yml`

Waits for Cursor Bugbot to finish on a PR, then posts the result to Slack.

**Usage** — add this to `.github/workflows/slack-notify.yml` in any repo:

```yaml
name: Slack PR Check Notification

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  slack-notify:
    uses: oneoffworld/.github/.github/workflows/slack-notify.yml@main
    secrets:
      SLACK_DEPLOYMENTS_WEBHOOK_URL: ${{ secrets.SLACK_DEPLOYMENTS_WEBHOOK_URL }}
```

### Required Secrets

Each calling repo must have `SLACK_DEPLOYMENTS_WEBHOOK_URL` set in its repository secrets.

### `check-package-freshness.yml`

Fails a PR if `package-lock.json` introduces any npm package version published
less than `min-age-days` ago. Supply-chain hardening against compromised
releases (axios / chalk / debug / Shai-Hulud, etc.) which are typically
detected and yanked from the registry within a week.

**Usage** — add this to `.github/workflows/package-freshness.yml` in any repo:

```yaml
name: Package freshness

on:
  pull_request:
    paths:
      - 'package-lock.json'
      - 'package.json'
      - '.github/workflows/package-freshness.yml'

jobs:
  check:
    uses: oneoffworld/.github/.github/workflows/check-package-freshness.yml@main
    with:
      min-age-days: '7'
      # allow-fresh: 'react,react-dom'   # optional comma-separated exemptions
```

The shared script lives at `scripts/check-package-freshness.mjs` in this repo
and is checked out at workflow runtime. Requires `package-lock.json`
(lockfileVersion >= 2) in the caller repo.
