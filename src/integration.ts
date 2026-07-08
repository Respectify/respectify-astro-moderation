import type { AstroIntegration } from "astro";
import { envField } from "astro/config";
import { setModerationDefaults } from "./moderate.js";
import type { RespectifyAstroModerationOptions } from "./types.js";

/**
 * Thin Astro integration for Respectify moderation.
 *
 * Adds env schema for RESPECTIFY_EMAIL / RESPECTIFY_API_KEY and stores
 * default options used by moderateComment().
 *
 * Does NOT inject comment UI, database schema, or Astro Actions —
 * you keep your existing comment stack and call moderateComment() from it.
 */
export default function respectifyModeration(
  options: RespectifyAstroModerationOptions = {},
): AstroIntegration {
  setModerationDefaults(options);

  return {
    name: "@respectify/astro-moderation",
    hooks: {
      "astro:config:setup": ({ updateConfig, logger }) => {
        updateConfig({
          env: {
            schema: {
              RESPECTIFY_EMAIL: envField.string({
                context: "server",
                access: "secret",
              }),
              RESPECTIFY_API_KEY: envField.string({
                context: "server",
                access: "secret",
              }),
            },
          },
        });

        logger.info(
          `Respectify moderation ready (mode=${options.mode ?? "full"}). Call moderateComment() from your actions/API routes.`,
        );
      },
    },
  };
}
