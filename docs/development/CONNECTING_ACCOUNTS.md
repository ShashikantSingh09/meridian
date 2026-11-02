# Connecting services

Settings, Providers lists every service. Most connect with one click: Linear, Notion, Jira and Confluence, ClickUp, monday.com,
Todoist, Airtable, Granola, Intercom, Sentry, Vercel, Canva, Dropbox, Stripe and PayPal all register Meridian themselves over
MCP and ask you to sign in on their own site. Nothing is needed from you, and read-only scopes are requested where the vendor
offers them. On 2026-11-01 the real flow reached each of these sign-in pages, which needs no account. No account has finished one yet,
so treat each first sign-in as the real test. `cargo test -p mcp --test live_connect -- --ignored --nocapture` repeats the check.

Some vendors accept only registered apps: Slack, Asana, HubSpot, Box, Figma and Google Drive need a client ID from a registration,
built into the release. GitHub also takes a personal access token: read-only scopes are enough.

What a service returns stays in memory, shows in that row, and is never sent to an AI. Disconnect removes the token.

The rest of this page covers mail and calendars, which use their own connectors because they also feed My day.

# Gmail and Google Calendar with no registration

With no registered Google app, both go through the user's own Claude account, so nobody needs Google Cloud access. In Providers,
**Connect** opens [Claude's connector page](https://claude.ai/customize/connectors). The user presses Connect there and signs in with
Google. Claude Code has to be signed in to the same account on this PC. See `docs/DECISIONS.md`, D60.

Then they ask the assistant, by voice or in chat. Each question starts a short run of Claude Code of its own, usually 7 to 15 seconds, with
only that service loaded and only its reading tools. Nothing is synced, so My day is not fed, and mail raises no alerts. Mail and events
read this way go through Claude, and this route ignores Google's token rules below because Claude holds the sign-in.
`crates/agent-adapters/src/google.rs` is the whole of it, and the ignored test there runs one real read.

# Connecting Gmail, Google Calendar and Outlook

Meridian reads mail and calendars through Google's and Microsoft's official APIs, with read-only permission. Each provider requires
one app registration by whoever publishes Meridian. It is free, and it is done once. After that the ID is built into every release,
and each user only clicks Connect and signs in on the provider's own page.

Until then Outlook says it is not available, and Gmail and Google Calendar use the route above. **Paste an email** in My Day runs the
same extraction on anything you paste, and reminders you add work without any account.

## Google: Gmail and Google Calendar

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project called Meridian.
2. Under APIs and services, enable the **Gmail API** and the **Google Calendar API**.
3. Under Google Auth Platform, Branding, name the app Meridian and add your email address.
4. Under Audience, choose **External**, then **Publish app** so its status is **In production**.
5. Under Data access, add the scopes `gmail.readonly` and `calendar.readonly`.
6. Under Clients, create a client of type **Desktop app**, and leave Use this client for an AI-powered agent off. Copy its client ID and
   client secret at once, because [Google shows the secret only then](https://support.google.com/cloud/answer/15549257). A lost one has to be rotated.

**Publish it, and do not leave it in Testing.** Google's refresh tokens last only 7 days in Testing, so you would sign in again every
week. Published but unverified, Google allows personal use by [fewer than 100 users](https://support.google.com/cloud/answer/13464323),
and each user clicks past an unverified app warning (Advanced, then Go to Meridian). The cap counts
[new users in total](https://support.google.com/cloud/answer/7454865), not users at one time.

`gmail.readonly` is a restricted scope, so going past 100 users means Google's verification and a paid security assessment. See
`docs/KNOWN_ISSUES.md`.

## Microsoft: Outlook, Microsoft 365 and Calendar

You need a free [Azure account](https://azure.microsoft.com/pricing/purchase-options/azure-account), which comes with a directory to
register the app in.

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open Entra ID, App registrations, New registration.
2. Name it Meridian, and under Supported account types choose **Any Entra ID Tenant + Personal Microsoft accounts**.
3. Under Authentication, add a platform: **Mobile and desktop applications**, with the custom redirect URI `http://localhost`. Microsoft
   ignores the port on a `localhost` redirect, which is what lets each sign-in use a random one.
4. In the same page, turn on **Allow public client flows**.
5. Under API permissions, add delegated Microsoft Graph permissions: `Mail.Read`, `Calendars.Read`, `offline_access`, `User.Read`.
6. Copy the **Application (client) ID** from Overview. There is no secret.

A work or school account may need an administrator's consent, depending on the tenant's policy.

## Teams

Teams meetings already come through Outlook, with their join link, for any Microsoft account. Reading Teams chats is a different
matter: Microsoft Graph supports it for work and school accounts only, and not for personal accounts. It needs `Chat.Read`, which does
not need an administrator's consent by Microsoft's default, though a tenant can require it.

## Putting the IDs in

Put them in `.oauth.local` at the top of the repository, which git ignores:

```
MERIDIAN_GOOGLE_CLIENT_ID=...
MERIDIAN_GOOGLE_CLIENT_SECRET=...
MERIDIAN_MICROSOFT_CLIENT_ID=...
```

`gh secret set -f .oauth.local` then gives them to the release build. These are read when the app compiles, so a build has to come after
this. Google says a desktop app's secret cannot stay confidential, and the sign-in does not depend on it staying so: PKCE proves who
asked. It still does not belong in the repository.

To try them on one PC first, set the same three variables in the shell and run `npx tauri build --no-bundle` in `apps/desktop`.

## What happens after connecting

- Tokens are stored in Windows Credential Manager, split across entries because one entry holds only 1,280 characters.
- Mail and calendars sync every 15 minutes, unless monitoring is paused.
- The first mail sync looks back 90 days, at most 500 messages, filtered to likely bookings and orders.
- Mail is read on this PC. Nothing is sent to an AI provider by this process.
- **Disconnect** removes the tokens and the events owned by that account. A booking seen in two accounts is one row, so it
  can go too. See `docs/KNOWN_ISSUES.md`.

The redirect rules above come from each provider's documentation. This flow has been tested against canned server responses
only: no real Google or Microsoft account has been connected yet, so treat the first real sign-in as the real test.
