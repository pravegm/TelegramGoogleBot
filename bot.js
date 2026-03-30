import "dotenv/config";
import { Bot } from "grammy";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import cron from "node-cron";
import {
  listEmails, readEmail, sendEmail, searchEmails,
  listEvents, createEvent, deleteEvent, updateEvent,
  listFiles, searchFiles, readDoc, readSheet,
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

function truncateResult(obj, maxLen = 14000) {
  let json = JSON.stringify(obj);
  if (json.length <= maxLen) return obj;

  if (Array.isArray(obj)) {
    const copy = [...obj];
    while (copy.length > 1 && JSON.stringify(copy).length > maxLen) copy.pop();
    return copy;
  }

  if (typeof obj === "object" && obj !== null) {
    if (Array.isArray(obj.result)) {
      const copy = { ...obj, result: [...obj.result] };
      while (copy.result.length > 1 && JSON.stringify(copy).length > maxLen) copy.result.pop();
      return copy;
    }
    const copy = { ...obj };
    for (const key of Object.keys(copy)) {
      if (typeof copy[key] === "string" && copy[key].length > 1000) {
        copy[key] = copy[key].slice(0, 1000) + "...";
      }
    }
    return copy;
  }

  if (typeof obj === "string") return obj.slice(0, maxLen);
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
    `</behaviour>`;

  if (summary) {
    prompt += `\n\n<conversation_context>\nPrevious conversation summary:\n${summary}\n</conversation_context>`;
  }

  return prompt;
}

// ==================== Tool Declarations (Gemini format) ====================

const functionDeclarations = [
  {
    name: "list_emails",
    description: "List emails from Gmail. Use for checking inbox, unread emails, etc.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account: 'account1' or 'account2'" },
        query: { type: Type.STRING, description: "Gmail search query, e.g. 'is:unread', 'from:someone@email.com'" },
        maxResults: { type: Type.NUMBER, description: "Max emails to return (default 10)" },
      },
      required: ["account", "query"],
    },
  },
  {
    name: "read_email",
    description: "Read full content of a specific email by message ID",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        messageId: { type: Type.STRING, description: "Gmail message ID" },
      },
      required: ["account", "messageId"],
    },
  },
  {
    name: "send_email",
    description: "Send a new email",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        to: { type: Type.STRING, description: "Recipient email" },
        subject: { type: Type.STRING, description: "Subject line" },
        body: { type: Type.STRING, description: "Email body" },
        cc: { type: Type.STRING, description: "CC recipients (optional)" },
      },
      required: ["account", "to", "subject", "body"],
    },
  },
  {
    name: "reply_to_email",
    description: "Reply to an existing email in its thread",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        messageId: { type: Type.STRING, description: "Email ID to reply to" },
        body: { type: Type.STRING, description: "Reply text" },
      },
      required: ["account", "messageId", "body"],
    },
  },
  {
    name: "archive_email",
    description: "Archive an email (remove from inbox)",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        messageId: { type: Type.STRING, description: "Gmail message ID to archive" },
      },
      required: ["account", "messageId"],
    },
  },
  {
    name: "trash_email",
    description: "Move an email to trash",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        messageId: { type: Type.STRING, description: "Gmail message ID to trash" },
      },
      required: ["account", "messageId"],
    },
  },
  {
    name: "search_emails",
    description: "Search emails with Gmail query syntax",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        query: { type: Type.STRING, description: "Gmail search query" },
        maxResults: { type: Type.NUMBER, description: "Max results (default 10)" },
      },
      required: ["account", "query"],
    },
  },
  {
    name: "list_calendar_events",
    description: "List calendar events in a date range",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        timeMin: { type: Type.STRING, description: "Start time ISO format" },
        timeMax: { type: Type.STRING, description: "End time ISO format" },
        maxResults: { type: Type.NUMBER, description: "Max results (default 15)" },
      },
      required: ["account", "timeMin", "timeMax"],
    },
  },
  {
    name: "create_calendar_event",
    description: "Create a new calendar event",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        summary: { type: Type.STRING, description: "Event title" },
        startTime: { type: Type.STRING, description: "Start time ISO format" },
        endTime: { type: Type.STRING, description: "End time ISO format" },
        description: { type: Type.STRING, description: "Event description" },
        location: { type: Type.STRING, description: "Event location" },
      },
      required: ["account", "summary", "startTime", "endTime"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "Delete a calendar event",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        eventId: { type: Type.STRING, description: "Calendar event ID to delete" },
      },
      required: ["account", "eventId"],
    },
  },
  {
    name: "list_drive_files",
    description: "List recent files from Google Drive",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        maxResults: { type: Type.NUMBER, description: "Max results (default 15)" },
      },
      required: ["account"],
    },
  },
  {
    name: "search_drive_files",
    description: "Search Google Drive files",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        query: { type: Type.STRING, description: "Search query" },
        maxResults: { type: Type.NUMBER, description: "Max results" },
      },
      required: ["account", "query"],
    },
  },
  {
    name: "read_document",
    description: "Read a Google Doc's content",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        docId: { type: Type.STRING, description: "Google Doc ID" },
      },
      required: ["account", "docId"],
    },
  },
  {
    name: "read_spreadsheet",
    description: "Read data from a Google Sheet",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        spreadsheetId: { type: Type.STRING, description: "Spreadsheet ID" },
        range: { type: Type.STRING, description: "Cell range (default: 'Sheet1')" },
      },
      required: ["account", "spreadsheetId"],
    },
  },
  {
    name: "switch_account",
    description: "Switch the active Google account",
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
    description: "Get delivery/parcel tracking status. Searches both Google accounts for delivery emails from the past 7 days and extracts tracking info. Use whenever the user asks about deliveries, parcels, packages, or tracking.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_task_lists",
    description: "List all Google Tasks lists for an account",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
      },
      required: ["account"],
    },
  },
  {
    name: "list_tasks",
    description: "List tasks from a Google Tasks list. Defaults to the primary list.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        taskListId: { type: Type.STRING, description: "Task list ID (default: '@default' for primary list)" },
        showCompleted: { type: Type.BOOLEAN, description: "Whether to include completed tasks (default: false)" },
      },
      required: ["account"],
    },
  },
  {
    name: "create_task",
    description: "Create a new task in Google Tasks",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        taskListId: { type: Type.STRING, description: "Task list ID (default: '@default')" },
        title: { type: Type.STRING, description: "Task title" },
        notes: { type: Type.STRING, description: "Task notes/details (optional)" },
        due: { type: Type.STRING, description: "Due date, e.g. '2026-04-01' (optional)" },
      },
      required: ["account", "title"],
    },
  },
  {
    name: "complete_task",
    description: "Mark a task as completed",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        taskListId: { type: Type.STRING, description: "Task list ID (default: '@default')" },
        taskId: { type: Type.STRING, description: "Task ID to complete" },
      },
      required: ["account", "taskId"],
    },
  },
  {
    name: "update_task",
    description: "Update a task's title, notes, or due date",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        taskListId: { type: Type.STRING, description: "Task list ID (default: '@default')" },
        taskId: { type: Type.STRING, description: "Task ID to update" },
        title: { type: Type.STRING, description: "New title (optional)" },
        notes: { type: Type.STRING, description: "New notes (optional)" },
        due: { type: Type.STRING, description: "New due date (optional)" },
      },
      required: ["account", "taskId"],
    },
  },
  {
    name: "delete_task",
    description: "Delete a task from Google Tasks",
    parameters: {
      type: Type.OBJECT,
      properties: {
        account: { type: Type.STRING, description: "Google account name" },
        taskListId: { type: Type.STRING, description: "Task list ID (default: '@default')" },
        taskId: { type: Type.STRING, description: "Task ID to delete" },
      },
      required: ["account", "taskId"],
    },
  },
];

const toolsConfig = [
  { functionDeclarations },
  { googleSearch: {} },
];

// ==================== Tool Execution ====================

async function executeTool(name, args, convo) {
  switch (name) {
    case "list_emails": return await listEmails(args.account, args.query, args.maxResults || 10);
    case "read_email": return await readEmail(args.account, args.messageId);
    case "send_email": return await sendEmail(args.account, args.to, args.subject, args.body, args.cc || "");
    case "reply_to_email": return await replyToEmail(args.account, args.messageId, args.body);
    case "archive_email": return await archiveEmail(args.account, args.messageId);
    case "trash_email": return await trashEmail(args.account, args.messageId);
    case "search_emails": return await searchEmails(args.account, args.query, args.maxResults || 10);
    case "list_calendar_events": return await listEvents(args.account, args.timeMin, args.timeMax, args.maxResults || 15);
    case "create_calendar_event": return await createEvent(args.account, args.summary, args.startTime, args.endTime, args.description || "", args.location || "");
    case "delete_calendar_event": return await deleteEvent(args.account, args.eventId);
    case "list_drive_files": return await listFiles(args.account, args.maxResults || 15);
    case "search_drive_files": return await searchFiles(args.account, args.query, args.maxResults || 15);
    case "read_document": return await readDoc(args.account, args.docId);
    case "read_spreadsheet": return await readSheet(args.account, args.spreadsheetId, args.range || "Sheet1");
    case "switch_account":
      if (convo) convo.account = args.account;
      return { switched: true, account: args.account };
    case "get_delivery_status": return await getDeliveryStatus();
    case "list_task_lists": return await listTaskLists(args.account);
    case "list_tasks": return await listTasks(args.account, args.taskListId || "@default", args.showCompleted || false);
    case "create_task": return await createTask(args.account, args.taskListId || "@default", args.title, args.notes || "", args.due || "");
    case "complete_task": return await completeTask(args.account, args.taskListId || "@default", args.taskId);
    case "update_task": {
      const updates = {};
      if (args.title) updates.title = args.title;
      if (args.notes) updates.notes = args.notes;
      if (args.due) updates.due = new Date(args.due).toISOString();
      return await updateTask(args.account, args.taskListId || "@default", args.taskId, updates);
    }
    case "delete_task": return await deleteTask(args.account, args.taskListId || "@default", args.taskId);
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

async function chat(userId, userMessage) {
  const convo = getConvo(userId);
  await compactHistory(convo);

  const systemPrompt = buildSystemPrompt(convo.account, convo.summary);

  convo.history.push({
    role: "user",
    parts: [{ text: `[Active account: ${convo.account}]\n${userMessage}` }],
  });

  const contents = [...convo.history];

  let rounds = 10;
  while (rounds-- > 0) {
    const response = await genai.models.generateContent({
      model: MODEL_HEAVY,
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools: toolsConfig,
        toolConfig: { includeServerSideToolInvocations: true },
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) break;

    const parts = candidate.content.parts;
    contents.push(candidate.content);

    const functionCalls = response.functionCalls;
    if (!functionCalls || functionCalls.length === 0) {
      const textParts = parts.filter((p) => p.text && !p.thought);
      const text = textParts.map((p) => p.text).join("") || "";
      convo.history.push({ role: "model", parts: [{ text }] });
      return text;
    }

    const functionResponseParts = [];
    for (const fc of functionCalls) {
      console.log(`Tool: ${fc.name}(${JSON.stringify(fc.args).slice(0, 200)})`);
      let result;
      try {
        result = await executeTool(fc.name, fc.args, convo);
      } catch (err) {
        console.error(`Tool error (${fc.name}):`, err.message);
        result = { error: err.message };
      }
      functionResponseParts.push(buildFunctionResponsePart(fc, result));
    }

    contents.push({ role: "user", parts: functionResponseParts });
  }

  return "Something went sideways. Try asking again.";
}

// ==================== Lite Chat (scheduled updates, no memory) ====================

async function chatLite(prompt) {
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Europe/London",
  });

  const systemPrompt =
    `You are Praveg's personal assistant. Today is ${today}. Timezone: Europe/London.\n` +
    `Format replies using Telegram HTML: <b>bold</b> for headings, <i>italic</i> for dates.\n` +
    `Keep it concise and scannable. No asterisks, no markdown, no bullets. Separate items with blank lines.`;

  const response = await genai.models.generateContent({
    model: MODEL_LITE,
    contents: prompt,
    config: {
      systemInstruction: systemPrompt,
      tools: [{ functionDeclarations }, { googleSearch: {} }],
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const functionCalls = response.functionCalls;
  if (functionCalls && functionCalls.length > 0) {
    const contents = [
      { role: "user", parts: [{ text: prompt }] },
      response.candidates[0].content,
    ];

    const functionResponseParts = [];
    for (const fc of functionCalls) {
      console.log(`Lite tool: ${fc.name}(${JSON.stringify(fc.args).slice(0, 200)})`);
      let result;
      try {
        result = await executeTool(fc.name, fc.args, null);
      } catch (err) {
        console.error(`Lite tool error (${fc.name}):`, err.message);
        result = { error: err.message };
      }
      functionResponseParts.push(buildFunctionResponsePart(fc, result));
    }
    contents.push({ role: "user", parts: functionResponseParts });

    const followUp = await genai.models.generateContent({
      model: MODEL_LITE,
      contents,
      config: {
        systemInstruction: systemPrompt,
        tools: [{ functionDeclarations }, { googleSearch: {} }],
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const fParts = followUp.candidates?.[0]?.content?.parts || [];
    return fParts.filter((p) => p.text && !p.thought).map((p) => p.text).join("") || "";
  }

  const rParts = response.candidates?.[0]?.content?.parts || [];
  return rParts.filter((p) => p.text && !p.thought).map((p) => p.text).join("") || "";
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
    clearInterval(typingInterval);
    await sendFormattedReply(ctx, reply);
  } catch (err) {
    clearInterval(typingInterval);
    console.error("Error:", err);
    await ctx.reply(`Something broke: ${err.message}`);
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
    clearInterval(typingInterval);
    await sendFormattedReply(ctx, reply);
  } catch (err) {
    clearInterval(typingInterval);
    console.error("Voice error:", err);
    await ctx.reply(`Something broke: ${err.message}`);
  }
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  await ctx.api.sendChatAction(ctx.chat.id, "typing");
  const typingInterval = setInterval(() => { ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {}); }, 4000);
  try {
    const reply = await chat(ctx.from.id, data);
    clearInterval(typingInterval);
    await sendFormattedReply(ctx, reply);
  } catch (err) {
    clearInterval(typingInterval);
    console.error("Callback error:", err);
    await ctx.reply(`Something broke: ${err.message}`);
  }
});

// ==================== Scheduled Updates ====================

async function sendScheduledUpdate(prompt, label) {
  console.log(`[${new Date().toISOString()}] Sending ${label}...`);
  try {
    const reply = await chatLite(prompt);
    if (!reply || reply.length === 0) {
      console.error(`${label}: empty response from chatLite`);
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

cron.schedule("0 8 * * *", () => { sendDeliveryUpdate(); }, { timezone: "Europe/London" });

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

bot.catch((err) => { console.error("Bot error:", err); });

console.log(`Starting bot (chat: ${MODEL_HEAVY} w/ thinking HIGH | utility: ${MODEL_LITE})...`);
console.log("Scheduled: 8am deliveries | 1pm world news | 7pm AI news");
bot.start();
