import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { OutOfCreditsError, completeJson } from "../openrouter";

const realFetch = globalThis.fetch;

describe("completeJson out of credits", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("stops at the first HTTP 402 instead of walking the model chain", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    process.env.OPENROUTER_MODEL_STRONG = "model-a,model-b,model-c";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 });
    }) as typeof fetch;
    await assert.rejects(completeJson({ tier: "strong", system: "s", prompt: "p" }), OutOfCreditsError);
    assert.equal(calls, 1);
  });
});
