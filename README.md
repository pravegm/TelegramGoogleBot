# Telegram Google Bot

A personal assistant Telegram bot that connects to Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks) and provides intelligent responses powered by Gemini.

## Features

- **Gmail** -- list, read, search, send, reply, archive, and trash emails
- **Google Calendar** -- list, create, update, and delete events
- **Google Drive** -- list, search, move, rename, copy, and delete files; create folders; browse folder tree
- **Google Docs** -- read, create, and append to documents
- **Google Sheets** -- read, create, append rows, and update cells
- **Google Tasks** -- list, create, complete, update, and delete tasks
- **Delivery Tracking** -- scans emails for delivery/parcel updates across multiple accounts
- **Voice Notes** -- transcribes voice messages and responds
- **Web Search** -- answers general knowledge questions via Google Search grounding
- **Scheduled Updates** -- daily delivery briefing (8am), world news (1pm), AI news (7pm)
- **Multi-account** -- supports two Google accounts, switchable via commands
- **Conversation Memory** -- rolling summarization to maintain context across messages

## Models

- **Gemini 3 Flash Preview** (with thinking) -- user-facing chat and tool calling
- **Gemini 2.5 Flash Lite** -- background tasks (summarization, transcription, scheduled updates)

## Setup

### Prerequisites

- Node.js v18+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Google Cloud project with Gmail, Calendar, Drive, Docs, Sheets, and Tasks APIs enabled
- Google OAuth2 credentials (Desktop app type)
- A Gemini API key

### Installation

```bash
npm install
```

### Configuration

Create a `.env` file:

```
BOT_TOKEN=your_telegram_bot_token
GEMINI_API_KEY=your_gemini_api_key
ALLOWED_USER_ID=your_telegram_user_id
```

Place your Google OAuth credentials at `~/.google-mcp/credentials.json` and account tokens at `~/.google-mcp/tokens/account1.json` (and optionally `account2.json`).

### Running

```bash
node bot.js
```

For background execution on Windows, use the included `start-bot.vbs` (place in Startup folder for auto-launch). Output is logged to `bot.log`.

## Bot Commands

- `/start` -- welcome message
- `/account1` -- switch to Google account 1
- `/account2` -- switch to Google account 2
- `/clear` -- reset conversation history

## License

MIT
