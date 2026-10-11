# Health direction: channel-first general agent

Health is moving toward a general personal agent. The account boundary should be
the channel that has already authenticated the person, not a traditional email or
password account. Telegram is the current channel: the verified `from.id` on an
inbound bot update is the tenant key used by Redis, Flue sessions, Vector
namespaces, inbox locks, and the dashboard login link.

## What already exists

- Telegram webhook ingestion with per-user ordering, deduplication, burst
  coalescing, retries, and serialized Flue turns.
- Tenant-prefixed persistent state: meals, daily totals, profile, assumptions,
  photo memory, semantic meal recall, and Flue session persistence.
- An ephemeral Upstash Box Linux computer created lazily for an agent turn.
  `run_shell` and `run_code` can install packages, fetch public URLs, parse files,
  calculate results, and make charts. The box receives `TENANT_ID` but has no
  direct Redis access; the agent must query data through typed tools first.
- Telegram photo and voice inputs, vision fallback, speech-to-text, and the
  existing dashboard magic link.
- Artifacts the agent publishes for a user and can revise later at the same
  URL: pages on Upstash Blob (hashed per-tenant prefix, unlisted URLs, rendered
  into a fixed house shell from a sanitized body fragment) and interactive maps
  on MapToAgent. An artifact registry in Redis is the index and the tenancy
  boundary; the model only sees ids from it. Publishing, updating and deleting
  are staged and require a standalone `/approve <token>` message from the
  channel-authenticated user, so no model output reaches a public URL on its own.
- Cross-channel linking by phone number: `/link` in Telegram shares the number
  through Telegram's contact button (accepted only when `contact.user_id` is
  the sender's own id), and iMessage from that Apple handle then lands in the
  same tenant. A number typed in a message is never accepted.
- One continuous Flue session per tenant (the agent URL's instance id is the
  tenant, not the message id), compacted past ~60k tokens.

The Box is not yet a persistent personal computer. It does not retain browser
profiles, long-lived credentials, files, or background jobs between turns. That
is a separate capability with a larger security boundary.

## Identity model

The phone number / channel idea is directionally right, but the implementation
must describe what we actually verify:

- Telegram currently gives us a Telegram account/user ID, not a carrier-attested
  phone number. Telegram may have verified a phone number internally, but the bot
  does not receive that as proof that we can independently validate.
- A future WhatsApp Business or SMS channel can use the provider's sender
  identity. A first inbound message can create or claim a pending tenant, but
  account recovery and number changes need an explicit re-verification flow.
- Never accept a phone number supplied in text as identity. Never use an email
  address as an automatic merge key. Never let a model choose `tenantId`.
- A SIM swap, stolen unlocked device, compromised Telegram account, or hijacked
  messaging session can act as the channel user. High-impact actions need an
  additional confirmation step and a visible audit record.

## ChatGPT / MCP handoff

ChatGPT is a second interface, not an identity provider. The user should start a
one-time “connect Health” action in the Telegram conversation. Health mints a
short-lived, single-use handoff token bound to the Telegram tenant and intended
for one ChatGPT connection. The handoff opens a Health connection page, where the
user confirms the channel identity and grants narrow scopes. Health then issues a
short-lived MCP access credential or establishes a server-side connection record.

The MCP server must derive the tenant from that verified handoff credential. Tool
arguments never include tenant IDs. Read tools and write tools have separate
scopes; writes are idempotent where possible, auditable, and require confirmation
for deletion, external messages, purchases, or credential changes.

The current uncommitted Auth0/OIDC/MCP experiment was removed. Auth0 credentials
are not part of the app configuration. We will implement the handoff after the
MCP transport and ChatGPT connection contract are finalized, rather than putting
an unauthenticated endpoint online.

## General-agent layers

Build in this order:

1. **Channel identity and handoff:** Telegram now; add WhatsApp/iMessage through
   provider adapters that normalize sender identity and inbound events.
2. **Shared domain tools:** typed profile, meals, workouts, supplements,
   measurements, files, reminders, and connected-service records. Telegram and
   ChatGPT call the same services.
3. **Computer sessions:** persistent per-tenant workspaces with expiring browser
   sessions, explicit credential grants, secrets isolated from model output,
   allowlisted network access, resource limits, and an activity log.
4. **MCP app:** focused tools plus an optional embedded daily view. Tool results
   contain only the requested data; UI metadata never substitutes for auth.
5. **Connected services:** Apple Health and other providers through explicit
   device/app permissions and import provenance. ChatGPT cannot silently read a
   different connector's data.

## Data and safety invariants

- Every persisted key and every Flue session is tenant-scoped.
- Every tool call records actor/channel, action, target, result status, and time;
  never record access tokens, passwords, OTPs, or full message content by default.
- Credentials live in a dedicated encrypted vault; the model gets a capability,
  not the secret. TOTP generation is a later, separately reviewed capability.
- Imported health/workout data retains source, units, timezone, observed-at time,
  import ID, and deduplication key.
- Health calculations are estimates and coaching context, not medical diagnosis.

## Immediate next slice

Implement a channel-neutral identity and handoff module around the existing
Telegram login-token pattern: purpose, tenant, requested scopes, expiry, one-time
consumption, and audit event. Add an MCP endpoint only after this handoff can be
tested end-to-end with a local/mock ChatGPT client. Then expose read-only profile,
meal, and daily-total tools before adding writes or computer credentials.
