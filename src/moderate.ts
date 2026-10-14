import {
  RespectifyClient,
  AuthenticationError,
  PaymentRequiredError,
  RespectifyError,
  validateModerationTolerances,
  type MegaCallResult,
  type MegacallOptions,
  type ModerationTolerances,
  type PerspectiveAnalyzeCommentResponse,
  type SpamDetectionResult,
} from "@respectify/client";
import type {
  ModerateCommentInput,
  ModerateCommentResult,
  ModerateMode,
  RespectifyAstroModerationOptions,
} from "./types.js";

/** Toxicity threshold used by perspective mode when none is configured. */
const DEFAULT_PERSPECTIVE_TOXICITY_THRESHOLD = 0.7;

const articleIdCache = new Map<string, string>();
let client: RespectifyClient | null = null;
let integrationDefaults: RespectifyAstroModerationOptions = {};

/**
 * Store the defaults used by moderateComment().
 *
 * @throws Error when `tolerances` names an unknown item or level, or relaxes or turns
 *   off a floored category (threat, identity_attack, sexual_content, harassment).
 */
export function setModerationDefaults(options: RespectifyAstroModerationOptions): void {
  if (options.tolerances !== undefined) {
    try {
      validateModerationTolerances(options.tolerances);
    } catch (error) {
      if (error instanceof RespectifyError) {
        throw new Error(`Invalid Respectify moderation tolerances: ${error.message}`);
      }
      throw error;
    }
  }
  integrationDefaults = { ...options };
}

export function getModerationDefaults(): RespectifyAstroModerationOptions {
  return integrationDefaults;
}

function getClient(): RespectifyClient {
  if (client) return client;

  const email = process.env.RESPECTIFY_EMAIL;
  const apiKey = process.env.RESPECTIFY_API_KEY;

  if (!email || !apiKey) {
    throw new Error(
      "Respectify credentials missing. Set RESPECTIFY_EMAIL and RESPECTIFY_API_KEY.",
    );
  }

  client = new RespectifyClient({ email, apiKey });
  return client;
}

async function resolveArticleId(input: ModerateCommentInput): Promise<string | undefined> {
  if (input.articleId) return input.articleId;

  const topicUrl = input.topicUrl ?? integrationDefaults.defaultTopicUrl;
  const topicText = input.topicText;
  const cacheKey = topicUrl ? `url:${topicUrl}` : topicText ? `text:${topicText.slice(0, 200)}` : null;
  if (!cacheKey) return undefined;

  const cached = articleIdCache.get(cacheKey);
  if (cached) return cached;

  const respectify = getClient();
  const init = topicUrl
    ? await respectify.initTopicFromUrl(topicUrl)
    : await respectify.initTopicFromText(topicText!);

  articleIdCache.set(cacheKey, init.article_id);
  return init.article_id;
}

/** Fallback shown for suspected spam when an API sends no suggestion. */
const DEFAULT_SUSPECTED_SPAM_SUGGESTION =
  "This looks like spam. Please revise it and say what you think about the discussion.";

/** The signals a moderation decision is made from. */
interface ModerationSignals {
  /** The spam verdict, when a spam check was run */
  spamCheck?: SpamDetectionResult | null;
  /** 0 = clean, 1 = highly toxic */
  toxicityScore?: number;
  /** Block when toxicityScore >= this. Undefined means toxicity alone never blocks. */
  toxicityThreshold?: number;
  /** From the comment score: the comment has a problem the site's tolerances do not accept */
  exceedsTolerance?: boolean;
  /** Coaching feedback shown when the comment is blocked for its content */
  explanation?: string;
}

type ModerationDecision = Pick<
  ModerateCommentResult,
  "approved" | "feedback" | "toxicityScore" | "isSpam" | "suspectedSpam" | "spamSuggestion"
>;

/**
 * Decide whether a comment is approved, and if not, whether it is rejected as spam or
 * sent back to its writer for revision.
 *
 * - Spam (`is_spam`): rejected; the comment should be deleted.
 * - Suspected spam (`suspected_spam`): not approved, but not spam: sent back with the
 *   server's suggestion, combined with any comment-health feedback.
 * - Exceeding the site's tolerances, or a configured toxicity threshold: sent back with
 *   the coaching feedback.
 * - Otherwise approved.
 */
function decide(signals: ModerationSignals): ModerationDecision {
  const { spamCheck, toxicityScore, toxicityThreshold, exceedsTolerance, explanation } = signals;
  // No spam check (perspective mode) leaves suspectedSpam undefined
  const hasSpamCheck = spamCheck !== undefined;
  const isSpam = spamCheck?.is_spam === true;
  // An older API omits suspected_spam: treat that as not suspected
  const isSuspectedSpam = !isSpam && spamCheck?.suspected_spam === true;

  if (isSpam) {
    return {
      approved: false,
      feedback: "This comment appears to be spam.",
      toxicityScore,
      isSpam: true,
      suspectedSpam: false,
    };
  }

  const isOverToxicityThreshold =
    toxicityThreshold !== undefined &&
    toxicityScore !== undefined &&
    toxicityScore >= toxicityThreshold;
  const isHealthProblem = exceedsTolerance === true || isOverToxicityThreshold;

  const spamFlags: Pick<ModerationDecision, "isSpam" | "suspectedSpam"> = hasSpamCheck
    ? { isSpam: false, suspectedSpam: isSuspectedSpam }
    : { isSpam: false };

  if (isSuspectedSpam) {
    const spamSuggestion = spamCheck?.suggestion || DEFAULT_SUSPECTED_SPAM_SUGGESTION;
    const feedback = isHealthProblem && explanation ? `${spamSuggestion} ${explanation}` : spamSuggestion;
    return {
      approved: false,
      feedback,
      toxicityScore,
      ...spamFlags,
      spamSuggestion,
    };
  }

  if (isHealthProblem) {
    return {
      approved: false,
      feedback: explanation || "This comment looks too disrespectful to publish as-is.",
      toxicityScore,
      ...spamFlags,
    };
  }

  return {
    approved: true,
    feedback: "Looks good.",
    toxicityScore,
    ...spamFlags,
  };
}

function perspectiveScores(
  response: PerspectiveAnalyzeCommentResponse | null | undefined,
): Record<string, number> | undefined {
  if (!response?.attributeScores) return undefined;
  const out: Record<string, number> = {};
  for (const [name, entry] of Object.entries(response.attributeScores)) {
    out[name] = entry.summaryScore.value;
  }
  return out;
}

/** Per-call tolerances merged over the integration's: an item named per call wins. */
function mergeTolerances(
  defaults: ModerationTolerances | undefined,
  overrides: ModerationTolerances | undefined,
): ModerationTolerances | undefined {
  if (!defaults && !overrides) return undefined;
  return { ...defaults, ...overrides };
}

/**
 * Moderate a single comment with Respectify.
 * Call from an Astro Action, API route, or server endpoint.
 */
export async function moderateComment(
  input: ModerateCommentInput,
): Promise<ModerateCommentResult> {
  const mode: ModerateMode = input.mode ?? integrationDefaults.mode ?? "full";
  // Undefined when neither the call nor the integration configured one
  const configuredToxicityThreshold: number | undefined =
    input.toxicityThreshold ?? integrationDefaults.toxicityThreshold;

  try {
    const respectify = getClient();

    if (mode === "perspective") {
      const response = await respectify.perspective.analyzeComment({
        comment: { text: input.comment },
        requestedAttributes: {
          TOXICITY: {},
          INSULT: {},
          PROFANITY: {},
        },
      });
      const scores = perspectiveScores(response);
      const toxicityScore = scores?.TOXICITY;
      return {
        ...decide({
          toxicityScore,
          toxicityThreshold:
            configuredToxicityThreshold ?? DEFAULT_PERSPECTIVE_TOXICITY_THRESHOLD,
        }),
        perspectiveScores: scores,
        raw: response,
      };
    }

    const articleId = await resolveArticleId(input);

    if (mode === "spam-only") {
      const spam = await respectify.checkSpam(input.comment, articleId);
      const decision = decide({ spamCheck: spam });
      return {
        ...decision,
        // spam-only mode has always shown the server's reasoning for spam
        feedback: spam.is_spam ? spam.reasoning || decision.feedback : decision.feedback,
        articleId,
        raw: spam,
      };
    }

    // full
    const megacallOptions: MegacallOptions = {
      comment: input.comment,
      includeSpam: true,
    };

    if (articleId) {
      megacallOptions.articleId = articleId;
      megacallOptions.includeCommentScore = true;

      const tolerances = mergeTolerances(integrationDefaults.tolerances, input.tolerances);
      if (tolerances) {
        megacallOptions.tolerances = tolerances;
      }
    }

    const result: MegaCallResult = await respectify.megacall(megacallOptions);
    const commentScore = result.comment_score;

    return {
      ...decide({
        spamCheck: result.spam_check,
        toxicityScore: commentScore?.toxicity_score,
        toxicityThreshold: configuredToxicityThreshold,
        exceedsTolerance: commentScore?.exceeds_tolerance,
        explanation: commentScore?.toxicity_explanation,
      }),
      exceedsTolerance: commentScore?.exceeds_tolerance,
      tolerances: commentScore?.tolerances,
      healthScore: commentScore?.health_score,
      healthItems: commentScore?.health_items,
      articleId,
      raw: result,
    };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw new Error("Respectify authentication failed. Check RESPECTIFY_EMAIL and RESPECTIFY_API_KEY.");
    }
    if (error instanceof PaymentRequiredError) {
      throw new Error("Respectify payment required. Top up your account balance.");
    }
    if (error instanceof RespectifyError) {
      throw new Error(`Respectify API error (${error.statusCode ?? "unknown"}): ${error.message}`);
    }
    throw error;
  }
}
