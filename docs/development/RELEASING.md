# Releasing Meridian

## Making a release

```powershell
npm run release 0.2.0
```

That sets the version, commits, tags and pushes. GitHub then tests the app, builds it and publishes a release with:

| File | What it is |
|---|---|
| `Meridian-0.2.0-setup.exe` | The normal installer, per user |
| `Meridian-0.2.0.msi` | Windows Installer, for managed machines |
| `Meridian-0.2.0-portable.exe` | Runs with no install. Needs the WebView2 runtime, which Windows 11 includes |
| `SHA256SUMS.txt` | Checksums for all of the above |

To try a build without publishing anything, open the Actions tab, choose Release, and press Run workflow. The files stay on that
run for 7 days. Commit your work first: the script refuses to run with uncommitted changes.

This repository is private, so its releases can be downloaded only by people with access to it.

Before publishing, scan the installers with Windows Defender. A new unsigned build can trip its machine-learning model, and the MSI
is the fallback if the setup exe is flagged.

## What the workflow needs

Nothing, for a working unsigned build. These optional secrets, set under Settings, Secrets and variables, Actions, turn more on:

| Secret | What it turns on |
|---|---|
| The `MERIDIAN_CLIENT_*`, `MERIDIAN_SECRET_*` and Google and Microsoft IDs listed under Customer sign-in | Sign-in for those services |

## How installed copies update

Settings, Updates checks for a newer release and installs it on a click. It works while this repository is private, and only on a PC
signed in to the GitHub CLI with access to it. Run `gh auth login` once on each PC. Nobody else can update, because nobody else can see
the releases.

The app asks GitHub for the latest release through `gh`, downloads the setup file and `SHA256SUMS.txt`, and refuses a file that does not
match. It then quits, runs the installer silently, and starts again. A restart ends running agents, so nothing installs without the
click. See `docs/DECISIONS.md`, D52.

The checksum catches a damaged download. It proves nothing about who built the file. Updating customers needs a public host and a
signed update, so it needs the plan in D52 first.

To try an update without publishing a second release, build the current code with an older version number, install that, and press
Update now. It then fetches the real latest release:

```powershell
'{ "version": "0.3.9" }' | Set-Content older.json
npx tauri build --bundles nsis --config older.json
```

A change to `update.rs` reaches a PC only with the update after the one that carries it, because the copy already installed does the
installing.

## One-time setup

Get a code-signing certificate. Without one, Windows SmartScreen warns every customer.

## Building by hand

1. Set the version in `apps/desktop/src-tauri/tauri.conf.json`, both `package.json` files and the workspace `Cargo.toml`.
2. Build, from `apps/desktop`:
   ```powershell
   npx tauri build
   ```

## Customer sign-in

Nobody using the app ever types a key. Services that accept only registered apps are registered once, by the publisher, and
the IDs go in at build time. Until then those rows say they are not available yet.

| Service | Set at build time |
|---|---|
| Gmail, Google Calendar, Google Drive | `MERIDIAN_GOOGLE_CLIENT_ID`, `MERIDIAN_GOOGLE_CLIENT_SECRET` |
| Outlook | `MERIDIAN_MICROSOFT_CLIENT_ID` |
| GitHub | `MERIDIAN_CLIENT_GITHUB`, `MERIDIAN_SECRET_GITHUB` |
| Slack | `MERIDIAN_CLIENT_SLACK`, `MERIDIAN_SECRET_SLACK` |
| Asana | `MERIDIAN_CLIENT_ASANA`, `MERIDIAN_SECRET_ASANA` |
| HubSpot | `MERIDIAN_CLIENT_HUBSPOT`, `MERIDIAN_SECRET_HUBSPOT` |
| Box | `MERIDIAN_CLIENT_BOX`, `MERIDIAN_SECRET_BOX` |

The other 16 services register themselves, and need nothing.

Google caps an unverified app at 100 new users. Google requires verification of a published
app for `gmail.readonly`, including a security assessment, so plan for weeks.
