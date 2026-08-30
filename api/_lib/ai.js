// ============================================================================
// The model behind the desk's "Use AI" button.
//
// Same provider and the same environment variables the app already uses
// (`Application APK/serverless/aiProvider.ts`): GEMINI_API_KEY by default, or
// an OpenAI-compatible gateway when AI_BASE_URL is set. Adding a second
// provider here would mean a second key, a second bill and a second thing to
// disclose in the privacy policy, for a feature the existing one answers
// perfectly well.
//
// No SDK. This project has no dependencies at all and runs on Edge Functions,
// so both upstreams are reached with fetch — they are ordinary JSON APIs.
//
// The model is pinned, not `-latest`. The app's aiConfig.ts explains why in one
// line worth repeating: Google hot-swaps the alias, and a support desk whose
// answers change tone overnight without anybody deploying is a support desk
// nobody can debug.
// ============================================================================

const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const GOOGLE = "https://generativelanguage.googleapis.com/v1beta";

export function isAiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.AI_API_KEYS);
}

function apiKey() {
  // AI_API_KEYS is the app's rotating pool; take the first if that is what is
  // configured, so one variable can serve both deployments.
  const pool = process.env.GEMINI_API_KEY || process.env.AI_API_KEYS || "";
  const key = pool.split(",")[0].trim();
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

function model() {
  return (process.env.MODEL_SUPPORT_DRAFT || DEFAULT_MODEL).trim();
}

/**
 * One completion. Returns { text, model }.
 *
 * `temperature` is low on purpose: a support reply should be the same answer
 * every time it is asked, not a creative variation on it.
 */
export async function complete({ system, user, maxTokens = 900, temperature = 0.3 }) {
  const base = (process.env.AI_BASE_URL || "").replace(/\/+$/, "");
  const timeout = AbortSignal.timeout(25000);

  if (base) {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model(),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      signal: timeout,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(aiError(data, res.status));
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("The model returned nothing.");
    return { text: String(text).trim(), model: model() };
  }

  const res = await fetch(`${GOOGLE}/models/${encodeURIComponent(model())}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    }),
    signal: timeout,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(aiError(data, res.status));

  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("").trim();
  if (!text) {
    // A blocked or truncated answer looks identical to an empty one unless the
    // reason is read out, and "the model returned nothing" is not a bug report.
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(reason ? `The model stopped early (${reason}).` : "The model returned nothing.");
  }
  return { text, model: model() };
}

/** Provider errors, in words that name the fix rather than the status code. */
function aiError(data, status) {
  const message = data?.error?.message || data?.message || `HTTP ${status}`;
  if (status === 401 || status === 403) return `The AI key was refused: ${message}`;
  if (status === 429) return "The AI quota is used up for now. Try again shortly, or write the reply by hand.";
  return `The model could not be reached: ${message}`;
}

// ---------------------------------------------------------------------------
// the prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You are drafting a reply for the Plately customer support desk.
Plately is a nutrition app: photograph a meal, it estimates calories and macros.
It also tracks hydration and body weight and has a coach that answers from the diary.

You are NOT talking to the customer. You are writing a draft that a human support
agent will read, possibly edit, and only then send. Write it as the finished reply,
with no preamble, no "here is a draft", and no notes to the agent.

Rules, in order of importance:

1. Answer ONLY from the knowledge base articles and the ticket below. If they do
   not contain the answer, say so plainly in the draft and suggest what the agent
   should check. Never invent a feature, a price, a policy, a refund window or a
   date. A confident wrong answer is far worse here than an admission of not knowing.
2. Reply in the language the customer wrote in. If they wrote Polish, answer Polish.
3. Match the tone of the approved examples if any are given. Plain, warm, direct.
   No corporate padding, no "we sincerely apologise for any inconvenience".
4. Be specific. If the article gives steps, give the steps.
5. Do not open with a greeting line or close with a signature — the desk adds
   those. Start with the substance.
6. Never promise a refund, a deadline, or a fix date. The agent decides those.
7. Plain text only. No markdown, no headings, no bold.`;

function section(title, body) {
  return body && body.trim() ? `\n### ${title}\n${body.trim()}\n` : "";
}

/**
 * Everything the model gets to see, assembled in one place.
 *
 * The examples are the mechanism behind the thumbs: an approved answer is shown
 * as how this desk writes, and a rejected draft is shown as what not to do.
 * Both are the desk's own history, not general advice, which is what makes the
 * feedback change the next answer rather than decorate the last one.
 */
export function buildDraftPrompt({ ticket, messages, articles, examples, customer }) {
  const conversation = (messages || [])
    .filter((m) => m.kind === "customer" || m.kind === "reply")
    .slice(-8)
    .map((m) => `${m.kind === "customer" ? "CUSTOMER" : "SUPPORT"}: ${String(m.body || "").trim()}`)
    .join("\n\n");

  const kb = (articles || [])
    .map((a) => `--- ARTICLE: ${a.title} (${a.category})\n${String(a.body || "").trim()}`)
    .join("\n\n");

  const good = (examples?.good || [])
    .map((e, i) => `Example ${i + 1}\nAsked: ${e.question}\nApproved answer: ${e.answer}`)
    .join("\n\n");

  const bad = (examples?.bad || [])
    .map((e, i) => `Rejected ${i + 1}\nAsked: ${e.question}\nThis draft was rejected by an agent: ${e.rejected}`)
    .join("\n\n");

  const user =
    section("Knowledge base", kb || "(no published articles — say what you cannot confirm)") +
    section("Answers this desk approved before — match this voice", good) +
    section("Drafts this desk rejected before — do not answer like this again", bad) +
    section(
      "About this customer",
      customer
        ? [
            `Plan: ${customer.plan || "free"}`,
            `Has an app account: ${customer.has_account ? "yes" : "no"}`,
            customer.ltv_pln ? `Has paid: ${customer.ltv_pln} PLN lifetime` : null,
          ].filter(Boolean).join("\n")
        : ""
    ) +
    section("Ticket", `Category: ${ticket.tag || "none"}\nSubject: ${ticket.subject}`) +
    section("Conversation so far", conversation) +
    "\nWrite the reply now.";

  return { system: SYSTEM, user };
}

/** The customer's own words, for storing beside the draft as the "question". */
export function lastCustomerMessage(messages) {
  const customer = (messages || []).filter((m) => m.kind === "customer");
  return customer.length ? String(customer[customer.length - 1].body || "").trim().slice(0, 2000) : "";
}
