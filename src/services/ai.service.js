// src/services/ai.service.js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL  = 'claude-sonnet-4-20250514';

// ── SUMMARISE MESSAGES ────────────────────────────────────────
const summariseMessages = async (messages, context = {}) => {
  const msgText = messages
    .map(m => `[${m.handle || 'unknown'} at ${new Date(m.created_at).toLocaleTimeString()}]: ${m.content}`)
    .join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: `You are void.ai, the assistant for VOID — a private, privacy-first community platform.
Your summaries are concise, neutral, and written in lowercase to match the platform's aesthetic.
Never reveal private information. Focus on topics discussed, not who said what specifically.`,
    messages: [{
      role: 'user',
      content: `Summarise what was discussed in ${context.channel_name ? `#${context.channel_name}` : 'this channel'} recently. Be concise — 2-3 sentences max.\n\nMessages:\n${msgText}`,
    }],
  });

  return response.content[0].text;
};

// ── DRAFT ASSIST ──────────────────────────────────────────────
const draftAssist = async (prompt, context = {}) => {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: `You are void.ai, a writing assistant on VOID — a dark, minimal, privacy-first community platform.
Help users write clear, direct messages. Match their tone. Keep it concise.
Do not add pleasantries or sign-offs unless asked. Return only the drafted message text.`,
    messages: [{
      role: 'user',
      content: `Help me write a message${context.channel_name ? ` for #${context.channel_name}` : ''}.\n\nWhat I want to say: ${prompt}`,
    }],
  });

  return response.content[0].text;
};

// ── MODERATION CHECK ──────────────────────────────────────────
// Returns { flagged: bool, reason: string, severity: 'low'|'medium'|'high' }
const moderateContent = async (content) => {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 150,
    system: `You are a content moderation assistant. Analyse the message and respond with JSON only.
Return: {"flagged": boolean, "reason": string or null, "severity": "low"|"medium"|"high"|null}
Flag content that contains: hate speech, targeted harassment, explicit threats, CSAM, doxxing.
Do NOT flag: strong opinions, dark humour, profanity, political discussion, adult themes between consenting adults.
Be conservative — only flag clear violations. Respond with raw JSON, no markdown.`,
    messages: [{
      role: 'user',
      content: `Analyse this message: "${content}"`,
    }],
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { flagged: false, reason: null, severity: null };
  }
};

// ── SMART REPLY SUGGESTIONS ───────────────────────────────────
const suggestReplies = async (messages, context = {}) => {
  const recentMsgs = messages.slice(-5)
    .map(m => `${m.handle}: ${m.content}`)
    .join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 200,
    system: `You are void.ai. Suggest 3 short reply options for the user to send in response to the conversation.
Each suggestion should be distinct in tone: one casual, one informative, one brief.
Return JSON array only: ["reply 1", "reply 2", "reply 3"]. No markdown, no extra text.`,
    messages: [{
      role: 'user',
      content: `Conversation so far:\n${recentMsgs}\n\nSuggest 3 reply options.`,
    }],
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return [];
  }
};

module.exports = { summariseMessages, draftAssist, moderateContent, suggestReplies };
