# AI assistant channel: bookable from Claude, ChatGPT and other assistants

Date: 2026-11-17. Owner: "LETS GO WITH THE BOARD DECISION. LETS BUILD IT OUT AND FULLY TEST."

## Why

The owner asked whether TaskRabbit uses AI agents. Checked the same day:

- TaskRabbit is bookable inside Claude (its own blog, 2026-06-10) and runs an AI agent on support chat (Zendesk).
- Thumbtack is in ChatGPT (October 2025), Claude (April 2026) and Alexa+.
- Angi is in ChatGPT (March 2026) and Gemini (August 2026), and is rebuilding as an AI-native marketplace.

The board ruled two steps. First, connect Sora to missed and after-hours calls (TELNYX-OVERFLOW-01, built in September and not yet connected). Second, make AssembleAtEase bookable from AI assistants. Demand is the bottleneck. An assistant that cannot find our prices cannot send a customer.

## What was built

A remote MCP server (Model Context Protocol, the connector standard Claude, ChatGPT and Gemini use) at `https://www.assembleatease.com/api/mcp`. It has six read-only tools:

| Tool | Answers from |
|---|---|
| `list_services` | catalog (`assets/js/booking-source-of-truth.js`), "From" rule (`scripts/lib/catalog-prices.mjs`), bundles priced by the checkout engine |
| `search_services` | the booking page's own search rule (`assets/js/catalog-search.js`), then word by word for a sentence |
| `estimate_price` | `calculateBookingPricing`, the engine `api/booking.js` charges with, in every service-call zone |
| `get_appointment_times` | `bookingWindow` and `openBookingSlots`, the gates `api/booking.js` applies |
| `get_service_area` | `AUTOMATIC_DISPATCH_*` in `api/_source-of-truth.js` and the llms.txt "Where" sentence |
| `get_booking_policies` | `api/_public-facts.js`, the sentences llms.txt carries; contact details and hours from the Organization JSON-LD |

Each tool returns booking links to `/book`. A priced estimate links to `/book?add=<service>|<item>|<qty>`; `book.html` fills the cart from the catalog, never from the link, and the server re-prices at checkout as it always has. Links carry `utm_source=claude|chatgpt|gemini|ai_assistant`, `utm_medium=ai_assistant` and `utm_campaign=mcp_<tool>`. A booking from that link lands in the owner's acquisition report as the new **AI assistant** channel. That channel also counts ChatGPT's own `utm_source=chatgpt.com` links and untagged visits referred from chatgpt.com, claude.ai, gemini.google.com, perplexity.ai and copilot.microsoft.com.

Public help page: `/ai-assistants` (connector address, steps for Claude and ChatGPT, what it can look up, what it receives). It is linked from `/contact`, `llms.txt` and the sitemap.

## Design rules and where they came from

- **Read only, checkout on our site.** ChatGPT requires external checkout on our own domain. Claude's directory does not accept connectors that move money. The card hold, the terms the customer accepts and server re-pricing stay where they are. No tool imports a module that books, charges, emails, texts or dispatches; `test-mcp-server` fails if one does.
- **Every tool carries a title and `readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true`.** Both directories require the hints, and Claude runs read-only tools without a per-call prompt.
- **No location in any input schema.** ChatGPT's submission rules forbid raw location fields. `get_service_area` returns the ZIP lists and the assistant compares.
- **No promotions or subscriptions.** ChatGPT allows physical goods and services only; AssembleCash, Setup Club and memberships are never mentioned.
- **Tool text describes, never steers.** Claude rejects descriptions that instruct the model.
- **Stateless, one JSON answer per POST.** GET and DELETE answer 405, which the specification allows. The `Mcp-Session-Id` stores nothing; it only carries which assistant connected (`claude.<uuid>`), so later links name the source. Claude's guide says `clientInfo` varies ("claude-ai", "Anthropic", ...), so it is used for attribution only, never for a decision.
- **Origin.** The specification requires a 403 for an unrecognised Origin. Claude's guide names over-strict Origin checks as a common connection failure. Every subdomain of the assistant companies is accepted, and each refusal is logged as `mcp origin refused`.
- **Its own rate limit:** `rl:mcp`, 120 a minute per address. Assistants call from shared server addresses, so the 10-a-minute default would throttle every customer at once.
- **Usage counted, nothing asked kept.** Each tool call writes one `operational_events` row (`ai_assistant_tool_call`, the tool, the assistant, the outcome). No arguments and no IP address.

## Evidence

- `scripts/test-mcp-server.mjs`: 30 checks. Protocol (versions, 202, 405, 403, 400, batch, errors), directory rules, prices equal to the engine in all three zones and all three discount tiers, search equal to the page rule, dates and windows equal to the booking API, policies equal to llms.txt, no writes, usage rows, customer-language rules, attribution through to the owner report.
- `scripts/test-mcp-sdk-client.mjs`: 11 checks with the official MCP TypeScript SDK client (`@modelcontextprotocol/sdk` 1.32.2, dev dependency) over real HTTP. It connects, negotiates 2025-11-25, lists and calls all six tools, sends its session and version headers on every request, ends its session, and is served 2025-03-26 when it asks for it.
- `tests/e2e/ai-assistant-cart.spec.mjs`: 4 browser tests. The cart link opens `/book` with the same items and quantities. The page's own total equals the connector's estimate and the engine in every zone. Unknown names are skipped and quantities are bounded. The visit is attributed to the assistant after Accept.
- `scripts/generate-llms.mjs --check` passed before the shared facts module existed and after it, byte for byte.

## Not verified here, and why

- **A real Claude or ChatGPT conversation.** Claude reaches a connector from Anthropic's servers, so it needs the deployed URL. It needs the owner's word to push.
- **The exact `clientInfo` names and any Origin header Claude and ChatGPT send.** They show in the first live calls (usage rows, `mcp origin refused` in Vercel logs).
- **The MCP Inspector run** that Claude's portal asks a submitter to confirm. Running it here was refused because it downloads and runs an outside package. The SDK client test covers the same calls.
- **Attribution needs Accept.** `attribution.js` stores the source only after the visitor accepts cookies (existing consent design). Visitors who decline still book, but the booking shows no channel. Usage rows are counted either way.

## Activation (owner)

1. Push and merge; Vercel deploys.
2. Add the connector in Claude: Customize > Connectors > Add > Add custom connector, name AssembleAtEase, URL `https://www.assembleatease.com/api/mcp`, No sign-in. Ask "How much to assemble a queen bed and mount a 55 inch TV in Austin?", approve the tool call, open the link.
3. Check Vercel logs for `/api/mcp` and any `mcp origin refused`.
4. Submit to the Claude directory at claude.ai/directory/manage (paid plan; public docs: `/ai-assistants`). Submit to ChatGPT through the OpenAI Developer Platform (verified organization; privacy policy `/privacy`; support contact). Both are account actions for the owner.
