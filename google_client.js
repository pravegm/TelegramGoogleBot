import "dotenv/config";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { google } from "googleapis";

const GOOGLE_CREDS_DIR = process.env.GOOGLE_CREDS_DIR || join(homedir(), ".google-mcp");
const TOKEN_DIR = join(GOOGLE_CREDS_DIR, "tokens");
const CREDS_PATH = join(GOOGLE_CREDS_DIR, "credentials.json");
const TIMEZONE = process.env.TIMEZONE || "UTC";

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

  const headers = [`To: ${to}`];
  if (cc) headers.push(`Cc: ${cc}`);
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${subject}`);
  headers.push("Content-Type: text/plain; charset=utf-8");
  const lines = [...headers, "", body].join("\r\n");

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

export async function createEvent(account, summary, startTime, endTime, description = "", location = "", attendees = []) {
  const cal = google.calendar({ version: "v3", auth: getAuth(account) });
  const body = {
    summary,
    start: { dateTime: startTime, timeZone: TIMEZONE },
    end: { dateTime: endTime, timeZone: TIMEZONE },
    description,
    location,
  };
  if (attendees.length) body.attendees = attendees.map((e) => ({ email: e }));
  const res = await cal.events.insert({
    calendarId: "primary",
    requestBody: body,
    sendUpdates: attendees.length ? "all" : "none",
  });
  return res.data;
}

// --------------- Drive ---------------

export async function listFiles(account, maxResults = 15) {
  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  const res = await drive.files.list({
    q: "trashed = false",
    pageSize: maxResults,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
  });
  return res.data.files || [];
}

export async function searchFiles(account, query, maxResults = 15) {
  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  try {
    const res = await drive.files.list({
      q: `(name contains '${escaped}' or fullText contains '${escaped}') and trashed = false`,
      pageSize: maxResults,
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,parents)",
    });
    return res.data.files || [];
  } catch {
    const res = await drive.files.list({
      q: `name contains '${escaped}' and trashed = false`,
      pageSize: maxResults,
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,parents)",
    });
    return res.data.files || [];
  }
}

const folderTreeCounter = { count: 0 };
const FOLDER_TREE_MAX_ITEMS = 500;

export async function listFolderTree(account, folderId = "root", depth = 0, maxDepth = 3) {
  if (depth === 0) folderTreeCounter.count = 0;
  if (folderTreeCounter.count >= FOLDER_TREE_MAX_ITEMS) return [{ name: "(truncated -- too many items)", type: "notice" }];

  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    pageSize: 50,
    fields: "files(id,name,mimeType)",
    orderBy: "name",
  });

  const items = [];
  for (const f of res.data.files || []) {
    if (folderTreeCounter.count >= FOLDER_TREE_MAX_ITEMS) {
      items.push({ name: `(${(res.data.files.length - items.length)} more items truncated)`, type: "notice" });
      break;
    }
    folderTreeCounter.count++;
    const isFolder = f.mimeType === "application/vnd.google-apps.folder";
    const entry = { name: f.name, id: f.id, type: isFolder ? "folder" : "file" };
    if (isFolder && depth < maxDepth) {
      entry.children = await listFolderTree(account, f.id, depth + 1, maxDepth);
    }
    items.push(entry);
  }
  return items;
}

export async function moveFile(account, fileId, newParentId) {
  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  const file = await drive.files.get({ fileId, fields: "parents" });
  const previousParents = (file.data.parents || []).join(",");
  const res = await drive.files.update({
    fileId,
    addParents: newParentId,
    removeParents: previousParents,
    fields: "id,name,parents",
  });
  return res.data;
}

export async function renameFile(account, fileId, newName) {
  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  const res = await drive.files.update({
    fileId,
    requestBody: { name: newName },
    fields: "id,name",
  });
  return res.data;
}

export async function createFolder(account, name, parentId = "root") {
  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id,name,webViewLink",
  });
  return res.data;
}

export async function deleteFile(account, fileId) {
  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  await drive.files.delete({ fileId });
  return { deleted: true };
}

export async function copyFile(account, fileId, newName) {
  const drive = google.drive({ version: "v3", auth: getAuth(account) });
  const body = {};
  if (newName) body.name = newName;
  const res = await drive.files.copy({
    fileId,
    requestBody: body,
    fields: "id,name,webViewLink",
  });
  return res.data;
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

export async function createDocument(account, title, body = "") {
  const docs = google.docs({ version: "v1", auth: getAuth(account) });
  const res = await docs.documents.create({ requestBody: { title } });
  const docId = res.data.documentId;
  if (body) {
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{ insertText: { location: { index: 1 }, text: body } }],
      },
    });
  }
  return { id: docId, title, url: `https://docs.google.com/document/d/${docId}/edit` };
}

export async function appendToDocument(account, docId, text) {
  const docs = google.docs({ version: "v1", auth: getAuth(account) });
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [{ insertText: { endOfSegmentLocation: {}, text: "\n" + text } }],
    },
  });
  return { appended: true, docId };
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
    sendUpdates: updates.attendees ? "all" : "none",
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

export async function appendToSheet(account, spreadsheetId, range = "Sheet1", rows) {
  const sheets = google.sheets({ version: "v4", auth: getAuth(account) });
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
  return { updatedRows: res.data.updates?.updatedRows || 0, updatedRange: res.data.updates?.updatedRange || "" };
}

export async function updateSheetCells(account, spreadsheetId, range, values) {
  const sheets = google.sheets({ version: "v4", auth: getAuth(account) });
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  return { updatedCells: res.data.updatedCells || 0, updatedRange: res.data.updatedRange || "" };
}

export async function createSpreadsheet(account, title) {
  const sheets = google.sheets({ version: "v4", auth: getAuth(account) });
  const res = await sheets.spreadsheets.create({
    requestBody: { properties: { title } },
  });
  return { id: res.data.spreadsheetId, title, url: res.data.spreadsheetUrl };
}
