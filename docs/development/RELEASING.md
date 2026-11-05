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

The release notes are the commit subjects since the last tag, leaving out those starting with Release or Record. The Updates page shows
them as they are, so write subjects for the person using the app.

To try a build without publishing anything, open the Actions tab, choose Release, and press Run workflow. The files stay on that
run for 7 days. Commit your work first: the script refuses to run with uncommitted changes.

This repository is public, so anyone can download its releases, and every installed copy is offered each new one.

Before publishing, scan the installers with Windows Defender. A new unsigned build can trip its machine-learning model, and the MSI
is the fallback if the setup exe is flagged.

## What the workflow needs

Nothing, for a working unsigned build. These optional secrets, set under Settings, Secrets and variables, Actions, turn more on:

| Secret | What it turns on |
|---|---|
| The `MERIDIAN_CLIENT_*`, `MERIDIAN_SECRET_*` and Google and Microsoft IDs listed under Customer sign-in | Sign-in for those services |

## How installed copies update

A new copy asks once, half a minute after it first starts, whether it may look for updates by itself. Until the user says yes it looks
only when they press Check now. With checks on, it looks when it starts and every six hours, and says so on the island when it finds
one. Settings, Updates installs it on a click.

The app reads the latest release from GitHub's public API and installs only the version it showed: if the latest release changed in
between, it refuses and shows the new one instead. It downloads the installer and `SHA256SUMS.txt` from the release's own links into a
new folder under the app's own data, checks the file in memory before writing it, and refuses one that does not match or is over 200 MB.
It then quits and runs the installer silently. The setup exe is run with `/S /UPDATE /R` and the MSI with `AUTOLAUNCHAPP=True`, so the
installer starts the new version itself. A portable copy cannot install itself: Update now opens the release page instead. A restart
ends running agents, so nothing installs without the click.

Every release needs an entry in `apps/desktop/src/lib/whats-new.ts` keyed by its version. The app shows it once after updating, and in
Settings, Updates. Nothing needs signing in while the repository is public. If it goes private again, the app falls back
to the GitHub CLI, which then has to be signed in on each PC with `gh auth login`. See `docs/DECISIONS.md`, D52 and D62.

Copies from 0.5.0 and earlier update only through `gh`. A PC without it installs the next version once by hand, from the Releases page,
and updates by itself from then on.

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
| Figma | `MERIDIAN_CLIENT_FIGMA`, `MERIDIAN_SECRET_FIGMA` |

The other 15 services register themselves, and need nothing.

Google caps an unverified app at 100 new users. Google requires verification of a published
app for `gmail.readonly`, including a security assessment, so plan for weeks.
