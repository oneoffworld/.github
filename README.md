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
