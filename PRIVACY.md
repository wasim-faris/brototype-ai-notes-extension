# Privacy Policy — Brototype AI Notes

_Last updated: 30 August 2026_

Brototype AI Notes is a Chrome extension that turns the task list on your Brototype task page into
study notes in your own Notion workspace. This page explains exactly what data the extension
handles, where it goes, and what is kept.

## What the extension reads

- **The numbered task list on the Brototype page you have open** — task titles and subtopic
  titles only. It is read when you open the extension's panel on that page (or press *Rescan*),
  never in the background and never on any other website. The extension has no access to tabs
  outside `brototype.com`.
- **Nothing else from the page**: no answers you typed, no personal details, no other content.
- **No browsing history.** The extension does not request the `tabs` permission.

## Where data goes

| Data | Sent to | Why | Kept? |
|---|---|---|---|
| Task titles and subtopic titles | The extension's backend server, which forwards them to the AI provider (OpenRouter) | To generate the study notes | Not by the backend. The AI provider's own retention policy applies to prompts ([OpenRouter privacy](https://openrouter.ai/privacy)). |
| Generated notes | Your Notion workspace, via Notion's API | To create your study pages | In your Notion, under your control |
| A one-time Notion sign-in code | The backend server, which exchanges it with Notion for an access token | To connect your Notion account without exposing a secret | No — exchanged and returned immediately |
| Your Notion access token | Stored **only** in your Chrome profile (`chrome.storage.local`); sent only to `api.notion.com` | To write to your Notion | Until you press *Disconnect*, uninstall, or revoke access in Notion → Settings → Connections |
| Your chosen destination page and settings | Stored only in your Chrome profile | Convenience | Until you change or reset them |

The backend keeps **no accounts, no sessions, no database and no user data**. Its logs record the
request method, path, status code and duration — never request contents, tokens or Notion data.

## What the extension does not do

- It does not collect analytics, telemetry or crash reports.
- It does not sell, share or use your data for advertising or for any purpose other than
  generating your notes.
- It does not run any remote code; all code ships inside the extension package.

## Your choices

- **Disconnect Notion** (Notion tab) removes the token from your browser. Nothing in Notion is
  deleted.
- **Revoke** the integration at any time from Notion → Settings → Connections.
- **Reset all settings** (Settings → Advanced) clears everything the extension stored.
- Uninstalling the extension removes all its local storage.

## Notion permissions requested

Read content, insert content and update content — enough to list the pages you tick during
sign-in, create pages, and add or replace notes inside them. No access to your Notion user profile
beyond the workspace name shown in the extension.

## Contact

Questions about this policy: open an issue on the project repository.
