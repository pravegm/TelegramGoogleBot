import "dotenv/config";
import { Bot } from "grammy";
import { GoogleGenAI, Type, ThinkingLevel, FunctionCallingConfigMode } from "@google/genai";
import cron from "node-cron";
import {
  listEmails, readEmail, sendEmail, searchEmails,
  listEvents, createEvent, deleteEvent, updateEvent,
  listFiles, searchFiles, listFolderTree, moveFile, renameFile, createFolder, deleteFile, copyFile,
  readDoc, createDocument, appendToDocument,
  readSheet, appendToSheet, updateSheetCells, createSpreadsheet,
  replyToEmail, archiveEmail, trashEmail,
  listTaskLists, listTasks, createTask, completeTask, updateTask, deleteTask,
} from "./google_client.js";
import { getDeliveryStatus } from "./tracker.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = Number(process.env.ALLOWED_USER_ID);

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const bot = new Bot(BOT_TOKEN);

const MODEL_HEAVY = "gemini-3-flash-preview";
const MODEL_LITE = "gemini-2.5-flash-lite";

function truncateResult(obj, maxLen = 30000) {
  const json = JSON.stringify(obj);
  if (json.length <= maxLen) return obj;

  if (typeof obj === "string") return obj.slice(0, maxLen);

  const arr = Array.isArray(obj) ? obj : (Array.isArray(obj?.result) ? obj.result : null);
  if (arr) {
    let lo = 1, hi = arr.length, best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const slice = arr.slice(0, mid);
      const test = Array.isArray(obj) ? slice : { ...obj, result: slice };
      if (JSON.stringify(test).length <= maxLen) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return Array.isArray(obj) ? arr.slice(0, best) : { ...obj, result: arr.slice(0, best) };
  }

  if (typeof obj === "object" && obj !== null) {
    const copy = { ...obj };
    for (const key of Object.keys(copy)) {
      if (typeof copy[key] === "string" && copy[key].length > 1000) {
        copy[key] = copy[key].slice(0, 1000) + "...";
      }
    }
    return copy;
  }

  return obj;
}

function wrapResult(result) {
  if (Array.isArray(result)) return { result };
  if (result === null || result === undefined) return { result: "done" };
  if (typeof result !== "object") return { result };
  return result;
}

// ==================== Conversation Memory ====================

const conversations = {};

function getConvo(userId) {
  if (!conversations[userId]) {
    conversations[userId] = { account: "account1", history: [], summary: "" };
  }
  return conversations[userId];
}

async function summariseOldMessages(history) {
  const text = history
    .map((m) => {
      const parts = m.parts?.map((p) => p.text || JSON.stringify(p).slice(0, 300)).join(" ") || "";
      return `${m.role}: ${parts}`;
    })
    .join("\n");

  try {
    const res = await genai.models.generateContent({
      model: MODEL_LITE,
      contents: `Summarise this conversation in 3-5 sentences. Focus on: what the user asked for, what was retrieved, preferences expressed, and pending follow-ups.\n\n${text.slice(0, 8000)}`,
      config: { thinkingConfig: { thinkingBudget: 0 } },
    });
    return res.text?.trim() || "";
  } catch {
    return "";
  }
}

async function compactHistory(convo) {
  if (convo.history.length <= 20) return;
  const oldMessages = convo.history.slice(0, -10);
  const newSummary = await summariseOldMessages(oldMessages);
  if (newSummary) {
    convo.summary = convo.summary
      ? `${convo.summary}\n\nMore recent: ${newSummary}`
      : newSummary;
    if (convo.summary.length > 2000) convo.summary = convo.summary.slice(-2000);
  }
  convo.history = convo.history.slice(-10);
}

// ==================== System Prompt ====================

function buildSystemPrompt(account, summary) {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/London",
  });

  let prompt =
    `You are Praveg's personal assistant on Telegram. You're sharp, efficient, and talk like a trusted PA -- not a chatbot.\n\n` +
    `<identity>\n` +
    `- You text like a real person. Short, direct, warm but not cheesy.\n` +
    `- You never say "Here's what I found", "Let me check", "I hope this helps", "Sure!", "Certainly!", "Of course!".\n` +
    `- You never use asterisks, markdown bold/italic, or bullet point symbols (-, *, •).\n` +
    `- You get straight to the point. No preamble. No sign-offs.\n` +
    `</identity>\n\n` +
    `<formatting>\n` +
    `You MUST format replies using Telegram HTML. Available tags:\n` +
    `  <b>bold</b> for emphasis, labels, or headings\n` +
    `  <i>italic</i> for secondary info, dates, or subtle notes\n` +
    `  <code>code</code> for IDs, tracking numbers, or technical values\n` +
    `  <a href="url">text</a> for links\n\n` +
    `Structure rules:\n` +
    `  - Use <b>labels</b> to create visual sections, not bullet points.\n` +
    `  - Separate items with blank lines, never with dashes or bullets.\n` +
    `  - Keep it scannable on a phone screen.\n` +
    `  - Never output raw JSON, raw field names, or data dumps.\n` +
    `  - Synthesise information. "3 unread -- Sarah about the meeting, Amazon delivery update, Waitrose receipt" is better than listing every field.\n` +
    `  - For single items, flow naturally: "Your Evri parcel is at the local depot, should arrive tomorrow."\n` +
    `  - For multiple items, use this pattern:\n\n` +
    `    <b>Tomorrow's meetings</b>\n` +
    `    10:00 -- Team standup\n` +
    `    14:30 -- Client call with Sarah\n\n` +
    `    <b>Pending deliveries</b>\n` +
    `    Temu order -- out for delivery today\n` +
    `    ASOS return -- collected yesterday\n\n` +
    `  - Use <i>timestamps</i> and <i>dates</i> in natural language: "tomorrow at 3pm" not "2026-03-28T15:00:00Z"\n` +
    `</formatting>\n\n` +
    `<behaviour>\n` +
    `- Active Google account: ${account}. Use this unless Praveg mentions the other one.\n` +
    `- Both accounts are available: account1 and account2.\n` +
    `- Today is ${today}. Timezone: Europe/London.\n` +
    `- When asked about deliveries, call the get_delivery_status tool. It checks BOTH accounts for delivery emails. Present the results clearly.\n` +
    `- When listing emails: summarise, don't dump. Group by what matters.\n` +
    `- When something was "out for delivery" 2+ days ago, say it's likely delivered.\n` +
    `- After showing emails, suggest quick actions if relevant (e.g. "want me to reply?" or "archive these?").\n` +
    `- After showing events, offer to create/modify if the conversation suggests it.\n` +
    `- For general knowledge questions (weather, news, facts), use google_search.\n` +
    `- If a question is ambiguous, make your best guess and act. Don't ask for clarification on obvious things.\n` +
    `- Keep replies under 300 words unless the user explicitly asks for detail.\n` +
    `</behaviour>\n\n` +
    `<tool_usage>\n` +
    `CRITICAL rules for using tools efficiently:\n` +
    `- search_emails uses full Gmail query syntax. One good search is enough. Do NOT repeat similar searches with slightly different words.\n` +
    `- After searching emails, read the most relevant 1-3 emails with read_email. Do NOT read more than 3 unless explicitly asked.\n` +
    `- If a search returns no results, try ONE broader query. If that also fails, tell the user you couldn't find it.\n` +
    `- Never call the same tool with the same or very similar arguments twice.\n` +
    `- Aim to answer in 2-5 tool calls total. You have a maximum of 15.\n` +
    `- When you have enough information to answer, STOP calling tools and respond immediately.\n` +
    `</tool_usage>`;

  if (summary) {
    prompt += `\n\n<conversation_context>\nPrevious conversation summary:\n${summary}\n</conversation_context>`;
  }

  return prompt;
}

// ==================== Tool Declarations (15 tools) ====================

const functionDeclarations = [
  {
    name: "search_emails",
    description: "Search/list emails from Gmail. Supports full Gmail query syntax: 'is:unread', 'from:someone@email.com', 'subject:invoice newer_than:7d', 'has:attachment', 'BYD lease', etc.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
        query: { type: Type.STRING, description: "Gmail search query" },
        maxResults: { type: Type.NUMBER, description: "Max emails to return (default 10)" },
      },
      required: ["account", "query"],
    },
  },
  {
    name: "read_email",
    description: "Read full content of a specific email by its message ID (obtained from search_emails)",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
        messageId: { type: Type.STRING, description: "Gmail message ID" },
      },
      required: ["account", "messageId"],
    },
  },
  {
    name: "manage_email",
    description: "Send, reply to, archive, or trash an email",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
        action: { type: Type.STRING, description: "'send', 'reply', 'archive', or 'trash'" },
        messageId: { type: Type.STRING, description: "Email ID (required for reply/archive/trash)" },
        to: { type: Type.STRING, description: "Recipient (required for send)" },
        subject: { type: Type.STRING, description: "Subject (required for send)" },
        body: { type: Type.STRING, description: "Email body (required for send/reply)" },
        cc: { type: Type.STRING, description: "CC recipients (optional, for send)" },
      },
      required: ["account", "action"],
    },
  },
  {
    name: "calendar",
    description: "List, create, update, or delete calendar events",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
        action: { type: Type.STRING, description: "'list', 'create', 'update', or 'delete'" },
        timeMin: { type: Type.STRING, description: "Start of range ISO format (for list)" },
        timeMax: { type: Type.STRING, description: "End of range ISO format (for list)" },
        eventId: { type: Type.STRING, description: "Event ID (for update/delete)" },
        summary: { type: Type.STRING, description: "Event title (for create/update)" },
        startTime: { type: Type.STRING, description: "Start time ISO (for create/update)" },
        endTime: { type: Type.STRING, description: "End time ISO (for create/update)" },
        description: { type: Type.STRING, description: "Event description (optional)" },
        location: { type: Type.STRING, description: "Event location (optional)" },
      },
      required: ["account", "action"],
    },
  },
  {
    name: "drive_search",
    description: "Search Drive files by name/content, list recent files, or get folder tree structure",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
        action: { type: Type.STRING, description: "'search', 'list', or 'tree'" },
        query: { type: Type.STRING, description: "Search term (for search)" },
        folderId: { type: Type.STRING, description: "Folder ID for tree (default: root)" },
        maxResults: { type: Type.NUMBER, description: "Max results (default 15)" },
      },
      required: ["account", "action"],
    },
  },
  {
    name: "drive_manage",
    description: "Move, rename, copy, delete files/folders, or create folders in Google Drive",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
        action: { type: Type.STRING, description: "'move', 'rename', 'copy', 'delete', or 'create_folder'" },
        fileId: { type: Type.STRING, description: "File/folder ID (for move/rename/copy/delete)" },
        newParentId: { type: Type.STRING, description: "Destination folder ID (for move)" },
        name: { type: Type.STRING, description: "New name (for rename/copy/create_folder)" },
        parentId: { type: Type.STRING, description: "Parent folder ID (for create_folder, default: root)" },
      },
      required: ["account", "action"],
    },
  },
  {
    name: "document",
    description: "Read, create, or append text to a Google Doc",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
        action: { type: Type.STRING, description: "'read', 'create', or 'append'" },
        docId: { type: Type.STRING, description: "Doc ID (for read/append)" },
        title: { type: Type.STRING, description: "Document title (for create)" },
        text: { type: Type.STRING, description: "Content to write (for create body or append)" },
      },
      required: ["account", "action"],
    },
  },
  {
    name: "spreadsheet",
    description: "Read, create, append rows, or update cells in a Google Sheet",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
        action: { type: Type.STRING, description: "'read', 'create', 'append', or 'update'" },
        spreadsheetId: { type: Type.STRING, description: "Spreadsheet ID (for read/append/update)" },
        title: { type: Type.STRING, description: "Title (for create)" },
        range: { type: Type.STRING, description: "Cell range A1 notation (default: 'Sheet1')" },
        rows: { type: Type.ARRAY, description: "Rows to append, e.g. [['A','B'],['C','D']]", items: { type: Type.ARRAY, items: { type: Type.STRING } } },
        values: { type: Type.ARRAY, description: "Values to write (for update)", items: { type: Type.ARRAY, items: { type: Type.STRING } } },
      },
      required: ["account", "action"],
    },
  },
  {
    name: "tasks",
    description: "List task lists, list tasks, create, complete, update, or delete a task in Google Tasks",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
        action: { type: Type.STRING, description: "'list_lists', 'list', 'create', 'complete', 'update', or 'delete'" },
        taskListId: { type: Type.STRING, description: "Task list ID (default: '@default')" },
        taskId: { type: Type.STRING, description: "Task ID (for complete/update/delete)" },
        title: { type: Type.STRING, description: "Task title (for create/update)" },
        notes: { type: Type.STRING, description: "Task notes (for create/update)" },
        due: { type: Type.STRING, description: "Due date e.g. '2026-04-01' (for create/update)" },
        showCompleted: { type: Type.BOOLEAN, description: "Include completed tasks (for list)" },
      },
      required: ["account", "action"],
    },
  },
  {
    name: "switch_account",
    description: "Switch the active Google account for subsequent operations",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "'account1' or 'account2'" },
      },
      required: ["account"],
    },
  },
  {
    name: "get_delivery_status",
    description: "Get delivery/parcel tracking status. Searches both Google accounts for delivery emails from the past 7 days. Use whenever the user asks about deliveries, parcels, packages, or tracking.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

const toolsConfig = [
  { functionDeclarations },
  { googleSearch: {} },
];

// ==================== Tool Execution ====================

async function executeTool(name, args, convo) {
  switch (name) {
    case "search_emails": return await searchEmails(args.account, args.query, args.maxResults || 10);
    case "read_email": return await readEmail(args.account, args.messageId);
    case "manage_email": {
      switch (args.action) {
        case "send": return await sendEmail(args.account, args.to, args.subject, args.body, args.cc || "");
        case "reply": return await replyToEmail(args.account, args.messageId, args.body);
        case "archive": return await archiveEmail(args.account, args.messageId);
        case "trash": return await trashEmail(args.account, args.messageId);
        default: return { error: `Unknown email action: ${args.action}` };
      }
    }
    case "calendar": {
      switch (args.action) {
        case "list": return await listEvents(args.account, args.timeMin, args.timeMax, args.maxResults || 15);
        case "create": return await createEvent(args.account, args.summary, args.startTime, args.endTime, args.description || "", args.location || "");
        case "update": {
          const updates = {};
          if (args.summary) updates.summary = args.summary;
          if (args.description) updates.description = args.description;
          if (args.location) updates.location = args.location;
          if (args.startTime) updates.start = { dateTime: args.startTime, timeZone: "Europe/London" };
          if (args.endTime) updates.end = { dateTime: args.endTime, timeZone: "Europe/London" };
          return await updateEvent(args.account, args.eventId, updates);
        }
        case "delete": return await deleteEvent(args.account, args.eventId);
        default: return { error: `Unknown calendar action: ${args.action}` };
      }
    }
    case "drive_search": {
      switch (args.action) {
        case "search": return await searchFiles(args.account, args.query, args.maxResults || 15);
        case "list": return await listFiles(args.account, args.maxResults || 15);
        case "tree": return await listFolderTree(args.account, args.folderId || "root", 0, 3);
        default: return { error: `Unknown drive_search action: ${args.action}` };
      }
    }
    case "drive_manage": {
      switch (args.action) {
        case "move": return await moveFile(args.account, args.fileId, args.newParentId);
        case "rename": return await renameFile(args.account, args.fileId, args.name);
        case "copy": return await copyFile(args.account, args.fileId, args.name || "");
        case "delete": return await deleteFile(args.account, args.fileId);
        case "create_folder": return await createFolder(args.account, args.name, args.parentId || "root");
        default: return { error: `Unknown drive_manage action: ${args.action}` };
      }
    }
    case "document": {
      switch (args.action) {
        case "read": return await readDoc(args.account, args.docId);
        case "create": return await createDocument(args.account, args.title, args.text || "");
        case "append": return await appendToDocument(args.account, args.docId, args.text);
        default: return { error: `Unknown document action: ${args.action}` };
      }
    }
    case "spreadsheet": {
      switch (args.action) {
        case "read": return await readSheet(args.account, args.spreadsheetId, args.range || "Sheet1");
        case "create": return await createSpreadsheet(args.account, args.title);
        case "append": return await appendToSheet(args.account, args.spreadsheetId, args.range || "Sheet1", args.rows);
        case "update": return await updateSheetCells(args.account, args.spreadsheetId, args.range, args.values);
        default: return { error: `Unknown spreadsheet action: ${args.action}` };
      }
    }
    case "tasks": {
      switch (args.action) {
        case "list_lists": return await listTaskLists(args.account);
        case "list": return await listTasks(args.account, args.taskListId || "@default", args.showCompleted || false);
        case "create": return await createTask(args.account, args.taskListId || "@default", args.title, args.notes || "", args.due || "");
        case "complete": return await completeTask(args.account, args.taskListId || "@default", args.taskId);
        case "update": {
          const updates = {};
          if (args.title) updates.title = args.title;
          if (args.notes) updates.notes = args.notes;
          if (args.due) updates.due = new Date(args.due).toISOString();
          return await updateTask(args.account, args.taskListId || "@default", args.taskId, updates);
        }
        case "delete": return await deleteTask(args.account, args.taskListId || "@default", args.taskId);
        default: return { error: `Unknown tasks action: ${args.action}` };
      }
    }
    case "switch_account":
      if (convo) convo.account = args.account;
      return { switched: true, account: args.account };
    case "get_delivery_status": return await getDeliveryStatus();
    default: return { error: `Unknown tool: ${name}` };
  }
}

function buildFunctionResponsePart(fc, result) {
  const wrapped = wrapResult(result);
  const truncated = truncateResult(wrapped);
  return {
    functionResponse: {
      name: fc.name,
      response: truncated,
      id: fc.id,
    },
  };
}

// ==================== Chat Engine (Gemini 3 Flash) ====================

function extractText(parts) {
  return (parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
}

async function chat(userId, userMessage) {
  const convo = getConvo(userId);
  await compactHistory(convo);

  const systemPrompt = buildSystemPrompt(convo.account, convo.summary);

  const userEntry = {
    role: "user",
    parts: [{ text: `[Active account: ${convo.account}]\n${userMessage}` }],
  };

  const contents = [...convo.history, userEntry];

  const MAX_TOOL_ROUNDS = 15;
  let lastModelText = "";

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await genai.models.generateContent({
        model: MODEL_HEAVY,
        contents,
        config: {
          systemInstruction: systemPrompt,
          tools: toolsConfig,
          toolConfig: { includeServerSideToolInvocations: true },
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        },
      });
    } catch (apiErr) {
      console.error(`[${new Date().toISOString()}] Gemini API error (round ${round}):`, apiErr.message);
      return `Something broke on the AI side: ${apiErr.message}`;
    }

    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason || "unknown";

    if (!candidate?.content?.parts) {
      if (finishReason === "SAFETY") {
        console.error(`[${new Date().toISOString()}] Blocked by safety filter (round ${round})`);
        return "That request was blocked by Google's safety filters. Try rephrasing.";
      }
      if (finishReason === "RECITATION") {
        console.error(`[${new Date().toISOString()}] Blocked by recitation filter (round ${round})`);
        return "Response blocked due to content policy. Try a different question.";
      }
      console.error(`[${new Date().toISOString()}] Empty candidate (round ${round}), finishReason: ${finishReason}`);
      break;
    }

    const parts = candidate.content.parts;
    contents.push(candidate.content);

    const functionCalls = response.functionCalls;
    if (!functionCalls || functionCalls.length === 0) {
      const text = extractText(parts);
      if (text) {
        convo.history.push(userEntry);
        convo.history.push({ role: "model", parts: [{ text }] });
        return text;
      }
      if (lastModelText) {
        convo.history.push(userEntry);
        convo.history.push({ role: "model", parts: [{ text: lastModelText }] });
        return lastModelText;
      }
      break;
    }

    const inlineText = extractText(parts);
    if (inlineText) lastModelText = inlineText;

    console.log(`[${new Date().toISOString()}] Round ${round}: ${functionCalls.map(fc => fc.name).join(", ")}`);
    const functionResponseParts = [];
    for (const fc of functionCalls) {
      console.log(`  Tool: ${fc.name}(${JSON.stringify(fc.args).slice(0, 200)})`);
      let result;
      try {
        result = await executeTool(fc.name, fc.args, convo);
      } catch (err) {
        console.error(`  Tool error (${fc.name}):`, err.message);
        result = { error: err.message };
      }
      functionResponseParts.push(buildFunctionResponsePart(fc, result));
    }

    contents.push({ role: "user", parts: functionResponseParts });
  }

  console.log(`[${new Date().toISOString()}] Forcing final answer after ${MAX_TOOL_ROUNDS} tool rounds`);
  try {
    contents.push({
      role: "user",
      parts: [{ text: "You have used all available tool calls. Based on everything you've gathered so far, give your best answer now. Do NOT say you need more information -- summarise what you found." }],
    });
    const finalResponse = await genai.models.generateContent({
      model: MODEL_HEAVY,
      contents,
      config: {
        systemInstruction: systemPrompt,
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      },
    });

    const finalCandidate = finalResponse.candidates?.[0];
    if (finalCandidate?.finishReason === "SAFETY") return "That request was blocked by Google's safety filters. Try rephrasing.";

    const text = extractText(finalCandidate?.content?.parts);
    if (text) {
      convo.history.push(userEntry);
      convo.history.push({ role: "model", parts: [{ text }] });
      return text;
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Forced answer failed:`, err.message);
  }

  if (lastModelText) {
    convo.history.push(userEntry);
    convo.history.push({ role: "model", parts: [{ text: lastModelText }] });
    return lastModelText;
  }

  return "I couldn't get a clear answer for that one. Try rephrasing or asking something more specific.";
}

// ==================== Lite Chat (scheduled updates, no memory) ====================

function liteSysPrompt() {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/London",
  });
  return `You are Praveg's personal assistant. Today is ${today}. Timezone: Europe/London.\n` +
    `Format replies using Telegram HTML: <b>bold</b> for headings, <i>italic</i> for dates.\n` +
    `Keep it concise and scannable. No asterisks, no markdown, no bullets. Separate items with blank lines.`;
}

async function chatLite(prompt) {
  try {
    const response = await genai.models.generateContent({
      model: MODEL_LITE,
      contents: prompt,
      config: {
        systemInstruction: liteSysPrompt(),
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return extractText(response.candidates?.[0]?.content?.parts);
  } catch (err) {
    console.error("chatLite error:", err.message);
    return "";
  }
}

async function chatLiteWithSearch(prompt) {
  try {
    const response = await genai.models.generateContent({
      model: MODEL_LITE,
      contents: prompt,
      config: {
        systemInstruction: liteSysPrompt(),
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    return extractText(response.candidates?.[0]?.content?.parts);
  } catch (err) {
    console.error("chatLiteWithSearch error:", err.message);
    return "";
  }
}

// ==================== Voice Transcription (Gemini Lite) ====================

async function transcribeVoice(audioBuffer) {
  try {
    const base64Audio = audioBuffer.toString("base64");
    const response = await genai.models.generateContent({
      model: MODEL_LITE,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "audio/ogg", data: base64Audio } },
            { text: "Transcribe this audio exactly. Return ONLY the transcription, nothing else." },
          ],
        },
      ],
      config: { thinkingConfig: { thinkingBudget: 0 } },
    });
    return response.text?.trim() || "";
  } catch (err) {
    console.error("Transcription error:", err.message);
    return "";
  }
}

// ==================== Telegram Bot ====================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || userId !== ALLOWED_USER_ID) {
    if (userId) await ctx.reply("Not authorised.");
    return;
  }
  await next();
});

async function sendFormattedReply(ctx, text) {
  const chunks = [];
  if (text.length > 4000) {
    for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  } else {
    chunks.push(text);
  }
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(chunk.replace(/<[^>]*>/g, ""));
    }
  }
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    "Hey Praveg \u{1F44B}\n\nJust text me like normal. I'm connected to both your Google accounts.\n\nAsk me anything -- emails, calendar, deliveries, tasks, files, or just general stuff.",
    { parse_mode: "HTML" }
  );
});

bot.command("account1", async (ctx) => {
  getConvo(ctx.from.id).account = "account1";
  await ctx.reply("Switched to <b>account1</b>", { parse_mode: "HTML" });
});

bot.command("account2", async (ctx) => {
  getConvo(ctx.from.id).account = "account2";
  await ctx.reply("Switched to <b>account2</b>", { parse_mode: "HTML" });
});

bot.command("clear", async (ctx) => {
  conversations[ctx.from.id] = { account: "account1", history: [], summary: "" };
  await ctx.reply("Conversation cleared. Fresh start.");
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  const typingInterval = setInterval(() => { ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {}); }, 4000);
  try {
    const reply = await chat(ctx.from.id, text);
    await sendFormattedReply(ctx, reply);
  } catch (err) {
    console.error("Error:", err);
    await ctx.reply(`Something broke: ${err.message}`);
  } finally {
    clearInterval(typingInterval);
  }
});

bot.on("message:voice", async (ctx) => {
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  const typingInterval = setInterval(() => { ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {}); }, 4000);
  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const buffer = Buffer.from(await res.arrayBuffer());
    const transcription = await transcribeVoice(buffer);
    console.log(`Voice: "${transcription}"`);
    if (!transcription) { clearInterval(typingInterval); await ctx.reply("Couldn't catch that. Try again?"); return; }
    await sendFormattedReply(ctx, `<i>"${transcription}"</i>`);
    const reply = await chat(ctx.from.id, transcription);
    await sendFormattedReply(ctx, reply);
  } catch (err) {
    console.error("Voice error:", err);
    await ctx.reply(`Something broke: ${err.message}`);
  } finally {
    clearInterval(typingInterval);
  }
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  const typingInterval = setInterval(() => { ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {}); }, 4000);
  try {
    const reply = await chat(ctx.from.id, data);
    await sendFormattedReply(ctx, reply);
  } catch (err) {
    console.error("Callback error:", err);
    await ctx.reply(`Something broke: ${err.message}`);
  } finally {
    clearInterval(typingInterval);
  }
});

// ==================== Scheduled Updates ====================

async function sendScheduledUpdate(prompt, label) {
  console.log(`[${new Date().toISOString()}] Sending ${label}...`);
  try {
    const reply = await chatLiteWithSearch(prompt);
    if (!reply || reply.length === 0) {
      console.error(`${label}: empty response from chatLiteWithSearch`);
      return;
    }
    const chunks = [];
    if (reply.length > 4000) { for (let i = 0; i < reply.length; i += 4000) chunks.push(reply.slice(i, i + 4000)); }
    else chunks.push(reply);
    for (const chunk of chunks) {
      try { await bot.api.sendMessage(ALLOWED_USER_ID, chunk, { parse_mode: "HTML" }); }
      catch { await bot.api.sendMessage(ALLOWED_USER_ID, chunk.replace(/<[^>]*>/g, "")); }
    }
    console.log(`[${new Date().toISOString()}] ${label} sent successfully`);
  } catch (err) {
    console.error(`${label} failed:`, err.message);
    try { await bot.api.sendMessage(ALLOWED_USER_ID, `Scheduled update "${label}" failed: ${err.message}`); } catch {}
  }
}

async function sendDeliveryUpdate() {
  console.log(`[${new Date().toISOString()}] Sending morning delivery update...`);
  try {
    const deliveryData = await getDeliveryStatus();
    const prompt = `Here is raw delivery email data from Praveg's Google accounts:\n\n${JSON.stringify(deliveryData).slice(0, 8000)}\n\nSummarise what's arriving today, what's in transit, and what was delivered recently. Be concise. Use Telegram HTML formatting.`;
    const reply = await chatLite(prompt);
    if (!reply) return;
    const chunks = [];
    if (reply.length > 4000) { for (let i = 0; i < reply.length; i += 4000) chunks.push(reply.slice(i, i + 4000)); }
    else chunks.push(reply);
    for (const chunk of chunks) {
      try { await bot.api.sendMessage(ALLOWED_USER_ID, chunk, { parse_mode: "HTML" }); }
      catch { await bot.api.sendMessage(ALLOWED_USER_ID, chunk.replace(/<[^>]*>/g, "")); }
    }
    console.log(`[${new Date().toISOString()}] Morning delivery update sent`);
  } catch (err) {
    console.error("Delivery update failed:", err.message);
    try { await bot.api.sendMessage(ALLOWED_USER_ID, `Delivery update failed: ${err.message}`); } catch {}
  }
}

async function sendMorningEmailDigest() {
  console.log(`[${new Date().toISOString()}] Sending morning email digest...`);
  try {
    const [emails1, emails2] = await Promise.all([
      searchEmails("account1", "newer_than:1d", 20),
      searchEmails("account2", "newer_than:1d", 20),
    ]);
    const combined = [
      ...emails1.map((e) => ({ ...e, account: "account1" })),
      ...emails2.map((e) => ({ ...e, account: "account2" })),
    ];
    if (!combined.length) {
      await bot.api.sendMessage(ALLOWED_USER_ID, "No emails in the last 24 hours.");
      return;
    }
    const data = combined.map((e) => `[${e.account}] From: ${e.from} | Subject: ${e.subject} | Date: ${e.date} | Snippet: ${e.snippet}`).join("\n");
    const prompt =
      `Here are all emails from Praveg's two Google accounts in the past 24 hours:\n\n${data.slice(0, 10000)}\n\n` +
      `Give a concise morning briefing. Group by what matters:\n` +
      `1. Anything that needs IMMEDIATE action or response (urgent, time-sensitive, requires a reply)\n` +
      `2. Important but not urgent (receipts, confirmations, newsletters worth reading)\n` +
      `3. Ignorable (marketing, spam-like, automated notifications)\n\n` +
      `If nothing is urgent, say so clearly. Use Telegram HTML formatting. Be direct and scannable.`;
    const reply = await chatLite(prompt);
    if (!reply) return;
    const chunks = [];
    if (reply.length > 4000) { for (let i = 0; i < reply.length; i += 4000) chunks.push(reply.slice(i, i + 4000)); }
    else chunks.push(reply);
    for (const chunk of chunks) {
      try { await bot.api.sendMessage(ALLOWED_USER_ID, chunk, { parse_mode: "HTML" }); }
      catch { await bot.api.sendMessage(ALLOWED_USER_ID, chunk.replace(/<[^>]*>/g, "")); }
    }
    console.log(`[${new Date().toISOString()}] Morning email digest sent`);
  } catch (err) {
    console.error("Email digest failed:", err.message);
    try { await bot.api.sendMessage(ALLOWED_USER_ID, `Email digest failed: ${err.message}`); } catch {}
  }
}

cron.schedule("0 8 * * *", () => { sendDeliveryUpdate(); sendMorningEmailDigest(); }, { timezone: "Europe/London" });

cron.schedule("0 13 * * *", () => {
  sendScheduledUpdate(
    `Search the web for today's top world news headlines. Give a quick summary of the 5-6 most important things happening in the world right now. Cover a mix: politics, economy, tech, anything major. Keep each item to 1-2 sentences. Use HTML formatting with <b>bold</b> for headlines.`,
    "Afternoon world news"
  );
}, { timezone: "Europe/London" });

cron.schedule("0 19 * * *", () => {
  sendScheduledUpdate(
    `Search the web for today's latest AI and tech news. Give a summary of the 5-6 most interesting AI developments, product launches, research breakthroughs, or industry moves from today. Keep each item to 1-2 sentences. Use HTML formatting with <b>bold</b> for headlines.`,
    "Evening AI news"
  );
}, { timezone: "Europe/London" });

// ==================== Error Handling & Start ====================

process.on("unhandledRejection", (err) => { console.error("Unhandled rejection:", err); });
process.on("uncaughtException", (err) => { console.error("Uncaught exception:", err); });

bot.catch((err) => { console.error("Bot error:", err); });

console.log(`Starting bot (chat: ${MODEL_HEAVY} w/ thinking HIGH | utility: ${MODEL_LITE})...`);
console.log(`Tools: ${functionDeclarations.length} functions + Google Search`);
console.log("Scheduled: 8am deliveries+email digest | 1pm world news | 7pm AI news");
bot.start();
