import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { google } from "googleapis";

const TOKEN_DIR = join(homedir(), ".google-mcp", "tokens");
const CREDS_PATH = join(homedir(), ".google-mcp", "credentials.json");

function loadCredentials() {
  const raw = JSON.parse(readFileSync(CREDS_PATH, "utf-8"));
  return raw.installed || raw.web;
}

function buildAuth(accountName) {
  const creds = loadCredentials();
  const tokenPath = join(TOKEN_DIR, `${accountName}.json`);
  const token = JSON.parse(readFileSync(tokenPath, "utf-8"));

  const auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris?.[0] || "http://localhost"
  );

  auth.setCredentials({
    refresh_token: token.refresh_token,
  });

  return auth;
}

const authCache = {};

function getAuth(account) {
  if (!authCache[account]) {
    authCache[account] = buildAuth(account);
  }
  return authCache[account];
}

// --------------- Gmail ---------------

export async function listEmails(account, query = "is:unread", maxResults = 10) {
  const gmail = google.gmail({ version: "v1", auth: getAuth(account) });
  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });

  if (!res.data.messages?.length) return [];

  const emails = await Promise.all(
    res.data.messages.map(async (m) => {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: m.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      const headers = msg.data.payload.headers;
      const get = (name) => headers.find((h) => h.name === name)?.value || "";
      return {
        id: m.id,
        from: get("From"),
        subject: get("Subject"),
        date: get("Date"),
        snippet: msg.data.snippet,
      };
    })
  );

  return emails;
}

function extractPartsRecursive(payload) {
  const results = { plain: "", html: "", links: [] };

  function walk(part) {
    if (part.parts) {
      for (const child of part.parts) walk(child);
      return;
    }
    if (part.body?.data) {
      const decoded = Buffer.from(part.body.data, "base64").toString("utf-8");
      if (part.mimeType === "text/plain" && !results.plain) {
        results.plain = decoded;
      } else if (part.mimeType === "text/html" && !results.html) {
        results.html = decoded;
      }
    }
  }

  walk(payload);

  if (results.html) {
    const hrefRegex = /href=["']?(https?:\/\/[^\s"'<>]+)/gi;
    let match;
    while ((match = hrefRegex.exec(results.html)) !== null) {
      results.links.push(match[1]);
    }
  }

  return results;
}

export async function readEmail(account, messageId) {
  const gmail = google.gmail({ version: "v1", auth: getAuth(account) });
  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = msg.data.payload.headers;
  const get = (name) => headers.find((h) => h.name === name)?.value || "";

  const extracted = extractPartsRecursive(msg.data.payload);

  let body = extracted.plain;
  if (!body && extracted.html) {
    body = extracted.html.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ");
  }

  return {
    from: get("From"),
    to: get("To"),
    subject: get("Subject"),
    date: get("Date"),
    body: body.slice(0, 5000),
    links: extracted.links,
  };
}

export async function sendEmail(account, to, subject, body, cc = "", bcc = "") {
  const gmail = google.gmail({ version: "v1", auth: getAuth(account) });

  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : "",
    bcc ? `Bcc: ${bcc}` : "",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ]
    .filter(Boolean)
    .join("\r\n");

  const raw = Buffer.from(lines).toString("base64url");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });

  return res.data;
}

export async function searchEmails(account, query, maxResults = 10) {
  return listEmails(account, query, maxResults);
}

// --------------- Calendar ---------------

export async function listEvents(account, timeMin, timeMax, maxResults = 15) {
  const cal = google.calendar({ version: "v3", auth: getAuth(account) });
  const res = await cal.events.list({
    calendarId: "primary",
    timeMin: timeMin || new Date().toISOString(),
    timeMax: timeMax || new Date(Date.now() + 86400000).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults,
  });

  return (res.data.items || []).map((e) => ({
    id: e.id,
    summary: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    location: e.location || "",
    description: (e.description || "").slice(0, 200),
  }));
}

export async function createEvent(account, summary, startTime, endTime, description = "", location = "") {
  const cal = google.calendar({ version: "v3", auth: getAuth(account) });
  const res = await cal.events.insert({
    calendarId: "primary",
    requestBody: {
      summary,
      start: { dateTime: startTime, timeZone: "Europe/London" },
      end: { dateTime: endTime, timeZone: "Europe/London" },
      description,
      location,
    },
  });
  return res.data;
}

// --------------- Drive ---------------

export async function listFiles(account, maxResults = 15) {
  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  const res = await drive.files.list({
    pageSize: maxResults,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  return res.data.files || [];
}

export async function searchFiles(account, query, maxResults = 15) {
  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  const res = await drive.files.list({
    q: `fullText contains '${query.replace(/'/g, "\\'")}'`,
    pageSize: maxResults,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  return res.data.files || [];
}

// --------------- Docs ---------------

export async function readDoc(account, docId) {
  const docs = google.docs({ version: "v1", auth: getAuth(account) });
  const res = await docs.documents.get({ documentId: docId });
  let text = "";
  for (const el of res.data.body?.content || []) {
    if (el.paragraph) {
      for (const elem of el.paragraph.elements || []) {
        text += elem.textRun?.content || "";
      }
    }
  }
  return { title: res.data.title, body: text.slice(0, 3000) };
}

// --------------- Gmail Actions ---------------

export async function replyToEmail(account, messageId, body) {
  const gmail = google.gmail({ version: "v1", auth: getAuth(account) });
  const original = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "To", "Subject", "Message-ID", "References", "In-Reply-To"],
  });

  const headers = original.data.payload.headers;
  const get = (name) => headers.find((h) => h.name === name)?.value || "";

  const replyTo = get("From");
  const subject = get("Subject").startsWith("Re:") ? get("Subject") : `Re: ${get("Subject")}`;
  const msgId = get("Message-ID");
  const refs = [get("References"), msgId].filter(Boolean).join(" ");

  const lines = [
    `To: ${replyTo}`,
    `Subject: ${subject}`,
    `In-Reply-To: ${msgId}`,
    `References: ${refs}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  const raw = Buffer.from(lines).toString("base64url");
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: original.data.threadId },
  });
  return res.data;
}

export async function archiveEmail(account, messageId) {
  const gmail = google.gmail({ version: "v1", auth: getAuth(account) });
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["INBOX"] },
  });
  return { archived: true };
}

export async function trashEmail(account, messageId) {
  const gmail = google.gmail({ version: "v1", auth: getAuth(account) });
  await gmail.users.messages.trash({ userId: "me", id: messageId });
  return { trashed: true };
}

// --------------- Calendar Actions ---------------

export async function deleteEvent(account, eventId) {
  const cal = google.calendar({ version: "v3", auth: getAuth(account) });
  await cal.events.delete({ calendarId: "primary", eventId });
  return { deleted: true };
}

export async function updateEvent(account, eventId, updates) {
  const cal = google.calendar({ version: "v3", auth: getAuth(account) });
  const res = await cal.events.patch({
    calendarId: "primary",
    eventId,
    requestBody: updates,
  });
  return res.data;
}

// --------------- Tasks ---------------

export async function listTaskLists(account) {
  const tasks = google.tasks({ version: "v1", auth: getAuth(account) });
  const res = await tasks.tasklists.list({ maxResults: 20 });
  return (res.data.items || []).map((tl) => ({ id: tl.id, title: tl.title }));
}

export async function listTasks(account, taskListId = "@default", showCompleted = false) {
  const tasks = google.tasks({ version: "v1", auth: getAuth(account) });
  const res = await tasks.tasks.list({
    tasklist: taskListId,
    maxResults: 100,
    showCompleted,
    showHidden: false,
  });
  return (res.data.items || []).map((t) => ({
    id: t.id,
    title: t.title,
    notes: t.notes || "",
    status: t.status,
    due: t.due || null,
    parent: t.parent || null,
  }));
}

export async function createTask(account, taskListId = "@default", title, notes = "", due = "") {
  const tasks = google.tasks({ version: "v1", auth: getAuth(account) });
  const body = { title };
  if (notes) body.notes = notes;
  if (due) body.due = new Date(due).toISOString();
  const res = await tasks.tasks.insert({ tasklist: taskListId, requestBody: body });
  return { id: res.data.id, title: res.data.title, status: res.data.status };
}

export async function completeTask(account, taskListId = "@default", taskId) {
  const tasks = google.tasks({ version: "v1", auth: getAuth(account) });
  const res = await tasks.tasks.patch({
    tasklist: taskListId,
    task: taskId,
    requestBody: { status: "completed" },
  });
  return { id: res.data.id, title: res.data.title, status: res.data.status };
}

export async function updateTask(account, taskListId = "@default", taskId, updates) {
  const tasks = google.tasks({ version: "v1", auth: getAuth(account) });
  const res = await tasks.tasks.patch({
    tasklist: taskListId,
    task: taskId,
    requestBody: updates,
  });
  return { id: res.data.id, title: res.data.title, status: res.data.status, notes: res.data.notes || "" };
}

export async function deleteTask(account, taskListId = "@default", taskId) {
  const tasks = google.tasks({ version: "v1", auth: getAuth(account) });
  await tasks.tasks.delete({ tasklist: taskListId, task: taskId });
  return { deleted: true };
}

// --------------- Sheets ---------------

export async function readSheet(account, spreadsheetId, range = "Sheet1") {
  const sheets = google.sheets({ version: "v4", auth: getAuth(account) });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  return res.data.values || [];
}
