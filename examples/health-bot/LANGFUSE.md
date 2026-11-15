# Tracing the health bot with Langfuse

The health bot can send a trace of every conversation to Langfuse Cloud, so you can
open a conversation in a browser and see each model call and each tool call. It is
off by default and only turns on when you add two keys to `.env`.

## Read this first: privacy

A trace holds the full conversation text, including the system prompt, every patient
message, every reply and every tool argument. It is sent to Langfuse's servers.

- The health bot's data is synthetic (see `SPEC.md`). That is the only reason this is
  safe to switch on.
- **Do not send real patient data to a cloud tracing service** without redaction and a
  data processing agreement (for health data in the US, a HIPAA business associate
  agreement) with the vendor. Langfuse lists a separate HIPAA region, but that is a
  contract and configuration question to settle before any real data, not something this
  integration handles.
- **This integration has no redaction hook yet.** Nothing is masked or removed before
  sending. (The SDK has a `mask` option on its span processor. It is not wired up.)
- No user id and no IP address is recorded. The only identifier is the bot's
  `conversation_id`, a random UUID.

## What gets recorded

| In Langfuse | What it is in the bot |
|---|---|
| Session | One bot conversation. The session id is the bot's `conversation_id`. |
| Trace | One `POST /chat` turn. Named `chat-turn`. Input is the patient message, output is the reply. |
| Generation | One Anthropic `messages.create` call. Model, input (the system prompt first, then the conversation as sent), output (the assistant content blocks), token usage, latency, `max_tokens` and effort. |
| Tool span | One tool call, a child of the turn. Named after the tool (`book_appointment`, ...). Input is the arguments, output is the status the tool returned. A tool that returns an error status is marked `ERROR`. |

Every trace is tagged `defect:none` or `defect:<name>` (the `--defect=` build of the bot),
and carries the bot model as metadata. A turn that fails (HTTP 502) is recorded with level
`ERROR` and the same fixed message the caller got. Provider error details are never recorded.

A turn with two tool rounds looks like this in the trace tree:

```
chat-turn
  messages.create        (generation, tool_use)
  cancel_appointment     (tool)
  messages.create        (generation, end_turn)
```

Cost: the bot reports token counts and the model name. Langfuse works the cost out from
its own price list, matched on the model name. Whether `claude-haiku-5-5` is in that list
is not something I could check without an account (see the end of this file). If the cost
column is empty, add the model under Project settings, Models, with its prices.

The bot's `GET /health` and `GET /appointments/...` requests, and requests rejected before
a turn starts (bad JSON, unknown conversation), are not traced.

## Turn it on

Do these yourself. Never paste a key into chat, a commit or a screenshot.

1. Sign up at <https://cloud.langfuse.com/auth/sign-up> (free tier is enough). Langfuse
   asks you to create an organization and a project. Name them anything, for example
   `blueprint-evals` and `health-bot`.
2. Pick the region when you sign up or in your account. **The region decides the base URL,
   and keys only work against the region they were made in.**
   - EU (the default): `https://cloud.langfuse.com`
   - US: `https://us.cloud.langfuse.com`
   - Japan: `https://jp.cloud.langfuse.com`, HIPAA: `https://hipaa.cloud.langfuse.com`
3. In the project, open Settings, then API Keys, and create new API credentials. You get
   a public key (`pk-lf-...`) and a secret key (`sk-lf-...`). Copy the secret key when it
   is shown. Langfuse may not show it again, and if you lose it you create a new pair.
4. Copy `.env.example` to `.env` if you have not already, and add (uncommented, no quotes):

   ```
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
   ```

   Leave `LANGFUSE_BASE_URL` out (or blank) for the EU region. `.env` is gitignored.
5. Restart the bot: `npm run health-bot`. The first lines it prints include one of:

   ```
   Langfuse tracing: on (cloud.langfuse.com)
   Langfuse tracing: off (set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY in .env to turn it on)
   ```

   The line shows the host only, never a key. "on" means the SDK started. It does not
   prove the keys are right, because the bot never waits for Langfuse. A wrong key shows
   up as an empty project (see Troubleshooting).
6. Send one message:

   ```
   curl -s localhost:4020/chat -H 'content-type: application/json' \
     -d '{"message":"Hi, can you move my appointment to Friday at 2pm?"}'
   ```

   Spans are sent in batches in the background, so give it about 10 seconds. The reply
   comes back exactly as it does without tracing.
7. To turn tracing off again, remove the keys from `.env` and restart.

Stopping the bot with Ctrl-C (or `kill`) flushes whatever is still buffered, for up to 5
seconds, before it exits. This only happens when tracing is on.

## Where to look in Langfuse

1. **Tracing** in the left menu lists traces. Each `POST /chat` turn is one row named
   `chat-turn`, with the patient message as input and the reply as output. Filter by tag
   (`defect:none`) to separate the correct bot from a defective build.
2. **Sessions** in the left menu lists conversations. Open one to see all its turns in
   order. Send a second message with the `conversation_id` from the first reply and it
   joins the same session. The session id shown in the list is that `conversation_id`.
3. Click a trace to see the tree. Look at:
   - **The generation's input.** The system prompt is the first message. This is the exact
     prompt the bot used, so a wrong behavior can be matched to the rule text. In the
     second generation of a tool turn you see the first call's tool request and the tool
     result the bot fed back.
   - **Token usage and latency** on each generation. Usage is split into input, output
     and cache buckets. Latency is the whole `messages.create` call.
   - **The tool spans.** Name, arguments and the returned status. This is where you check
     the bot called `escalate_emergency` for an emergency, or that it did not book
     without a confirmation (the `no-confirm` defect).
   - **Level.** A red `ERROR` marks a tool that rejected its input or a turn that failed.

## Troubleshooting

- **Nothing shows up.** Check the project and region match the keys. A key from the US
  region sent to the EU URL is rejected, and the bot stays silent on purpose. To see the
  SDK's own messages, start the bot with `LANGFUSE_LOG_LEVEL=DEBUG` set (in `.env` or the
  shell). That turns its logger back on, which can print span names.
- **Duplicate or stray generations.** None should appear. The Anthropic SDK has built-in
  OpenTelemetry spans. The bot turns them off for its client and the exporter also drops
  anything that is not a Langfuse observation, so every model call is recorded once, by
  the bot.
- **The bot says tracing "could not start".** The SDK failed to load or the base URL is
  not an http(s) URL. The bot keeps running untraced. The line shows only an error class
  name.

## How it works, briefly

`tracing.ts` defines a small `Tracer` interface and a no-op default. `bot.ts` reports each
turn, model call and tool call to it. `langfuse-tracer.ts` is the Langfuse implementation,
loaded with a dynamic import only when both keys are set. Every tracer call is wrapped so
that an exception or a rejected promise cannot reach the request. The SDK records spans in
memory and sends them in the background, so a Langfuse outage cannot slow or break a reply.
Tests pass a recording fake instead (`tests/health-bot-tracing.test.ts`).

Packages (devDependencies, exact versions, because `npm run health-bot` runs through
`tsx` like the other dev tools and the published library does not use them):
`@langfuse/tracing`, `@langfuse/otel`, `@langfuse/core` 6.1.0, `@opentelemetry/sdk-node`
0.223.0, plus the OpenTelemetry packages those two require as peers.

## Next steps (not built yet)

1. **Link eval failures to sessions.** The Langfuse session id is the bot's
   `conversation_id`. The eval framework already keeps it: for the `http` target, every
   assistant turn in a saved run keeps the bot's whole JSON reply in `turns[].raw`
   (`Turn.raw` in `src/core/trace.ts`, filled by `src/core/runner.ts`). So the id is at
   `results[].trace.turns[].raw.conversation_id` in the run record
   `<workdir>/.evals/runs/<suiteId>.json` (written by `src/store/suites.ts`). The runner
   itself holds the session only in memory and does not save it as its own field. A small
   reporter or a helper that reads that path can print a Langfuse session link next to
   each failed run.
2. **Push judge verdicts back as Langfuse scores.** After a run, attach each grader
   result (and the judge's verdict) to the matching session or trace as a score, so
   Langfuse can filter and chart failures. Needs the trace id as well as the session id.
3. **Build datasets from failing sessions.** Turn sessions where a grader failed into
   Langfuse dataset items, then replay them against a new bot build.

## What I could not verify without an account

- That Langfuse Cloud accepts what the bot sends and shows it as described here. The tests
  check the exact OpenTelemetry attributes the SDK produces (session id, tags, nesting,
  usage, tool spans) against an in-memory exporter, and the real SDK starts and shuts down
  cleanly against a closed port. No request has been made to Langfuse.
- The UI labels and menu names above come from the Langfuse docs, not from a login. They
  may be named a little differently.
- Whether `claude-haiku-5-5` is matched by Langfuse's built-in model price list, so that
  cost fills in on its own.
- The `cache_creation_input_tokens` usage key. The docs confirm `input`, `output` and
  `cache_read_input_tokens` only. The bot does not use prompt caching, so these cache
  keys are normally absent and nothing depends on them.
- How a bad key or a wrong region looks in the UI. The bot hides export errors on purpose.
- The Langfuse "Hobby" plan limits and data retention.
