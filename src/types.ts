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
   * Used when mode is "full" or "perspective".
   * @default 0.7
   */
  toxicityThreshold?: number;

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
  /** Article context used (useful to cache for later comments on the same page) */
  articleId?: string;
  /** Perspective attribute scores when mode is "perspective" */
  perspectiveScores?: Record<string, number>;
  /** Underlying megacall / perspective payload for advanced callers */
  raw?: unknown;
}
