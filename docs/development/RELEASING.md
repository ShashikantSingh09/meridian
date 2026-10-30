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
| `latest.json` | The update feed, only once an update signing key is set |

To try a build without publishing anything, open the Actions tab, choose Release, and press Run workflow. The files stay on that
run for 7 days. Commit your work first: the script refuses to run with uncommitted changes.

This repository is private, so its releases can be downloaded only by people with access to it.

## What the workflow needs

Nothing, for a working unsigned build. These optional secrets, set under Settings, Secrets and variables, Actions, turn more on:

| Secret | What it turns on |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `MERIDIAN_UPDATE_PUBKEY`, `MERIDIAN_UPDATE_URL` | Automatic updates |
| The `MERIDIAN_CLIENT_*`, `MERIDIAN_SECRET_*` and Google and Microsoft IDs listed under Customer sign-in | Sign-in for those services |

## One-time setup

1. Generate the update signing key, once, and keep it out of the repository:
   ```powershell
   npx tauri signer generate -w $HOME\.meridian\update.key
   ```
   Back it up. Losing it means installed copies can never be updated again.
2. Choose a public address for update metadata. A private GitHub repository will not work, because its release files need a
   login.
3. Get a code-signing certificate. Without one, Windows SmartScreen warns every customer.

## Building by hand

1. Set the version in `apps/desktop/src-tauri/tauri.conf.json`, both `package.json` files and the workspace `Cargo.toml`.
2. Build, from `apps/desktop`:
   ```powershell
   $env:MERIDIAN_UPDATE_PUBKEY = "<contents of update.key.pub>"
   $env:MERIDIAN_UPDATE_URL = "https://your-host/meridian/latest.json"
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $HOME\.meridian\update.key -Raw
   npx tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'
   ```
3. Publish the installer and a `latest.json` next to it:
   ```json
   {
     "version": "0.2.0",
     "notes": "What changed.",
     "platforms": { "windows-x86_64": { "signature": "<contents of the .sig file>", "url": "https://your-host/meridian/Meridian_0.2.0_x64-setup.exe" } }
   }
   ```

Installed copies check at start and show the update under Settings, About. It installs only on a click.

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
