import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import type {
  CommentScore,
  MegaCallResult,
  ModerationTolerances,
  PerspectiveAnalyzeCommentResponse,
  ResolvedModerationTolerances,
} from "@respectify/client";

import respectifyModeration from "../src/integration.js";
import { moderateComment, setModerationDefaults } from "../src/moderate.js";

/** The parts of the megacall request body these tests inspect. */
interface SentMegacallBody {
  run_comment_score: boolean;
  tolerances?: ModerationTolerances;
}

const ARTICLE_ID = "2b38cb34-e3d7-492e-b61e-c3858f1863b7";

const STANDARD_TOLERANCES: ResolvedModerationTolerances = {
  threat: "standard",
  identity_attack: "standard",
  sexual_content: "standard",
  harassment: "standard",
  insult: "standard",
  profanity: "standard",
  dismissive_tone: "standard",
  logical_fallacy: "standard",
  low_effort: "standard",
  quality: "standard",
};

function commentScore(overrides: Partial<CommentScore>): CommentScore {
  return {
    logical_fallacies: [],
    objectionable_phrases: [],
    negative_tone_phrases: [],
    appears_low_effort: false,
    overall_score: 4,
    toxicity_score: 0.1,
    toxicity_explanation: "",
    exceeds_tolerance: false,
    tolerances: STANDARD_TOLERANCES,
    ...overrides,
  };
}

function megacallResult(score: CommentScore | null, isSpam = false): MegaCallResult {
  return {
    comment_score: score,
    spam_check: { reasoning: "", is_spam: isSpam, confidence: 0.9 },
    relevance_check: null,
    dogwhistle_check: null,
    perspective: null,
    llm_detection: null,
  };
}

function perspectiveResponse(toxicity: number): PerspectiveAnalyzeCommentResponse {
  return {
    attributeScores: {
      TOXICITY: { summaryScore: { value: toxicity, type: "PROBABILITY" } },
    },
    languages: ["en"],
  };
}

/** Simulates tolerances arriving from an untyped source (JavaScript caller, JSON config). */
function untypedTolerances(json: string): ModerationTolerances {
  return JSON.parse(json);
}

/** Replace fetch with one that answers every request with this payload. */
function respondWith(payload: object) {
  return mock.method(
    globalThis,
    "fetch",
    async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

function sentBody(fetchMock: ReturnType<typeof respondWith>): SentMegacallBody {
  const body = fetchMock.mock.calls[0]?.arguments[1]?.body;
  assert.equal(typeof body, "string", "Request body should be a JSON string");
  return JSON.parse(String(body));
}

beforeEach(() => {
  process.env.RESPECTIFY_EMAIL = "test@example.com";
  process.env.RESPECTIFY_API_KEY = "test-key";
  setModerationDefaults({});
});

afterEach(() => {
  mock.restoreAll();
});

describe("moderateComment full mode", () => {
  it("blocks a comment that exceeds tolerance even when its toxicity is low", async () => {
    respondWith(
      megacallResult(
        commentScore({
          exceeds_tolerance: true,
          toxicity_score: 0.2,
          toxicity_explanation: "Calling someone an idiot is an insult.",
        }),
      ),
    );
    const result = await moderateComment({ comment: "you idiot", articleId: ARTICLE_ID });
    assert.equal(result.approved, false);
    assert.equal(result.exceedsTolerance, true);
    assert.equal(result.feedback, "Calling someone an idiot is an insult.");
  });

  it("approves a comment within tolerance when no toxicity threshold is configured", async () => {
    respondWith(megacallResult(commentScore({ exceeds_tolerance: false, toxicity_score: 0.9 })));
    const result = await moderateComment({ comment: "damn right", articleId: ARTICLE_ID });
    assert.equal(result.approved, true, "toxicity_score alone should not block without a configured threshold");
    assert.equal(result.exceedsTolerance, false);
    assert.equal(result.toxicityScore, 0.9);
  });

  it("still blocks on an integration-configured toxicity threshold", async () => {
    setModerationDefaults({ toxicityThreshold: 0.7 });
    respondWith(megacallResult(commentScore({ exceeds_tolerance: false, toxicity_score: 0.9 })));
    const result = await moderateComment({ comment: "damn right", articleId: ARTICLE_ID });
    assert.equal(result.approved, false);
  });

  it("still blocks on a per-call toxicity threshold", async () => {
    respondWith(megacallResult(commentScore({ exceeds_tolerance: false, toxicity_score: 0.5 })));
    const result = await moderateComment({
      comment: "damn right",
      articleId: ARTICLE_ID,
      toxicityThreshold: 0.4,
    });
    assert.equal(result.approved, false);
  });

  it("blocks spam", async () => {
    respondWith(megacallResult(commentScore({}), true));
    const result = await moderateComment({ comment: "buy now", articleId: ARTICLE_ID });
    assert.equal(result.approved, false);
    assert.equal(result.isSpam, true);
  });

  it("returns the tolerances the comment was judged under", async () => {
    const judgedUnder: ResolvedModerationTolerances = { ...STANDARD_TOLERANCES, insult: "relaxed" };
    respondWith(megacallResult(commentScore({ tolerances: judgedUnder })));
    const result = await moderateComment({ comment: "fine", articleId: ARTICLE_ID });
    assert.deepEqual(result.tolerances, judgedUnder);
  });

  it("sends no tolerances when none are configured", async () => {
    const fetchMock = respondWith(megacallResult(commentScore({})));
    await moderateComment({ comment: "fine", articleId: ARTICLE_ID });
    assert.equal(sentBody(fetchMock).tolerances, undefined);
  });

  it("merges per-call tolerances over the integration's", async () => {
    setModerationDefaults({ tolerances: { insult: "relaxed", threat: "strict" } });
    const fetchMock = respondWith(megacallResult(commentScore({})));
    await moderateComment({
      comment: "fine",
      articleId: ARTICLE_ID,
      tolerances: { insult: "strict", profanity: "relaxed" },
    });
    assert.deepEqual(sentBody(fetchMock).tolerances, {
      insult: "strict",
      threat: "strict",
      profanity: "relaxed",
    });
  });

  it("decides on spam alone and sends no tolerances without topic context", async () => {
    setModerationDefaults({ tolerances: { insult: "relaxed" } });
    const fetchMock = respondWith(megacallResult(null));
    const result = await moderateComment({ comment: "fine" });
    const body = sentBody(fetchMock);
    assert.equal(body.run_comment_score, false);
    assert.equal(body.tolerances, undefined);
    assert.equal(result.approved, true);
    assert.equal(result.exceedsTolerance, undefined);
  });

  it("rejects a per-call relaxed floored category without calling the API", async () => {
    const fetchMock = respondWith(megacallResult(commentScore({})));
    await assert.rejects(
      moderateComment({
        comment: "fine",
        articleId: ARTICLE_ID,
        tolerances: untypedTolerances('{"threat": "relaxed"}'),
      }),
      /stricter but not relaxed or turned off: threat/,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("rejects a per-call turned-off floored category without calling the API", async () => {
    const fetchMock = respondWith(megacallResult(commentScore({})));
    await assert.rejects(
      moderateComment({
        comment: "fine",
        articleId: ARTICLE_ID,
        tolerances: untypedTolerances('{"sexual_content": "off"}'),
      }),
      /stricter but not relaxed or turned off: sexual_content/,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("sends quality and off levels", async () => {
    setModerationDefaults({ tolerances: { quality: "strict" } });
    const fetchMock = respondWith(megacallResult(commentScore({})));
    await moderateComment({
      comment: "fine",
      articleId: ARTICLE_ID,
      tolerances: { profanity: "off" },
    });
    assert.deepEqual(sentBody(fetchMock).tolerances, { quality: "strict", profanity: "off" });
  });

  it("returns the per-item health results and health score", async () => {
    const healthItems = {
      insult: { score: 2, minimum: 4, is_acceptable: false },
      quality: { score: 4, minimum: 3, is_acceptable: true },
    } as const;
    respondWith(
      megacallResult(commentScore({ exceeds_tolerance: true, health_score: 2.828, health_items: healthItems })),
    );
    const result = await moderateComment({ comment: "you fool", articleId: ARTICLE_ID });
    assert.equal(result.approved, false);
    assert.deepEqual(result.healthItems, healthItems);
    assert.equal(result.healthScore, 2.828);
  });

  it("leaves the health results undefined when an older API omits them", async () => {
    respondWith(megacallResult(commentScore({})));
    const result = await moderateComment({ comment: "fine", articleId: ARTICLE_ID });
    assert.equal(result.healthItems, undefined);
    assert.equal(result.healthScore, undefined);
  });
});

describe("moderateComment perspective mode", () => {
  it("blocks at the default toxicity threshold of 0.7", async () => {
    respondWith(perspectiveResponse(0.8));
    const result = await moderateComment({ comment: "x", mode: "perspective" });
    assert.equal(result.approved, false);
    assert.equal(result.toxicityScore, 0.8);
  });

  it("approves below the default toxicity threshold", async () => {
    respondWith(perspectiveResponse(0.5));
    const result = await moderateComment({ comment: "x", mode: "perspective" });
    assert.equal(result.approved, true);
  });

  it("uses a configured toxicity threshold", async () => {
    setModerationDefaults({ toxicityThreshold: 0.9 });
    respondWith(perspectiveResponse(0.8));
    const result = await moderateComment({ comment: "x", mode: "perspective" });
    assert.equal(result.approved, true);
  });
});

describe("tolerance configuration", () => {
  it("accepts floored categories made stricter", () => {
    assert.doesNotThrow(() =>
      respectifyModeration({ tolerances: { threat: "zero_tolerance", insult: "relaxed" } }),
    );
  });

  it("rejects a relaxed floored category at setup", () => {
    assert.throws(
      () => respectifyModeration({ tolerances: untypedTolerances('{"harassment": "relaxed"}') }),
      /Invalid Respectify moderation tolerances: .*stricter but not relaxed or turned off: harassment/,
    );
  });

  it("rejects a turned-off floored category at setup", () => {
    assert.throws(
      () => respectifyModeration({ tolerances: untypedTolerances('{"identity_attack": "off"}') }),
      /Invalid Respectify moderation tolerances: .*stricter but not relaxed or turned off: identity_attack/,
    );
  });

  it("accepts off for tunable categories and any level for quality", () => {
    assert.doesNotThrow(() =>
      respectifyModeration({ tolerances: { profanity: "off", low_effort: "off", quality: "zero_tolerance" } }),
    );
  });

  it("rejects an unknown category at setup", () => {
    assert.throws(
      () => setModerationDefaults({ tolerances: untypedTolerances('{"insults": "relaxed"}') }),
      /Invalid Respectify moderation tolerances: Unknown comment-health item/,
    );
  });
});
