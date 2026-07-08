export { default } from "./integration.js";
export { default as respectifyModeration } from "./integration.js";
export { moderateComment, getModerationDefaults, setModerationDefaults } from "./moderate.js";
export type {
  ModerateCommentInput,
  ModerateCommentResult,
  ModerateMode,
  RespectifyAstroModerationOptions,
} from "./types.js";
