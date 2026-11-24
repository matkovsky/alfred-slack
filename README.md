# Alfred Slack

Jump to Slack channels, people and group DMs across all your workspaces from Alfred.

## Usage

| Input | Does |
|---|---|
| `sl design` | Search channels, people and group DMs in every workspace |
| `sl cf: design` | Only search the workspace with prefix `cf` |
| ↩ | Open in the Slack app (`slack://`) |
| ⌘↩ | Copy the link |
| ⌥↩ | Open in the browser |
| ⌃↩ | Type a quick message, ↩ sends it as you |
| fn↩ | Add an alias (e.g. name a group DM `Team Leads :necktie:`) |
| hold ⇧ | Show topic / status, member count |
| no match | "Search <workspace> for …" opens Slack's ⌘K switcher in that workspace, types the query and hits ↩ |
| `sl:token` | Connect a workspace (paste a token), see sync status, ⌘↩ removes a token |
| `sl:refresh` | Re-fetch everything now (also happens automatically in the background every 6 h) |

Results with the same quality are ordered by workspace priority (see *Workspaces* in the
workflow's configuration), then joined before not-joined. Alfred learns from what you pick.

## Setup

1. Workspaces are read from the Slack desktop app automatically. Optionally set their
   priority and prefixes in the workflow's **Configure Workflow…** → *Workspaces*:
   ```
   kuix=k
   creative-factory=cf
   acme=a
   ```
2. For each workspace, create a Slack app:
   [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From a manifest* →
   pick the workspace → paste [`slack-app-manifest.yml`](slack-app-manifest.yml) → *Create* →
   *Install to Workspace* (some workspaces need admin approval) → copy the **User OAuth Token** (`xoxp-…`).
3. In Alfred: `sl:token xoxp-…` → ↩. The workspace is detected from the token, the token is stored in
   the macOS Keychain (service `alfred-slack`), and the cache is built.
4. For the ⌘K fallback, allow Alfred in *System Settings → Privacy & Security → Accessibility*.

Workspaces without a token still work via the ⌘K fallback.

## Where things live

- Tokens: login Keychain, never in Alfred's (possibly synced) preferences.
- Cache: `~/Library/Caches/com.runningwithcrayons.Alfred/Workflow Data/com.matkovsky.alfred-slack/`
- Aliases: `~/Library/Application Support/Alfred/Workflow Data/com.matkovsky.alfred-slack/aliases.json`

## Development

```
make test      # ranking smoke tests against fixtures
make install   # build and copy into Alfred's workflows folder (keeps your configuration)
make package   # build/Slack-<version>.alfredworkflow
```

### Releasing

Push a version tag; GitHub Actions (`.github/workflows/release.yml`) runs the tests, builds
`Slack-<version>.alfredworkflow` on a macOS runner and publishes it as a GitHub release:

```
git tag v1.0 && git push origin v1.0
```

The workflow's version is taken from the tag (`v1.0` → `1.0`).

Everything is JavaScript for Automation (`src/slack.js`), with no dependencies.
`osascript -l JavaScript src/slack.js dump-mpim` prints raw group-DM objects, to check
which field (if any) holds a custom group-DM name.
