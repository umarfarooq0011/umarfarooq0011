# Profile graph automation

GitHub Actions runs the updater on GitHub-hosted runners every 15 minutes, independently of the developer's computer. Scheduled runs can be delayed by GitHub. A manual workflow run and `repository_dispatch` event named `refresh-profile` are also supported.

The updater collects public GitHub activity and language bytes from owned public non-fork repositories. It reads only commit metadata from automotiveDMS on GitLab. Company source code is never copied. GitLab-only activity remains a separately labelled graph because GitHub controls its native contribution calendar.

## One-time GitLab connection

Create a dedicated GitLab personal access token with only `read_api` and a suitable expiry date. Save it directly in this repository's Actions secrets as `GITLAB_READ_API_TOKEN`. This read permission covers API data available to that GitLab account, so protect and rotate the token. Prefer a project-restricted read credential if the project owner can provide one.

Do not put tokens in code, issues, logs, workflow inputs, or chat. The workflow uses the short-lived, repository-scoped `GITHUB_TOKEN` for GitHub publication; no GitHub personal access token is required at runtime.

After adding the secret, run **Refresh profile graphs** from the Actions tab and check that it succeeds. A missing or failed data source retains its previous graph and marks the run as partial/failing so it can be repaired.

## Triggers and scope

Cross-repository pushes are picked up by the scheduled cloud checks. Immediate events from another repository require an authorized external integration to send `repository_dispatch`; this repository does not install hooks into company repositories.

GitLab counts exact author name `umar Awan`, excludes merges, and reads commits reachable from the current default branch. A new branch's work appears when it reaches the default branch. If the verified Git author identity changes, update the configuration deliberately.

Only eight graph SVGs and the README's `profile-stats` blocks are updated. Other text is preserved, unchanged data creates no commit, concurrent changes are retried without force updates, and graph commits use an automation identity.

The code has no third-party runtime packages. It requires Node.js 24 and the GitHub CLI on the hosted runner. Local execution can continue to use existing `gh` and `glab` sign-ins without exporting their credentials.

```sh
node --test automation/refresh-profile.test.cjs
node automation/collect-gitlab.cjs --self-test
node automation/refresh-profile.cjs --publish
```
