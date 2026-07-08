import {
  RespectifyClient,
  AuthenticationError,
  PaymentRequiredError,
  RespectifyError,
  type MegaCallResult,
  type PerspectiveAnalyzeCommentResponse,
} from "@respectify/client";
import type {
  ModerateCommentInput,
  ModerateCommentResult,
  ModerateMode,
  RespectifyAstroModerationOptions,
} from "./types.js";

const articleIdCache = new Map<string, string>();
let client: RespectifyClient | null = null;
let integrationDefaults: RespectifyAstroModerationOptions = {};

export function setModerationDefaults(options: RespectifyAstroModerationOptions): void {
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

function decideFromToxicity(
  toxicityScore: number | undefined,
  threshold: number,
  extras?: { isSpam?: boolean; explanation?: string },
): Pick<ModerateCommentResult, "approved" | "feedback" | "toxicityScore" | "isSpam"> {
  if (extras?.isSpam) {
    return {
      approved: false,
      feedback: "This comment appears to be spam.",
      toxicityScore,
      isSpam: true,
    };
  }

  if (toxicityScore !== undefined && toxicityScore >= threshold) {
    return {
      approved: false,
      feedback: extras?.explanation || "This comment looks too disrespectful to publish as-is.",
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

/**
 * Moderate a single comment with Respectify.
 * Call from an Astro Action, API route, or server endpoint.
 */
export async function moderateComment(
  input: ModerateCommentInput,
): Promise<ModerateCommentResult> {
  const mode: ModerateMode = input.mode ?? integrationDefaults.mode ?? "full";
  const toxicityThreshold =
    input.toxicityThreshold ?? integrationDefaults.toxicityThreshold ?? 0.7;

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
        ...decideFromToxicity(toxicityScore, toxicityThreshold),
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
    const megacallOptions: {
      comment: string;
      articleId?: string;
      includeSpam: boolean;
      includeCommentScore?: boolean;
    } = {
      comment: input.comment,
      includeSpam: true,
    };

    if (articleId) {
      megacallOptions.articleId = articleId;
      megacallOptions.includeCommentScore = true;
    }

    const result: MegaCallResult = await respectify.megacall(megacallOptions);
    const toxicityScore = result.comment_score?.toxicity_score;
    const explanation = result.comment_score?.toxicity_explanation;

    return {
      ...decideFromToxicity(toxicityScore, toxicityThreshold, {
        isSpam: result.spam_check?.is_spam,
        explanation,
      }),
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
