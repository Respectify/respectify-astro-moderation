import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import type {
  CommentScore,
  MegaCallResult,
  ModerationTolerances,
  PerspectiveAnalyzeCommentResponse,
  ResolvedModerationTolerances,
  SpamDetectionResult,
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

function megacallResult(
  score: CommentScore | null,
  isSpam = false,
  spamCheck?: SpamDetectionResult,
): MegaCallResult {
  return {
    comment_score: score,
    spam_check: spamCheck ?? { reasoning: "", is_spam: isSpam, confidence: 0.9 },
    relevance_check: null,
    dogwhistle_check: null,
    perspective: null,
  };
}

const LINK_SUGGESTION = "This looks like spam. How about removing the link?";

/** A suspected-spam verdict: not spam, but sent back to the commenter with the suggestion. */
const SUSPECTED_SPAM: SpamDetectionResult = {
  reasoning: "Looks promotional",
  is_spam: false,
  confidence: 0.6,
  suspected_spam: true,
  suggestion: LINK_SUGGESTION,
};

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

  it("marks spam as spam, not suspected", async () => {
    respondWith(megacallResult(commentScore({}), true));
    const result = await moderateComment({ comment: "buy now", articleId: ARTICLE_ID });
    assert.equal(result.isSpam, true);
    assert.equal(result.suspectedSpam, false);
    assert.equal(result.feedback, "This comment appears to be spam.");
  });

  it("sends suspected spam back with the suggestion instead of treating it as spam", async () => {
    respondWith(megacallResult(commentScore({}), false, SUSPECTED_SPAM));
    const result = await moderateComment({ comment: "see example.com", articleId: ARTICLE_ID });
    assert.equal(result.approved, false, "suspected spam should be held for revision");
    assert.equal(result.isSpam, false, "suspected spam is not spam");
    assert.equal(result.suspectedSpam, true);
    assert.equal(result.spamSuggestion, LINK_SUGGESTION);
    assert.equal(result.feedback, LINK_SUGGESTION);
  });

  it("combines the suspected-spam suggestion with comment-health feedback", async () => {
    respondWith(
      megacallResult(
        commentScore({ exceeds_tolerance: true, toxicity_explanation: "Calling someone an idiot is an insult." }),
        false,
        SUSPECTED_SPAM,
      ),
    );
    const result = await moderateComment({ comment: "idiot, see example.com", articleId: ARTICLE_ID });
    assert.equal(result.approved, false);
    assert.equal(result.isSpam, false);
    assert.equal(result.suspectedSpam, true);
    assert.equal(result.feedback, `${LINK_SUGGESTION} Calling someone an idiot is an insult.`);
  });

  it("publishes a comment that is neither spam nor suspected", async () => {
    respondWith(
      megacallResult(commentScore({}), false, {
        reasoning: "",
        is_spam: false,
        confidence: 0.9,
        suspected_spam: false,
        suggestion: "",
      }),
    );
    const result = await moderateComment({ comment: "good point", articleId: ARTICLE_ID });
    assert.equal(result.approved, true);
    assert.equal(result.isSpam, false);
    assert.equal(result.suspectedSpam, false);
    assert.equal(result.spamSuggestion, undefined);
  });

  it("treats an older API without suspected_spam as not suspected", async () => {
    respondWith(megacallResult(commentScore({})));
    const result = await moderateComment({ comment: "good point", articleId: ARTICLE_ID });
    assert.equal(result.approved, true);
    assert.equal(result.suspectedSpam, false);
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

  it("rejects a per-call permissive floored category without calling the API", async () => {
    const fetchMock = respondWith(megacallResult(commentScore({})));
    await assert.rejects(
      moderateComment({
        comment: "fine",
        articleId: ARTICLE_ID,
        tolerances: untypedTolerances('{"threat": "permissive"}'),
      }),
      /stricter but not relaxed or turned off: threat/,
    );
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("sends permissive levels", async () => {
    const fetchMock = respondWith(megacallResult(commentScore({})));
    await moderateComment({
      comment: "fine",
      articleId: ARTICLE_ID,
      tolerances: { insult: "permissive", quality: "permissive" },
    });
    assert.deepEqual(sentBody(fetchMock).tolerances, { insult: "permissive", quality: "permissive" });
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

describe("moderateComment spam-only mode", () => {
  it("blocks spam", async () => {
    respondWith({ reasoning: "Spam", is_spam: true, confidence: 0.95 });
    const result = await moderateComment({ comment: "buy now", mode: "spam-only" });
    assert.equal(result.approved, false);
    assert.equal(result.isSpam, true);
    assert.equal(result.suspectedSpam, false);
  });

  it("sends suspected spam back with the suggestion", async () => {
    respondWith(SUSPECTED_SPAM);
    const result = await moderateComment({ comment: "see example.com", mode: "spam-only" });
    assert.equal(result.approved, false);
    assert.equal(result.isSpam, false);
    assert.equal(result.suspectedSpam, true);
    assert.equal(result.spamSuggestion, LINK_SUGGESTION);
    assert.equal(result.feedback, LINK_SUGGESTION);
  });

  it("publishes a comment that is neither", async () => {
    respondWith({ reasoning: "", is_spam: false, confidence: 0.9 });
    const result = await moderateComment({ comment: "good point", mode: "spam-only" });
    assert.equal(result.approved, true);
    assert.equal(result.isSpam, false);
    assert.equal(result.suspectedSpam, false);
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

  it("runs no spam check, so suspectedSpam is undefined", async () => {
    respondWith(perspectiveResponse(0.1));
    const result = await moderateComment({ comment: "x", mode: "perspective" });
    assert.equal(result.isSpam, false);
    assert.equal(result.suspectedSpam, undefined);
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

  it("accepts permissive for tunable categories and quality", () => {
    assert.doesNotThrow(() =>
      respectifyModeration({ tolerances: { insult: "permissive", dismissive_tone: "permissive", quality: "permissive" } }),
    );
  });

  it("rejects a permissive floored category at setup", () => {
    assert.throws(
      () => respectifyModeration({ tolerances: untypedTolerances('{"sexual_content": "permissive"}') }),
      /Invalid Respectify moderation tolerances: .*stricter but not relaxed or turned off: sexual_content/,
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
