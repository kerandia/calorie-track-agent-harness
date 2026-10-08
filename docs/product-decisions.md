# Product decisions — October 2026

Recorded so the channel, payments, and computer review can be picked up later.
None of this is built. Telegram, the Upstash Box, and `/approve` stay as they are.

## Messaging

Photon Spectrum is the iMessage path. Reply inside the webhook worker with
`spectrum-ts` `imessage.config()`. There is no public HTTP send API. Credentials
are `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, and a webhook secret stored
once as `SPECTRUM_WEBHOOK_SECRET`. Verify `X-Spectrum-Signature` over the raw
body and reject replays older than five minutes.

Use a dedicated Photon Business line ($250 per line per month) when every user
must text one Sezar number. Free is a 10-person inbound test on a shared pool:
each person can see a different number, a user must be registered as
`type: "shared"`, and Sezar cannot text a number that never texted first. Pro
($25 per month) is the same shared pool with a higher user cap. Leave auto-scale
off until a second line is deliberate, and pin `space.phone` so replies do not
jump numbers. Stable routing quota is 5,000 sent messages per server per day and
50 new outbound conversations per line per day.

The tenant key for iMessage is `imessage:` plus the sender E.164. Drop group
spaces. Dedupe on `message.id`. Photos are often HEIC; voice is `audio/mp4` or
`audio/x-m4a`, not Telegram ogg.

Linq was considered and is the same product shape: hosted iMessage, they assign
the number, no bring-your-own number in the V3 API. Hobby is a shared line and
a CLI, which production must not use. Pro starts at about $260 per month for a
dedicated line. A production reply is `POST /v3/messages` with the line pinned
in `from`.

Do not run a personal Mac, BlueBubbles, or `imsg` as the production line. A US
number does not bind to iCloud by itself, and a VM Apple ID gets locked. Do not
use `wacli` or any unofficial WhatsApp Web session.

Official WhatsApp (Kapso is the cleanest transport in the tool list) is a poor
fit for a general personal agent. Meta's 15 January 2026 rule bans
general-purpose AI assistants as the primary WhatsApp product. A narrow meal-log
bot is a different product. Telegram stays on the existing webhook.

Before a second channel exists, prefix tenant ids (`telegram:`, `imessage:`,
`whatsapp:`). Today production uses the raw Telegram numeric id. The verified
channel sender is the tenant. The model never chooses `tenantId`. A phone number
typed in chat, or an email address, is never an automatic merge key.

## Payments

This is the piece most likely to be added next. The model never gets a pay tool
that spends inline, and it never sees a key or chooses a wallet.

Stage the exact payee, amount, asset, and URL the way artifact approval already
stages a publish. Only a standalone `/approve <token>` from the
channel-authenticated user executes the spend. Caps live in code and, where the
provider allows, on the wallet itself. The Upstash Box never receives a signer.

Two shapes fit:

- **Stripe Link** for card purchases. Link spends the user's existing card
  through one-time cards or a shared payment token, with approval in the Link
  app. The card number never lands in Redis. Link Agent Wallet is US and Canada.
- **A small per-tenant CDP / x402 wallet** for paying APIs in USDC. x402 is HTTP
  402 for metered APIs, not a general wallet. One wallet record per tenant. A
  CDP spend permission is the second cap. Privy or Sponge can hold the signer;
  Sponge's default is autonomous spend, which Sezar still refuses without
  `/approve`.

Lightspark Grid is a full dollar, stablecoin, and bitcoin account per user, with
Visa and agent pockets. That is more KYC than a meal agent needs. Unifold is
deposit and onramp only. Autumn bills the user for Sezar on Stripe; it is not
how the agent spends. Plaid and MoneyKit read a bank. Mercury, Slash, and Qonto
are the company bank — those tokens stay out of the model.

OpenInstinct wires Stripe Link without a second approval, and its docs admit
payment credentials can land in tool results. If Link is added here, keep
Sezar's `/approve` in front of it.

## Places and web search

Sezar has no web-search tool. `run_shell` and `run_code` can fetch a URL the
model already knows. `query_meals` searches that user's meals only. `publish_map`
plots places the model already named and geocodes up to 25 of them. It does not
search for places.

Exa Places (about 211 million places, hours, ratings, phone, website,
coordinates, included on the existing Exa search API) is the thing to add later:
a typed `search_places` tool plus `EXA_API_KEY`, then pass the chosen places and
coordinates into the existing `publish_map`. Do not search the web from the
sandbox.

## Personal Agent Protocol

Sierra and Meta announced Personal Agent Protocol on 6 October 2026. A personal
agent acts at a company through a guest session, then OAuth, with separate read
and write scopes. The company can serve that through its site, MCP, OpenAPI, or
its own agent. The v0.1 spec and reference implementation were not published at
the time of this note.

Do not implement it yet. The planned ChatGPT / MCP handoff should follow the
spec once v0.1 exists. Protocol access replaces clicking through a company's
website. Until then, do not put an unauthenticated MCP endpoint online.

## OpenInstinct

Do not move Sezar onto the OpenInstinct Eve template. It targets Vercel, Linq,
Better Auth, and a Kernel cloud browser, and the template says it is not
software intended for production. Link spend and Gmail or calendar actions there
have no extra approval step.

Ideas worth taking later, on Sezar's own stack: the verified sender is the
tenant, secrets live in a vault as capability handles, and a browser session is
only the later computer-session layer. Personal Agent Protocol may replace
browser checkout before that layer is built.

## Modal, October 2026

Neither update replaces the Upstash Box.

**Sticky sessions do not fit.** `@modal.sessioned()` pins later HTTP or
WebSocket requests to one Modal Server container for the life of a session token
(idle timeout 600 seconds by default). That is for collaborative editors, games,
and voice or video rooms. Sezar's turn is a Cloud Run webhook that reads a Redis
inbox and exits. Sticky sessions are not a per-user computer, not a tenant
boundary, and not a place to keep a wallet or a browser profile.

**VM sandboxes are the later computer, and only if we need one.**
`modal.Sandbox.create(..., runtime="vm")` is generally available as of 1 October
2026. It is a full Linux VM with the same sandbox API, sub-second cold start,
and the same usage pricing. gVisor stays the default. Use `runtime="vm"` when
the job needs Docker, FUSE, or a kernel feature: a real dev environment, a
multi-container app, a graphical browser. Linear coding sessions and Legora
evals are that shape.

Sezar's Box is a one-shot machine for curl, parsing, and charts, created lazily
and deleted at the end of the turn. It receives `TENANT_ID` and no Redis
credentials. Leave that on Upstash. A Modal VM becomes relevant only when the
deferred computer-session layer needs a persistent per-tenant machine. Even
then it holds no wallet keys and no copy of the tenant's Redis or Vector data.
Secrets stay in the vault as handles.

## Landing

The manifesto at `/` and the calmer sales page at `/classic` should become one
page. Keep "You eat. You text. Sezar remembers." Keep the chat demo and the
three steps from `/classic`. The particle field can stay as a background that
does not move the buttons. Do not mention iMessage until a line can receive
texts. Telegram remains the call to action. This redesign was discussed and not
started.

## Invariants that still hold

- High-impact actions — publish, spend, send a message, change a credential —
  need a standalone user confirmation. A model flag such as `confirmed: true`
  is not that confirmation.
- Secrets stay in a vault as capabilities. They never enter the model context
  or the Box.
- Health numbers are estimates and coaching context, not a medical diagnosis.
