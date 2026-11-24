# Founder Village Team

The API serves `/v1/team` using the `founder-village-team` PostgreSQL namespace. An existing tenant administrator grants membership to the verified OIDC issuer and subject. Tenant discovery returns only enabled memberships. Every other Team route checks the selected application and tenant. SQL row security limits every conversation and its messages to the initiating member. Team tables are accessible through the API and remain untracked in Hasura.

## Open the local workspace

Run `bin/fv up` and `bin/fv local-edge up` in the runtime checkout. Start `bin/fv dev api` there and `npm run dev:team` in the frontend checkout. The frontend is available at `https://team.fv`.

On macOS, run `npm run team:login -- <enrolled-local-subject>` in the runtime checkout. The CLI opens a five-minute link for that member. The browser exchanges it once for a fifteen-minute Team session. The seeded local demonstration uses the subject `founder-village-team`. Production uses the configured OIDC provider and the exact `/auth/callback` on each approved public origin.

## Bot access and chat history

Members can create personal bots and explicitly share bots with the entire tenant. Imported bots also support selected readers and managers. The bot owner and managers can inspect and edit instructions. Other authorized users can see the name and description and use the bot in their own private chat. Configuration edits preserve the access list and append a version with the acting identity. Revoking tenant membership removes access on subsequent requests.

The API encrypts bot settings, conversation titles, messages and replay receipts with AES-256-GCM. Additional authenticated data binds ciphertext to its tenant, record type and record ID. Stable IDs, membership, access lists, timestamps and conversation relationships are visible to the database operator. `TEAM_CONTENT_KEY` holds a dedicated 32-byte hexadecimal key. Protect and restore it with the database. Replacing it requires a coordinated re-encryption of existing ciphertext including bot history.

## Generating replies

Saving a chat message records it in the member's private conversation. Requesting a reply explicitly sends the bot instructions and up to the last 32 turns of that chat to xAI. The server uses the configured model and a fixed inference endpoint. Imported system and tool messages, file references, memory, skills, automations and plugins stay out of the inference request. The history budget is 96,000 characters. [xAI Chat Completions](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions)

Configure `TEAM_XAI_API_KEY` and `TEAM_XAI_MODEL` in the API's scoped secret catalog to enable replies. Bot instructions can influence generated replies, so use the secret store for credentials. The capabilities endpoint reports whether the provider settings are present. Actual provider readiness requires a successful authorized request.

Every write accepts an `idempotency-key`. The runtime persists a reservation before calling xAI and stores one visible reply per original message. A definitive provider rejection allows another attempt. A network failure, lost response or API restart after reservation leaves the attempt reserved or uncertain. A repeated request then returns a conflict. Check stored history and provider evidence before reconciling the attempt.

The operator import accepts a normalized, inventoried source export with explicit actor mappings. [Private team import](../TEAM_IMPORT.md)
