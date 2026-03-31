import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { google } from "googleapis";
import { createServer } from "http";

const GOOGLE_CREDS_DIR = process.env.GOOGLE_CREDS_DIR || join(homedir(), ".google-mcp");
const CREDS_PATH = join(GOOGLE_CREDS_DIR, "credentials.json");
const TOKEN_DIR = join(GOOGLE_CREDS_DIR, "tokens");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/tasks",
];

const REDIRECT_URI = "http://127.0.0.1:3456";

const accountName = process.argv[2];
if (!accountName) {
  console.error("Usage: node reauth.js <accountName>");
  console.error("Example: node reauth.js account1");
  process.exit(1);
}

if (!existsSync(CREDS_PATH)) {
  console.error(`Credentials file not found: ${CREDS_PATH}`);
  console.error("Download your OAuth client JSON from Google Cloud Console and save it there.");
  console.error("See README for full setup instructions.");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
const creds = raw.installed || raw.web;
if (!creds) {
  console.error("Invalid credentials file. Expected 'installed' or 'web' key in JSON.");
  process.exit(1);
}

mkdirSync(TOKEN_DIR, { recursive: true });

const auth = new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);

const url = auth.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

console.log(`\nOpen this URL in your browser and sign in as "${accountName}":\n`);
console.log(url);
console.log("\nWaiting for authorization...\n");

const server = createServer(async (req, res) => {
  const code = new URL(req.url, REDIRECT_URI).searchParams.get("code");
  if (!code) {
    res.end("No code received.");
    return;
  }

  try {
    const { tokens } = await auth.getToken(code);
    if (!tokens.refresh_token) {
      console.error("No refresh token received. Try revoking access at https://myaccount.google.com/permissions and re-running.");
      res.end("Authorization failed: no refresh token. Revoke access and try again.");
      server.close();
      process.exit(1);
    }
    const tokenPath = join(TOKEN_DIR, `${accountName}.json`);
    writeFileSync(tokenPath, JSON.stringify({
      type: "authorized_user",
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: tokens.refresh_token,
    }, null, 2));
    console.log(`Token saved: ${tokenPath}`);
    res.end(`Authorization successful for ${accountName}! You can close this tab.`);
  } catch (err) {
    console.error("Authorization error:", err.message);
    res.end("Authorization failed: " + err.message);
  }

  server.close();
  process.exit(0);
});

server.listen(3456, "127.0.0.1", () => {
  console.log("Listening on http://127.0.0.1:3456 for callback...");
});
