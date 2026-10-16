import { describe, expect, it } from "vitest";
import { decodeTraceProtobuf } from "../src/otlp/codec.js";
import type { AnyValue, KeyValue } from "../src/otlp/types.js";
import { BUILTIN_RULES, compileRules, CREDENTIAL_KINDS, redactBatches, redactString } from "../src/relay/redact.js";
import { batch, hex, makeRoots, s, span } from "./helpers.js";

const KEY = "sk-proj-abcdefghij1234567890ABCDEFghij";
const bytes = (value: string | Uint8Array): AnyValue => ({
  bytesValue: Buffer.from(value).toString("base64"),
});
const byteText = (value: AnyValue): string => {
  if (!("bytesValue" in value)) throw new Error("expected bytesValue");
  return Buffer.from(value.bytesValue, "base64").toString("utf8");
};
const valueFor = (attributes: KeyValue[], key: string): AnyValue => {
  const value = attributes.find((attribute) => attribute.key === key)?.value;
  if (!value) throw new Error(`missing attribute ${key}`);
  return value;
};

describe("redaction before a cloud send", () => {
  it("redacts the same secret in string and byte attributes", () => {
    const b = batch([span({ traceId: hex(16), spanId: hex(8), name: "root", kind: "workflow" })]);
    b.spans[0].attributes = [
      { key: "string-secret", value: { stringValue: KEY } },
      { key: "byte-secret", value: bytes(KEY) },
    ];

    const { batches, hits } = redactBatches([b], BUILTIN_RULES);
    const attributes = batches[0].spans[0].attributes;
    expect(attributes[0].value).toEqual({ stringValue: "[redacted:api_key]" });
    expect(attributes[1].value).toEqual({ bytesValue: Buffer.from("[redacted:api_key]", "utf8").toString("base64") });
    expect(hits.map((hit) => hit.kind)).toEqual(["api_key", "api_key"]);
    expect(JSON.stringify(hits)).not.toContain(KEY);
  });

  it("redacts byte attributes recursively in every OTLP attribute location", () => {
    const custom = "customer-12345";
    const rules = compileRules(["customer-[0-9]+"]);
    const b = batch([span({ traceId: hex(16), spanId: hex(8), name: "root", kind: "workflow" })]);
    b.resource.attributes.push({ key: "resource-secret", value: bytes(KEY) });
    b.scope.attributes = [{ key: "scope-nested", value: { arrayValue: { values: [bytes(KEY)] } } }];
    b.spans[0].attributes = [
      {
        key: "span-nested",
        value: { kvlistValue: { values: [{ key: "credential", value: bytes(`first ${KEY}; second ${KEY}`) }] } },
      },
    ];
    b.spans[0].events = [{ timeUnixNano: "1", name: "event", attributes: [{ key: "event-secret", value: bytes(custom) }] }];
    b.spans[0].links = [{ traceId: hex(16), spanId: hex(8), attributes: [{ key: "link-secret", value: bytes(KEY) }] }];

    const { batches, hits } = redactBatches([b], rules);
    const out = batches[0];
    expect(byteText(valueFor(out.resource.attributes, "resource-secret"))).toBe("[redacted:api_key]");
    const scopeArray = out.scope.attributes![0].value;
    expect("arrayValue" in scopeArray && byteText(scopeArray.arrayValue.values[0])).toBe("[redacted:api_key]");
    const spanList = valueFor(out.spans[0].attributes, "span-nested");
    expect("kvlistValue" in spanList && byteText(spanList.kvlistValue.values[0].value)).toBe(
      "first [redacted:api_key]; second [redacted:api_key]",
    );
    expect(byteText(out.spans[0].events[0].attributes[0].value)).toBe("[redacted:custom]");
    expect(byteText(out.spans[0].links[0].attributes[0].value)).toBe("[redacted:api_key]");
    expect(hits).toHaveLength(6);
    expect(JSON.stringify(hits)).not.toContain(KEY);
    expect(JSON.stringify(hits)).not.toContain(custom);
  });

  it("preserves empty, Unicode, and arbitrary binary byte attributes", () => {
    const empty = bytes("");
    const unicode = bytes("こんにちは 🌱");
    const malformedUtf8 = bytes(Uint8Array.from([0xc3, 0x28]));
    const binary = bytes(Uint8Array.from([0x00, 0x01, 0x02, 0xff]));
    const attributes: KeyValue[] = [
      { key: "empty", value: empty },
      { key: "unicode", value: unicode },
      { key: "malformed", value: malformedUtf8 },
      { key: "binary", value: binary },
    ];
    const b = batch([span({ traceId: hex(16), spanId: hex(8), name: "root", kind: "workflow", attrs: attributes })]);

    const { batches, hits } = redactBatches([b], BUILTIN_RULES);
    const values = ["empty", "unicode", "malformed", "binary"].map((key) => valueFor(batches[0].spans[0].attributes, key));
    expect(values).toEqual([empty, unicode, malformedUtf8, binary]);
    expect(values[0]).toBe(empty);
    expect(values[1]).toBe(unicode);
    expect(values[2]).toBe(malformedUtf8);
    expect(values[3]).toBe(binary);
    expect(hits).toEqual([]);
  });

  it("removes byte-encoded secrets from the protobuf cloud relay payload", async () => {
    const t = await makeRoots({ noEngine: true });
    try {
      const traceId = hex(16);
      const sp = span({ traceId, spanId: hex(8), name: "root", kind: "workflow" });
      sp.attributes.push({ key: "byte-secret", value: bytes(KEY) });
      t.roots.ingest([batch([sp])]);

      const encoded = t.roots.relay.encode([traceId]).main;
      expect(Buffer.from(encoded).includes(Buffer.from(KEY, "utf8"))).toBe(false);
      const decoded = decodeTraceProtobuf(encoded);
      const value = decoded[0].spans[0].attributes.find((attribute) => attribute.key === "byte-secret")!.value;
      expect(byteText(value)).toBe("[redacted:api_key]");
    } finally {
      await t.close();
    }
  });

  it("redacts span names, event names, link and scope attributes, not just span attributes", () => {
    const b = batch([
      span({
        traceId: hex(16),
        spanId: hex(8),
        name: `GET https://api.example.com/x?token=${KEY}`,
        kind: "tool",
        attrs: [s("http.url", `https://api.example.com/x?token=${KEY}`)],
        events: [{ timeUnixNano: "1", name: "mailed bob@example.com", attributes: [] }],
      }),
    ]);
    b.spans[0].links = [{ traceId: hex(16), spanId: hex(8), attributes: [s("owner", "alice@example.com")] }];
    b.scope = { name: "lib", attributes: [s("contact", "carol@example.com")] };

    const { batches, hits } = redactBatches([b], BUILTIN_RULES);
    const out = batches[0];
    const sp = out.spans[0];

    expect(sp.name).toBe("GET https://api.example.com/x?token=[redacted:api_key]");
    expect(sp.events[0].name).toBe("mailed [redacted:email]");
    expect(JSON.stringify(sp.links[0].attributes)).toContain("[redacted:email]");
    expect(JSON.stringify(out.scope.attributes)).toContain("[redacted:email]");

    // Nothing sensitive survives anywhere in the redacted output or in the hit labels.
    const all = JSON.stringify(batches) + JSON.stringify(hits.map((h) => h.where));
    for (const raw of [KEY, "bob@example.com", "alice@example.com", "carol@example.com"]) expect(all).not.toContain(raw);
  });

  it("redacts a bearer token whatever the case of the scheme", () => {
    const tok = "eyJhbGciOiJIUzI1NiJ9.abcdefghij0123456789";
    const b = batch([
      span({
        traceId: hex(16),
        spanId: hex(8),
        name: "call_api",
        kind: "tool",
        attrs: [s("a", `Authorization: Bearer ${tok}1`), s("b", `authorization: bearer ${tok}2`), s("c", `BEARER ${tok}3`), s("d", "the bearer of this message")],
      }),
    ]);
    const { batches, hits } = redactBatches([b], BUILTIN_RULES);
    const attrs = JSON.stringify(batches[0].spans[0].attributes);
    for (const n of [1, 2, 3]) expect(attrs).not.toContain(`${tok}${n}`);
    expect(attrs).toContain("authorization: bearer [redacted:bearer_token]");
    expect(attrs).toContain("the bearer of this message");
    expect(hits.filter((h) => h.kind === "bearer_token")).toHaveLength(3);
  });

  it("leaves clean names unchanged", () => {
    const b = batch([span({ traceId: hex(16), spanId: hex(8), name: "lookup_order", kind: "tool" })]);
    const { batches, hits } = redactBatches([b], BUILTIN_RULES);
    expect(batches[0].spans[0].name).toBe("lookup_order");
    expect(hits).toEqual([]);
  });
});

describe("built-in credential formats", () => {
  // Made-up values in each provider's real format.
  const A = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY";
  const SECRETS: [string, string, string][] = [
    ["github fine-grained token", `token github_pat_11ABCDEFG0${A}_${A}${A}`, "token [redacted:api_key]"],
    ["stripe secret key", `stripe sk_live_${A}`, "stripe [redacted:api_key]"],
    ["stripe restricted key", `stripe rk_test_${A}`, "stripe [redacted:api_key]"],
    ["hugging face token", `HF_TOKEN=hf_${A}ab`, "HF_TOKEN=[redacted:api_key]"],
    ["groq key", `GROQ_API_KEY=gsk_${A}${A}`, "GROQ_API_KEY=[redacted:api_key]"],
    ["npm token", `_authToken=npm_${A}abcd`, "_authToken=[redacted:api_key]"],
    ["google oauth token", `access ya29.${A}${A}`, "access [redacted:api_key]"],
    ["jwt without Bearer", `"id_token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${A}"`, `"id_token": "[redacted:jwt]"`],
    ["basic auth", "Authorization: Basic dXNlcjpzM2NyZXRQYXNzd29yZDEyMw==", "Authorization: Basic [redacted:basic_auth]"],
    ["aws secret key", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "aws_secret_access_key = [redacted:aws_secret]"],
    ["aws secret key in json", `{"aws_secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}`, `{"aws_secret_access_key": "[redacted:aws_secret]"}`],
    ["url password", "postgres://admin:S3cretPass99@db.internal:5432/app", "postgres://admin:[redacted:url_password]@db.internal:5432/app"],
    ["url password, dotless host", "redis://default:S3cretPass99@db:6379", "redis://default:[redacted:url_password]@db:6379"],
    ["url password, no user", "redis://:S3cretPass99@cache:6379", "redis://:[redacted:url_password]@cache:6379"],
    ["basic auth after a lowercase header", "authorization: basic dXNlcjpzM2NyZXRQYXNzd29yZDEyMw==", "authorization: basic [redacted:basic_auth]"],
    ["short basic auth after the header", "Authorization: Basic YWRtaW46YWRtaW4=", "Authorization: Basic [redacted:basic_auth]"],
    ["json-escaped basic auth", String.raw`{\"Authorization\": \"Basic YWRtaW46YWRtaW4=\"}`, String.raw`{\"Authorization\": \"Basic [redacted:basic_auth]\"}`],
    ["json-escaped aws secret key", String.raw`{\"aws_secret_access_key\": \"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\"}`, String.raw`{\"aws_secret_access_key\": \"[redacted:aws_secret]\"}`],
    ["aws secret key longer than 40 characters", "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEYplus4", "aws_secret_access_key=[redacted:aws_secret]"],
  ];
  const hostedLlm = BUILTIN_RULES.filter((r) => CREDENTIAL_KINDS.includes(r.kind));

  it.each(SECRETS)("removes a %s before a cloud send and before a hosted LLM call", (_name, text, expected) => {
    expect(redactString(text, BUILTIN_RULES, "x", [])).toBe(expected);
    expect(redactString(text, hostedLlm, "x", [])).toBe(expected);
  });

  it("leaves ordinary text, ids and plain URLs alone", () => {
    const clean = [
      "The basic internationalization settings are fine.",
      "trace 4bf92f3577b34da6a3ce929d0e0e4736 span 00f067aa0ba902b7",
      "See https://example.com:8080/docs?page=2 and http://localhost:4100/runs",
      "run_id=hf_model sk_live is not configured; npm_install ran",
      "eyJhbGciOiJIUzI1NiJ9 alone is just a header",
      "Use basic /usr/local/lib/python3.11/site-packages for the venv",
      "Basic authentication1234 is enabled",
      "Basic AuthenticationIsOn is not base64 either",
    ];
    for (const text of clean) expect(redactString(text, BUILTIN_RULES, "x", [])).toBe(text);
  });

  it("reads a port and a query as a port and a query, not a password", () => {
    const url = "https://api.example.com:443?email=jane@corp.com";
    expect(redactString(url, hostedLlm, "x", [])).toBe(url);
    expect(redactString(url, BUILTIN_RULES, "x", [])).toBe("https://api.example.com:443?email=[redacted:email]");
  });

  it("stays fast on long adversarial input", () => {
    // Before, url_password, jwt and email took seconds on these (a match tried from every word boundary).
    const inputs = ["a.".repeat(50_000), "eyJ-".repeat(25_000), "a@".repeat(50_000), "a:a/".repeat(25_000), "Basic a".repeat(14_000), "x".repeat(100_000)];
    for (const rule of BUILTIN_RULES) {
      for (const text of inputs) {
        const started = performance.now();
        redactString(text, [rule], "x", []);
        expect(performance.now() - started, `${rule.kind} on ${JSON.stringify(text.slice(0, 8))}…`).toBeLessThan(250);
      }
    }
  });

  it("never echoes the secret in the preview hits", () => {
    const hits: { kind: string; where: string; sample: string }[] = [];
    redactString("postgres://admin:S3cretPass99@db:5432 Basic dXNlcjpzM2NyZXRQYXNzd29yZDEyMw==", BUILTIN_RULES, "x", hits);
    expect(hits.map((h) => h.kind)).toEqual(["basic_auth", "url_password"]);
    expect(JSON.stringify(hits)).not.toContain("S3cretPass99");
    expect(JSON.stringify(hits)).not.toContain("dXNlcjpzM2NyZXRQYXNzd29yZDEyMw");
  });
});
