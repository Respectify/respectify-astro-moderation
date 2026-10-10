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
 * @throws Error when `tolerances` names an unknown category or level, or relaxes a
 *   floored category (threat, identity_attack, sexual_content, harassment).
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

/** The signals a moderation decision is made from. */
interface ModerationSignals {
  isSpam?: boolean;
  /** 0 = clean, 1 = highly toxic */
  toxicityScore?: number;
  /** Block when toxicityScore >= this. Undefined means toxicity alone never blocks. */
  toxicityThreshold?: number;
  /** From the comment score: the comment has a problem the site's tolerances do not accept */
  exceedsTolerance?: boolean;
  /** Coaching feedback shown when the comment is blocked for its content */
  explanation?: string;
}

/**
 * Decide whether a comment is approved. Blocked when it is spam, when it exceeds the
 * site's tolerances, or when its toxicity reaches a configured threshold.
 */
function decide(
  signals: ModerationSignals,
): Pick<ModerateCommentResult, "approved" | "feedback" | "toxicityScore" | "isSpam"> {
  const { isSpam, toxicityScore, toxicityThreshold, exceedsTolerance, explanation } = signals;

  if (isSpam) {
    return {
      approved: false,
      feedback: "This comment appears to be spam.",
      toxicityScore,
      isSpam: true,
    };
  }

  const isOverToxicityThreshold =
    toxicityThreshold !== undefined &&
    toxicityScore !== undefined &&
    toxicityScore >= toxicityThreshold;

  if (exceedsTolerance === true || isOverToxicityThreshold) {
    return {
      approved: false,
      feedback: explanation || "This comment looks too disrespectful to publish as-is.",
      toxicityScore,
      isSpam: false,
    };
  }

  return {
    approved: true,
    feedback: "Looks good.",
    toxicityScore,
    isSpam: false,
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

/** Per-call tolerances merged over the integration's: a category named per call wins. */
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
      return {
        approved: !spam.is_spam,
        feedback: spam.is_spam
          ? spam.reasoning || "This comment appears to be spam."
          : "Looks good.",
        isSpam: spam.is_spam,
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
        isSpam: result.spam_check?.is_spam,
        toxicityScore: commentScore?.toxicity_score,
        toxicityThreshold: configuredToxicityThreshold,
        exceedsTolerance: commentScore?.exceeds_tolerance,
        explanation: commentScore?.toxicity_explanation,
      }),
      exceedsTolerance: commentScore?.exceeds_tolerance,
      tolerances: commentScore?.tolerances,
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
