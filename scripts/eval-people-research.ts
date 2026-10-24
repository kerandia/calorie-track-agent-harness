/**
 * Opt-in people-research regression for Sezar.
 *
 * Calls the real GLM-5.3-Flash and Exa. Not part of `npm test`.
 *
 *   npm run eval:people
 *
 * Needs EXA_API_KEY and either NEBIUS_API_KEY (production model) or
 * OPENROUTER_API_KEY (same model, fallback id). A repo-root `.env` is loaded
 * for any of those that are not already set. Exit 0 passes, 1 fails, 2 means
 * the keys are missing.
 *
 * The system prompt is `.flue/roles/sezar.md`. The tools are the real
 * `web_search` and `read_page` from `capabilities/search.ts`. The user text is
 * wrapped in the same `[context]` block the chat agent builds, with an
 * onboarded profile so the turn is not spent collecting health fields. Redis,
 * the sandbox and the meal tools are not started — this checks the research
 * path, which is the one that failed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSearchCapability } from "../.flue/capabilities/search.js";
import { FALLBACK_MODEL_ID, MAIN_MODEL_ID } from "../.flue/lib/models.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const QUESTION = "Can you find me the Turkish people worked at beam ai then started a startup in Berlin";
const PUSHBACK = "another agent found Burak Cemil Özafşar";

const MIN_SEARCHES = 4;
const MAX_ROUNDS = 16;
const TURN_BUDGET_MS = 7 * 60 * 1000;

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type SearchHit = { query: string; category?: string };

type TurnTrace = { searches: SearchHit[]; pages: string[]; reply: string };

type Endpoint = { url: string; key: string; model: string; reasoning?: string };

const loadDotEnv = (path: string): void => {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
};

const roleBody = (md: string): string => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

/** Same shape as the chat agent's per-turn user message, minus meal state. */
const contextMessage = (text: string): string => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  return `[context]
Today (UTC date — the meal database keys days by UTC date): ${today}. Now: ${now.toISOString()}.
Profile: Alp, based in Berlin. Onboarded — do not collect health fields.
[/context]

User says: "${text.replaceAll('"', "'")}"`;
};

const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

const asksForTheName = (reply: string): boolean =>
  [
    /what(?:'s| is) (?:their|his|her|the) name/,
    /do you (?:know|have|remember) (?:a |the )?name/,
    /(?:send|give|tell|drop) me (?:a |the |their )?name/,
    /if you (?:have|know|send|give) (?:me )?(?:a |the )?name/,
    /need (?:a |the |their )?name/,
    /who(?:m)? (?:exactly|specifically)/,
    /which person/,
    /got a name/,
  ].some((re) => re.test(reply.toLowerCase()));

const claimsBlocked = (reply: string): boolean => {
  const t = reply.toLowerCase();
  if (/blocks me|can(?:not|'t) scrape|scraping its/.test(t)) return true;
  return /linkedin/.test(t) && /block|scrap|can(?:not|'t)|won'?t let|not allowed|no access|forbidden|locked/.test(t);
};

const mentionsAnswer = (reply: string): boolean => {
  const n = fold(reply);
  return n.includes("mutagent") && n.includes("ozafsar");
};

const searchedTheClaim = (searches: SearchHit[]): boolean =>
  searches.some((s) => {
    const q = fold(s.query);
    return q.includes("ozafsar") || q.includes("burak");
  });

const deniesTheClaim = (reply: string): boolean =>
  /hallucin|made (?:him|her|that|this|it) up|does ?n[o']t exist|not a real|no such person/.test(fold(reply));

// The user already named him, so "yeah, I saw him too" agrees without repeating it.
const agrees = (reply: string): boolean => {
  const n = fold(reply);
  if (deniesTheClaim(reply)) return false;
  if (/\b(?:yeah|yep|yup|yes|right|correct|matches)\b|that'?s him|same (?:person|one|guy)|saw (?:that|him|it)/.test(n)) return true;
  return n.includes("ozafsar") && /mutagent|beam|cto|co-?founder/.test(n);
};

const endpoint = (): Endpoint | null => {
  if (process.env.NEBIUS_API_KEY) {
    const effort = (process.env.NEBIUS_REASONING_EFFORT ?? "low").toLowerCase();
    return {
      url: "https://api.tokenfactory.nebius.com/v1/chat/completions",
      key: process.env.NEBIUS_API_KEY,
      model: MAIN_MODEL_ID,
      ...(effort !== "off" ? { reasoning: effort } : {}),
    };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      key: process.env.OPENROUTER_API_KEY,
      model: FALLBACK_MODEL_ID,
    };
  }
  return null;
};

const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const complete = async (
  messages: ChatMessage[],
  tools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[],
  ep: Endpoint,
  signal: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> => {
  const body: Record<string, unknown> = {
    model: ep.model,
    messages,
    tools,
    max_tokens: 8000,
  };
  if (ep.reasoning) body.reasoning_effort = ep.reasoning;
  const res = await fetch(ep.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ep.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
  };
  const message = data.choices?.[0]?.message;
  const toolCalls = (message?.tool_calls ?? []).map((call, i) => ({
    id: call.id || `call_${i}`,
    type: "function" as const,
    function: {
      name: call.function?.name ?? "",
      arguments:
        typeof call.function?.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments ?? {}),
    },
  }));
  return { content: (message?.content ?? "").trim(), toolCalls };
};

const runTurn = async (
  messages: ChatMessage[],
  toolsByName: Map<string, { execute: (args: Record<string, unknown>) => Promise<string> }>,
  openaiTools: { type: "function"; function: { name: string; description: string; parameters: unknown } }[],
  ep: Endpoint,
  trace: TurnTrace,
): Promise<string> => {
  const deadline = Date.now() + TURN_BUDGET_MS;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("turn budget exceeded");
    const { content, toolCalls } = await complete(
      messages,
      openaiTools,
      ep,
      AbortSignal.timeout(Math.min(remaining, 180_000)),
    );
    if (toolCalls.length === 0) {
      const reply = content.trim();
      messages.push({ role: "assistant", content: reply });
      trace.reply = reply;
      return reply;
    }
    messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls });
    for (const call of toolCalls) {
      const args = parseArgs(call.function.arguments);
      if (call.function.name === "web_search" && typeof args.query === "string") {
        const hit: SearchHit = { query: args.query };
        if (typeof args.category === "string") hit.category = args.category;
        trace.searches.push(hit);
        console.log(`  search: ${args.query}${hit.category ? ` [${hit.category}]` : ""}`);
      } else if (call.function.name === "read_page" && typeof args.url === "string") {
        trace.pages.push(args.url);
        console.log(`  read: ${args.url}`);
      } else {
        console.log(`  tool: ${call.function.name}`);
      }
      const tool = toolsByName.get(call.function.name);
      let result: string;
      try {
        result = tool ? await tool.execute(args) : `Unknown tool ${call.function.name}`;
      } catch (err) {
        result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, 14_000) });
    }
  }
  throw new Error(`exceeded ${MAX_ROUNDS} model rounds without a reply`);
};

const howToRun = (): string =>
  [
    "People-research eval was not run.",
    "It calls GLM-5.3-Flash and Exa, so it stays out of `npm test`.",
    "",
    "  EXA_API_KEY=... NEBIUS_API_KEY=... npm run eval:people",
    "",
    "OPENROUTER_API_KEY works in place of NEBIUS_API_KEY (model " + FALLBACK_MODEL_ID + ").",
    "A filled-in .env at the repo root is loaded when those vars are unset.",
  ].join("\n");

const main = async (): Promise<number> => {
  loadDotEnv(resolve(ROOT, ".env"));
  const ep = endpoint();
  if (!process.env.EXA_API_KEY || !ep) {
    console.log(howToRun());
    return 2;
  }

  const role = roleBody(readFileSync(resolve(ROOT, ".flue/roles/sezar.md"), "utf8"));
  const capability = createSearchCapability();
  const toolsByName = new Map(capability.tools.map((tool) => [tool.name, tool]));
  const openaiTools = capability.tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(JSON.stringify(tool.parameters)) as unknown,
    },
  }));

  const messages: ChatMessage[] = [
    { role: "system", content: role },
    { role: "user", content: contextMessage(QUESTION) },
  ];

  console.log(`model: ${ep.model}`);
  console.log(`turn 1: ${QUESTION}`);
  const turn1: TurnTrace = { searches: [], pages: [], reply: "" };
  turn1.reply = await runTurn(messages, toolsByName, openaiTools, ep, turn1);
  console.log(`turn 1 reply:\n${turn1.reply}\n`);

  messages.push({ role: "user", content: contextMessage(PUSHBACK) });
  console.log(`turn 2: ${PUSHBACK}`);
  const turn2: TurnTrace = { searches: [], pages: [], reply: "" };
  turn2.reply = await runTurn(messages, toolsByName, openaiTools, ep, turn2);
  console.log(`turn 2 reply:\n${turn2.reply}\n`);

  // Search counts only matter when turn 1 missed: finding him in two queries is
  // a pass, giving up after two is the regression. Same for re-checking the
  // name in turn 2 — there is nothing to verify if turn 1 already found him.
  const found = mentionsAnswer(turn1.reply);
  const failures: string[] = [];
  if (!found && turn1.searches.length < MIN_SEARCHES) {
    failures.push(`turn 1 gave up after ${turn1.searches.length} searches, wanted at least ${MIN_SEARCHES}`);
  }
  if (asksForTheName(turn1.reply)) failures.push("turn 1 asked the user for a name");
  if (claimsBlocked(turn1.reply)) failures.push("turn 1 claimed a site (LinkedIn) blocks it");
  if (!found) failures.push("turn 1 did not mention both Mutagent and Özafşar");
  if (!found && !searchedTheClaim(turn2.searches)) failures.push("turn 2 did not search the name the user supplied");
  if (!agrees(turn2.reply)) failures.push("turn 2 did not agree with the named person");
  if (deniesTheClaim(turn2.reply)) failures.push("turn 2 called the claim false or a hallucination");

  const summary = {
    pass: failures.length === 0,
    model: ep.model,
    turn1: { searches: turn1.searches, pages: turn1.pages, reply: turn1.reply },
    turn2: { searches: turn2.searches, pages: turn2.pages, reply: turn2.reply },
    failures,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) {
    console.error(failures.map((f) => `- ${f}`).join("\n"));
    return 1;
  }
  console.log("pass");
  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
