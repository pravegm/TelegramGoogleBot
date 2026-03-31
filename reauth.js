import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { google } from "googleapis";
import { createServer } from "http";

const CREDS_PATH = join(homedir(), ".google-mcp", "credentials.json");
const TOKEN_DIR = join(homedir(), ".google-mcp", "tokens");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/tasks",
];

const accountName = process.argv[2];
if (!accountName) {
  console.error("Usage: node reauth.js <account1|account2>");
  process.exit(1);
}

const creds = JSON.parse(readFileSync(CREDS_PATH, "utf-8")).installed;
const auth = new google.auth.OAuth2(
  creds.client_id,
  creds.client_secret,
  "http://localhost:3456"
);

const url = auth.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent",
});

console.log(`\nOpen this URL in your browser and sign in with ${accountName}:\n`);
console.log(url);
console.log("\nWaiting for authorization...\n");

const server = createServer(async (req, res) => {
  const code = new URL(req.url, "http://localhost:3456").searchParams.get("code");
  if (!code) {
    res.end("No code received.");
    return;
  }

  try {
    const { tokens } = await auth.getToken(code);
    const tokenPath = join(TOKEN_DIR, `${accountName}.json`);
    writeFileSync(tokenPath, JSON.stringify({
      type: "authorized_user",
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: tokens.refresh_token,
    }));
    console.log(`Token saved for ${accountName} at ${tokenPath}`);
    res.end(`Authorization successful for ${accountName}! You can close this tab.`);
  } catch (err) {
    console.error("Error:", err.message);
    res.end("Authorization failed.");
  }

  server.close();
  process.exit(0);
});

server.listen(3456);
