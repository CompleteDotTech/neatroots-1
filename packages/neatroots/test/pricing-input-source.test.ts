import { expect, it } from "vitest";
import { priceCall, type Price } from "../src/models/pricing.js";

const otel = (input = 1124639) => ({
  "gen_ai.provider.name": "anthropic", "gen_ai.response.model": "claude-opus-5-5",
  "gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": 16565,
  "gen_ai.usage.cache_read.input_tokens": 1057791, "gen_ai.usage.cache_creation.input_tokens": 66786,
});
it("prices the same cache-heavy call identically from GenAI and Neatlogs attributes", () => {
  const expected = priceCall({
    "neatlogs.llm.provider": "anthropic", "neatlogs.llm.model_name": "claude-opus-5-5",
    "neatlogs.llm.token_count.prompt": 62, "neatlogs.llm.token_count.completion": 16565,
    "neatlogs.llm.token_count.cache_read": 1057791, "neatlogs.llm.token_count.cache_write": 66786,
  });
  expect(priceCall(otel())).toEqual(expected);
  expect(expected.cost_usd).toBeCloseTo(0.8770362, 12);
});
it("uses the selected input attribute when both conventions are present", () => {
  expect(priceCall({ ...otel(), "neatlogs.llm.token_count.prompt": 62 }).cost_usd).toBeCloseTo(0.8770362, 12);
  expect(priceCall({ ...otel(), "neatlogs.llm.token_count.prompt": null }).cost_usd).toBeNull();
});
it("uses the same inclusive convention for legacy GenAI prompt counts", () => {
  const a = otel();
  const { "gen_ai.usage.input_tokens": input, ...rest } = a;
  expect(priceCall({ ...rest, "gen_ai.usage.prompt_tokens": input })).toEqual(priceCall(a));
});
it("does not treat contradictory inclusive usage as a different convention", () => {
  expect(priceCall(otel(62)).cost_usd).toBeNull();
  expect(priceCall(otel(1124577)).cost_usd).toBeCloseTo((16565 * 20 + 1057791 * .2 + 66786 * 5) / 1e6, 12);
});
it("selects the input convention independently of an override's provider convention", () => {
  const rate: Price = { provider: "anthropic", model: "custom", input: 4, output: 20, cacheRead: .2, cacheWrite: 5, inputMode: "excludes-cache" };
  expect(priceCall({ ...otel(), "gen_ai.response.model": "custom" }, [rate]).cost_usd).toBeCloseTo(0.8770362, 12);
});
it("counts inclusive input once when deciding whether long-context pricing is unknown", () => {
  const a = { "gen_ai.provider.name": "anthropic", "gen_ai.response.model": "claude-sonnet-4-5",
    "gen_ai.usage.input_tokens": 190000, "gen_ai.usage.output_tokens": 100,
    "gen_ai.usage.cache_read.input_tokens": 150000 };
  expect(priceCall(a).cost_usd).toBeCloseTo((40000 * 3 + 150000 * .3 + 100 * 15) / 1e6, 12);
  expect(priceCall({ ...a, "gen_ai.usage.input_tokens": 200001 }).cost_usd).toBeNull();
});
