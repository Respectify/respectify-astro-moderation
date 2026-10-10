import type {
  ModerationTolerances,
  ResolvedModerationTolerances,
} from "@respectify/client";

export type ModerateMode = "full" | "spam-only" | "perspective";

export interface RespectifyAstroModerationOptions {
  /**
   * Which analysis path to use by default.
   * - full: spam + comment score (topic context when URL/text provided)
   * - spam-only: spam check only
   * - perspective: Perspective-compatible toxicity attribute scores
   * @default "full"
   */
  mode?: ModerateMode;

  /**
   * Toxicity block threshold for auto-decision (0–1). Higher = more toxic.
   *
   * - perspective mode: the comment is blocked when TOXICITY >= threshold. Defaults to 0.7.
   * - full mode: the comment score's `exceeds_tolerance` decides. A threshold set here
   *   (or per call) also applies, as an extra block on `toxicity_score >= threshold`;
   *   when none is set, only `exceeds_tolerance` decides.
   */
  toxicityThreshold?: number;

  /**
   * Moderation tolerances for the comment score (full mode). The categories named
   * override the API key's saved tolerances; the rest keep their saved level.
   * Floored categories (threat, identity_attack, sexual_content, harassment) can
   * never be "relaxed": the integration rejects that at setup.
   */
  tolerances?: ModerationTolerances;

  /**
   * Optional default page/topic URL used to build article context when
   * moderateComment() is called without topicUrl/topicText.
   */
  defaultTopicUrl?: string;
}

export interface ModerateCommentInput {
  /** Comment text to analyse */
  comment: string;
  /** Existing Respectify article/topic UUID (skips init when set) */
  articleId?: string;
  /** Initialize topic from this URL when articleId is missing */
  topicUrl?: string;
  /** Initialize topic from this text when articleId / topicUrl missing */
  topicText?: string;
  /** Override integration default mode for this call */
  mode?: ModerateMode;
  /** Override toxicity threshold for this call */
  toxicityThreshold?: number;
  /**
   * Override tolerances for this call (full mode). Merged over the integration's
   * `tolerances`: a category named here wins, the others keep the integration's level.
   */
  tolerances?: ModerationTolerances;
}

export interface ModerateCommentResult {
  /** Whether the comment should be allowed through */
  approved: boolean;
  /** Short reason / coaching feedback for the commenter or your logs */
  feedback: string;
  /** Toxicity-ish score when available (0 = clean, 1 = highly toxic) */
  toxicityScore?: number;
  /** True when spam was detected */
  isSpam?: boolean;
  /**
   * True when the comment has a problem the site's tolerances do not accept
   * (full mode with a comment score only).
   */
  exceedsTolerance?: boolean;
  /** The tolerances the comment score was judged under (full mode with a comment score only) */
  tolerances?: ResolvedModerationTolerances;
  /** Article context used (useful to cache for later comments on the same page) */
  articleId?: string;
  /** Perspective attribute scores when mode is "perspective" */
  perspectiveScores?: Record<string, number>;
  /** Underlying megacall / perspective payload for advanced callers */
  raw?: unknown;
}
