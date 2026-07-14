// LLM client, the API key is per-workspace (BYO), passed in per call. The
// server never uses a shared/owner key, so no usage ever bills the operator.
import { recordUsage } from './store.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.JOBPILOT_MODEL || 'claude-sonnet-5';
const PRICE = { input: 3, output: 15 }; // rough $/MTok for the per-workspace budget meter

// `pdfBase64`, when given, is sent as a native document block so Claude can
// read an uploaded CV directly (no PDF-parsing dependency needed).
export async function complete(wsId, apiKey, { purpose, system, prompt, maxTokens = 2000, json = false, pdfBase64 = null }) {
  if (!apiKey) throw new Error('No Anthropic API key set for this workspace. Add yours in Settings.');

  const content = pdfBase64
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } }, { type: 'text', text: prompt }]
    : prompt;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: system || undefined, messages: [{ role: 'user', content }] }),
  });
  if (res.status === 401) throw new Error('Anthropic rejected your API key (401). Check it in Settings.');
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();

  const text = data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const inTok = data.usage?.input_tokens ?? 0, outTok = data.usage?.output_tokens ?? 0;
  recordUsage(wsId, purpose, inTok, outTok, (inTok * PRICE.input + outTok * PRICE.output) / 1e6);

  if (data.stop_reason === 'max_tokens') throw new Error(`Response hit the ${maxTokens}-token limit, try a shorter job description.`);
  if (!json) return text;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const slice = cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1);
  try { return JSON.parse(slice); }
  catch { return JSON.parse(escapeControlChars(slice)); }
}

function escapeControlChars(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (!inStr) { if (ch === '"') inStr = true; out += ch; continue; }
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = false; out += ch; continue; }
    const c = ch.charCodeAt(0);
    if (c < 0x20) { out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ''; continue; }
    out += ch;
  }
  return out;
}
