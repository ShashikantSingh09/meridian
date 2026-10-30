# activity

Unified events for Meridian: extraction from mail, a SQLite store, notification decisions and read-only Google and Microsoft sync. No Tauri here. The app owns the timer, the browser and the credential vault.

## What the user must supply

**Google:** a Cloud project with the Gmail and Calendar APIs enabled, a consent screen listing `gmail.readonly` and `calendar.readonly`, and an OAuth client of type *Desktop app*. Pass both the client id and secret; the secret is not confidential in this flow. While the consent screen is in Testing, Google expires refresh tokens after 7 days. `gmail.readonly` is a restricted scope, so a public release needs Google's verification.

**Microsoft:** an Entra app registration for personal and work accounts, platform *Mobile and desktop*, redirect URI `http://127.0.0.1` (added in the manifest), and delegated `Mail.Read`, `Calendars.Read`, `offline_access`, `User.Read`. Client id only, no secret.

## Connecting

```rust
let oauth = OAuthConfig::google(client_id, Some(client_secret)); // or OAuthConfig::microsoft(client_id)
let flow = LoopbackFlow::start(&oauth).await?;
open_in_browser(flow.authorize_url());
let code = flow.wait_for_code(Duration::from_secs(300)).await?;
let tokens = exchange_code(&oauth, &code).await?;
```

Implement `TokenStore` on Credential Manager. `account` is your key for tokens and rows, so use the email: save under a temporary key, call `profile()`, save under the email, delete the temporary key, then `store.save_account(..)`. A Credential Manager blob holds 2560 bytes and Microsoft tokens can exceed that, so split the value across entries or keep only the refresh token.

## Syncing

```rust
let tokens: Arc<dyn TokenStore> = Arc::new(my_store);
let session = |base| Session::new(base, oauth.clone(), &email, tokens.clone());
let gmail = Gmail::new(session(accounts::gmail::BASE_URL)?);
let calendar = GoogleCalendar::new(session(accounts::google_calendar::BASE_URL)?);
let summary = sync_google(&gmail, &calendar, &store, &SyncOptions::default(), Utc::now()).await;
// Microsoft: sync_microsoft(&Graph::new(session(accounts::graph::BASE_URL)?), &store, &options, now)
```

Call it from your timer. A sync resumes from saved cursors. `summary.failures` is per resource: on `Error::RateLimited { retry_after }` back off, on `Error::ReauthRequired` ask the user to reconnect. `disconnect(&store, tokens.as_ref(), &email)` removes tokens and every row.

## Notifying

```rust
let now = Local::now().fixed_offset(); // the offset is what quiet hours are read against
let events = store.list(&EventFilter::default(), now)?;
let decision = decide(&events, now, &preferences, &context, &store.notification_log()?);
show(&decision.surface); centre(&decision.activity_centre); island(decide_island(&decision, &context));
store.record_decision(&decision, now.to_utc())?; // record both lists, or stages fire twice
```

A `Reminder` with `replaces` takes the place of that key in the UI. `hold` means it may still surface later.

## Store

`Store::open(path)` or `Store::in_memory()`. `upsert` for anything: the app builds desktop, media and reminder events with `ContextEvent::new`. `list(&EventFilter, now)`, `today(now)`, `upcoming(now)`, `correct`, `dismiss`, `snooze`, `delete`, `delete_account`, `purge(before, now)`.

## The event JSON

camelCase. Times are `{"kind":"date|naive|zoned","value":...}`: `naive` has no zone and is not an instant. `Reminder.approximateTime` flags a countdown read on the user's own clock. A date-only `endsAt` is the last day included. `metadata.extractedBy` says which reader produced an item. A flight key is `flight:{ref}:{FROM-TO}`, so each leg is its own event.

## Trust

Extraction believes the mail and does not check SPF or DKIM, so a spoofed message can create an event and a link. Only http(s) URLs reach a button, and Join needs https. Titles come from senders: treat them as untrusted text before putting them in a model prompt.
