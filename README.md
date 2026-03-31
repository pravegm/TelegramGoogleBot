# Telegram Google Bot

A personal assistant Telegram bot that connects to Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks) and provides intelligent responses powered by Gemini. Supports multiple Google accounts, voice messages, scheduled briefings, and web search.

## Features

- **Gmail** -- search, read, send, reply, archive, and trash emails
- **Google Calendar** -- list, create, update, and delete events
- **Google Drive** -- search, browse folder tree, move, rename, copy, delete files, create folders
- **Google Docs** -- read, create, and append to documents
- **Google Sheets** -- read, create, append rows, and update cells
- **Google Tasks** -- list task lists, list/create/complete/update/delete tasks
- **Delivery Tracking** -- scans emails for delivery/parcel updates across all accounts
- **Voice Notes** -- transcribes voice messages and responds
- **Web Search** -- answers general knowledge questions via Google Search grounding
- **Scheduled Updates** -- morning email digest + delivery briefing, world news, AI news (all configurable)
- **Multi-account** -- supports any number of Google accounts, switchable via commands
- **Conversation Memory** -- rolling summarization to maintain context across messages

## Quick Start

```bash
git clone https://github.com/pravegm/TelegramGoogleBot.git
cd TelegramGoogleBot
npm install
cp .env.example .env       # then edit .env with your values
node reauth.js account1    # authorize your Google account
node bot.js                # start the bot
```

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Google Cloud](https://console.cloud.google.com/) project
- A [Gemini API key](https://aistudio.google.com/apikey)

### 2. Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project (or use an existing one)
2. Enable these APIs under **APIs & Services > Library**:
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - Google Docs API
   - Google Sheets API
   - Google Tasks API
3. Set up the **OAuth consent screen** (APIs & Services > OAuth consent screen):
   - Choose **External** user type
   - Fill in app name and support email
   - Add your Gmail address(es) as **test users**
   - No need to publish -- "Testing" status works fine for personal use
4. Go to **APIs & Services > Credentials**
5. Click **Create Credentials > OAuth client ID**
6. Select **Desktop app** as the application type
7. Download the JSON file and save it as `~/.google-mcp/credentials.json`
   
   On macOS/Linux: `mkdir -p ~/.google-mcp && mv ~/Downloads/client_secret_*.json ~/.google-mcp/credentials.json`
   
   On Windows: save to `C:\Users\<you>\.google-mcp\credentials.json`

### 3. Configure Environment

Copy the example and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token from BotFather |
| `GEMINI_API_KEY` | Yes | Google AI Studio API key |
| `ALLOWED_USER_ID` | Yes | Your Telegram user ID (send `/start` to [@userinfobot](https://t.me/userinfobot)) |
| `USER_NAME` | No | Your name (used in greetings and prompts, default: "User") |
| `TIMEZONE` | No | IANA timezone (e.g. `America/New_York`, default: `UTC`) |
| `GOOGLE_ACCOUNTS` | No | Comma-separated account names (default: `account1`) |
| `GOOGLE_CREDS_DIR` | No | Path to credentials directory (default: `~/.google-mcp`) |
| `SCHEDULE_MORNING` | No | Cron schedule for morning briefing (default: `0 8 * * *`) |
| `SCHEDULE_NEWS` | No | Cron schedule for world news (default: `0 13 * * *`) |
| `SCHEDULE_AI_NEWS` | No | Cron schedule for AI news (default: `0 19 * * *`) |

### 4. Authorize Google Accounts

For each account listed in `GOOGLE_ACCOUNTS`, run:

```bash
node reauth.js account1
```

This prints a Google OAuth URL. Open it in your browser, sign in, and grant access. The token is saved automatically to `~/.google-mcp/tokens/account1.json`.

For multiple accounts:

```bash
node reauth.js account1    # sign in with first Google account
node reauth.js account2    # sign in with second Google account
```

Then set `GOOGLE_ACCOUNTS=account1,account2` in your `.env`.

**Troubleshooting auth:**
- "Something went wrong" -- make sure you've set up the OAuth consent screen (step 2.3) and added yourself as a test user
- "Access blocked" -- your app is in testing mode, add the Gmail address as a test user in the consent screen settings
- No refresh token -- revoke access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and re-run `reauth.js`

### 5. Run

```bash
node bot.js
```

The bot validates all configuration on startup and will tell you exactly what's missing.

### Background Execution (Windows)

Place `start-bot.vbs` in your Windows Startup folder (`shell:startup`). It runs the bot silently and logs output to `bot.log`.

Alternatively, use `run.bat` to run in a visible console window.

## Bot Commands

- `/start` -- welcome message
- `/<accountname>` -- switch active Google account (e.g. `/account1`, `/account2`)
- `/clear` -- reset conversation history

## Architecture

11 consolidated function tools + Google Search:

| Tool | Actions |
|------|---------|
| `search_emails` | Search/list emails with Gmail query syntax |
| `read_email` | Read full email content by ID |
| `manage_email` | send, reply, archive, trash |
| `calendar` | list, create, update, delete |
| `drive_search` | search, list, tree |
| `drive_manage` | move, rename, copy, delete, create_folder |
| `document` | read, create, append |
| `spreadsheet` | read, create, append, update |
| `tasks` | list_lists, list, create, complete, update, delete |
| `switch_account` | Switch active Google account |
| `get_delivery_status` | Scan all accounts for delivery emails |

### Models

- **Gemini 3 Flash Preview** (with thinking) -- user-facing chat and tool calling
- **Gemini 2.5 Flash Lite** -- background tasks (summarization, transcription, scheduled updates)

## License

MIT
