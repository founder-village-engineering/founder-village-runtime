# Import Grok Bot team data

The operator CLI imports a reviewed JSON archive into the private `founder-village-team` database. Two separate inputs identify the source records and their verified destination owners. Both inputs must be owner-readable regular files outside Git checkouts. Protect the parent directory with mode 0700 and the files with mode 0600.

## Collect the source inventory

Select the intended source team. List its bots, their stable IDs, owners, managers and sharing settings. Each teammate's chat with a Team Bot is private to that teammate. Obtain exports with the respective account's authority and keep those chats separate. Obtain the source team roster and the matching Founder Village tenant and verified OIDC actors from the respective administrators. A display name or similar email address is insufficient for this mapping. [Grok Bot team permissions](https://docs.x.ai/grok-bot/team-bots)

Cursor support describes using a bot's `ReadTranscript` tool from the account with access. Page through the complete history, including older messages. For each conversation, retain its stable identifiers, author, role, timestamp, and exact text. Check the first and last messages and source counts before marking the export complete. A call transcript download is specific to that call. [Cursor's transcript export instructions](https://forum.cursor.com/t/grok-bot-forever-box-agent-transcripts-mirror-never-created-server-agent-proxy-transcript-tail-connecterror/172494/13) · [Grok Bot call transcripts](https://docs.x.ai/grok-bot/chat-and-collaboration)

## Normalize and reconcile

Use the [synthetic archive and mapping](../tests/team-import.test.ts) for complete examples of the two JSON shapes. The format name is `founder-village-grok-import-v1`. This format belongs to the destination. Prepare it from the authorized source exports and reconcile it against the original inventory. Copy message strings verbatim, store messages oldest first and preserve source IDs. Use timestamps with an explicit UTC offset and at most six fractional digits.

- The archive records the source team ID, bots and conversations. Bot visibility is `private`, `selected` or `team`. Reader and manager arrays use source member IDs and exclude the owner. Readers and managers are distinct. Only the owner can see a private bot. Bot configuration accepts the model string, skill/plugin/automation/file label lists and memory text. The configuration is stored as inert data.
- A conversation has one source owner, private visibility, a stable source ID, an optional bot reference (`null` when absent) and its ordered messages. Each message has its own source ID within the conversation, original creation timestamp, role and text. `authorName` preserves an optional source display label. A group thread, binary attachment, actionable integration, service credential, or file body needs a matching destination representation before migration. Stop if the source inventory includes such items. Preserve the originals and record the coverage gap privately.
- Review all source text and configuration for embedded credentials before import. Service-account sessions, vault contents and access tokens stay with their provider. Configure replacement connections through the destination's secret store. The CLI also checks decoded text using Gitleaks. It rejects unrecognized fields and access modes.
- The mapping contains the same source team ID, the verified destination tenant UUID, each source member's exact verified `issuer|subject` destination actor, a SHA-256 digest of the complete reviewed archive file, and independently reconciled bot, conversation and message totals. Obtain the digest with `shasum -a 256 /private/operator/archive.json`. Fill `exportSha256` with the hex digest in the private mapping. The CLI prints counts only. Its checks establish internal consistency of the supplied records. Upstream coverage depends on the source inventory.

## Verify and apply

Run the offline plan from the runtime checkout. Supply private absolute input paths.

```sh
node --import tsx scripts/import-grok-team.ts plan /private/operator/archive.json /private/operator/mapping.json
```

Apply with the destination namespace's scoped migration database connection and the runtime's existing Team content key injected by the approved secret store. The supported settings are `MIGRATION_FOUNDER_VILLAGE_TEAM_DATABASE_URL` and `TEAM_CONTENT_KEY` (or their `_FILE` variants). Use the same secret version as the deployed API. Apply checks existing bot and conversation ciphertext in the destination tenant when available. An empty tenant has no stored key verifier. To verify the key independently before importing private data, create a synthetic private conversation from the destination API, then perform the import with its existing content key. Include that key in the destination recovery process.

```sh
node --import tsx scripts/import-grok-team.ts apply /private/operator/archive.json /private/operator/mapping.json
```

Apply requires the registered database, existing tenant, active mapped memberships, the current checksummed team migrations and correct encryption key. A team-visible bot additionally requires an exact match between the supplied source roster and the active destination roster. The transaction binds one source team to one tenant and a single destination actor to each source member. Rerunning an identical archive returns zero newly inserted rows. A changed row, conflicting mapping, mismatched digest, unsupported field or inaccessible bot aborts the batch. Successful batch counts, digest and database operator are recorded in `app.team_import_batches`.

Reconcile the reported bot, chat and message counts with the original export. Verify access from the original owner and an unrelated member after sign-in before relying on the migrated data. Retain the private source and identity mapping until the destination backup and isolated restore have been verified.
