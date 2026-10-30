# Connecting Gmail, Outlook and calendars

Meridian reads mail and calendars through Google's and Microsoft's official APIs, with read-only permission. Each provider
requires an app registration, and that registration has to be yours: this repository ships no client ID. Both are free.

Until you do this, **Paste an email** in My Day runs the same extraction on anything you paste, and reminders you add work
without any account.

## Google: Gmail and Google Calendar

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project.
2. Under APIs and services, enable the **Gmail API** and the **Google Calendar API**.
3. Configure the OAuth consent screen as External, and add your own address as a test user.
4. Add the scopes `gmail.readonly` and `calendar.readonly`.
5. Under Credentials, create an **OAuth client ID** of type **Desktop app**.
6. In Meridian, open Settings, Connected accounts. Paste the client ID and client secret, then choose Connect Google.

Sign-in happens in your browser, on Google's own page.

**Expect to reconnect weekly while the app is in Testing.** Google's documentation says an External app in Testing status gets
refresh tokens that expire in 7 days. Publishing removes that, but `gmail.readonly` is a restricted scope, so a published app needs Google's
verification. For one person's use, Testing is the practical choice.

## Microsoft: Outlook, Microsoft 365 and Calendar

1. In the [Microsoft Entra admin center](https://entra.microsoft.com/), open App registrations and create a new one.
2. Choose accounts in any organizational directory and personal Microsoft accounts.
3. Add a platform: **Mobile and desktop applications**, with the custom redirect URI `http://localhost`. Microsoft ignores the
   port on a `localhost` redirect, which is what lets each sign-in use a random one.
4. Under API permissions, add delegated permissions: `Mail.Read`, `Calendars.Read`, `offline_access`, `User.Read`.
5. Copy the **Application (client) ID** into Settings, Connected accounts, then choose Connect Microsoft.

A work or school account may need an administrator's consent, depending on the tenant's policy.

## What happens after connecting

- Tokens are stored in Windows Credential Manager, split across entries because one entry holds only 1,280 characters.
- Mail and calendars sync every 15 minutes, unless monitoring is paused.
- The first mail sync looks back 90 days, at most 500 messages, filtered to likely bookings and orders.
- Mail is read on this PC. Nothing is sent to an AI provider by this process.
- **Disconnect** removes the tokens and the events owned by that account. A booking seen in two accounts is one row, so it
  can go too. See `docs/KNOWN_ISSUES.md`.

The redirect rules above come from each provider's documentation. This flow has been tested against canned server responses
only: no real Google or Microsoft account has been connected yet, so treat the first real sign-in as the real test.
