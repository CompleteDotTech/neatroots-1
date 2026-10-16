# Neatlogs Cloud

neatroots reaches Neatlogs Cloud through public endpoints only. Sending goes the way any SDK does:
OTLP/protobuf to the public ingest endpoint (`https://ingest.neatlogs.com/v1/traces`, or
`eu.ingest.neatlogs.com`) with your project API key as `x-api-key`. Importing reads the Neatlogs
public API (`https://app.neatlogs.com/api/v1/public`), which takes a different credential: a
service-account token (`nlsa_…`) sent as `Authorization: Bearer`, with `x-project-id` naming the
project.

## Compatibility

- **Ingest.** neatroots accepts exactly what the SDKs send to the cloud: `POST /v1/traces` (protobuf or
  JSON, gzip, `x-api-key`), `/v1/logs`, and the doctor read-back `GET /api/traces/v3/:traceId`, so
  `neatlogs doctor --probe` passes against neatroots. Changing `NEATLOGS_ENDPOINT` is the only switch
  between neatroots and the cloud.
- **Storage.** Spans are stored losslessly in their OTLP form: resource and scope, typed attribute
  values (int64 kept as decimal strings, int vs double, bytes), events, links, status, trace state.
  Large values go to content-addressed blob files and are restored on read.
- **Forwarding.** A forward re-encodes the stored spans as an `ExportTraceServiceRequest` and sends
  them first, then each trace's `neatlogs.trace.complete` marker in a second request, as the SDKs do.
  A run without a marker (interrupted) gets one synthesized under its root.
- **Findings.** neatroots adds `neatroots.findings` (JSON) and `neatroots.finding.checks` to evidence spans, and
  `neatroots.findings.count`, `neatroots.run.summary` and `neatroots.run.explanation` to the root.
  They travel as ordinary span attributes.

The relay is tested end to end by forwarding into a second neatroots instance and comparing spans.

## Sending

- One run: **Send run to Cloud** in the app, or `neatroots cloud forward <trace-id>`.
- Every finished run of a project: Settings → Projects → Forward to Cloud, or
  `neatroots cloud auto <project> on`.
- From a coding agent: `push_to_cloud` asks; you confirm in the app before anything is sent.

Before each send neatroots shows a redaction preview. Emails, phone numbers, private keys and credentials
are always redacted: API keys (OpenAI, Anthropic, AWS access key ids, GitHub classic and fine-grained
tokens, Slack, Google, Stripe, Hugging Face, Groq, npm, Google OAuth), bearer tokens, JWTs, `Basic`
authorization, AWS secret access keys and passwords in URLs (`scheme://user:password@host`). Add your own
patterns in Settings. Redaction also inspects OTLP byte
attributes when they contain valid UTF-8 text, while arbitrary binary values remain unchanged. The
SDK's own `mask` and PII options still apply first, in your process. Every send is logged (Settings →
Neatlogs Cloud).

The project API key is stored in the macOS Keychain (`neatroots cloud login`), never in the database.

## Importing

Importing needs a Neatlogs service-account token (see the
[public API docs](https://docs.neatlogs.com/api-reference) for creating one). The project API key
that sends runs can't read them.

```bash
neatroots cloud token              # paste the nlsa_… token; it goes to the macOS Keychain
neatroots cloud project            # the projects it can read; neatroots cloud project <id> picks one
```

Or **Settings → Neatlogs Cloud → Import from Neatlogs Cloud**: store the token and choose the
project there. With one project, neatroots picks it. Then a production run can be explained,
checked and replayed on your machine:

- **Add data → Neatlogs Cloud** lists recent traces; pick the ones to import.
- `neatroots import neatlogs-cloud` imports the most recent ones (`--trace-ids a,b` for specific
  traces, `--since 24h`, `--limit 20`).
- From a coding agent: `list_cloud_traces`, then `import_cloud_trace`.

neatroots fetches each trace's export and the full input, output and error of every span, and stores
them like any other run (marked with where they came from). Imported runs are never sent back
automatically.
