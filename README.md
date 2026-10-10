# @respectify/astro-moderation

Thin Astro integration for [Respectify](https://respectify.ai) comment moderation.

Respectify does more than just comment moderation — it provides a complete solution for managing and enhancing user-generated content. It monitors for tone, logical fallacies, and spam and educates commenters on how to improve their comments.

Add the integration, set two env vars, then call `moderateComment()` from your own actions or API routes. **No comment UI, no database, no Astro Actions wiring.**

Want hosted Astro comments (UI + DB)? Use [`@respectify/astro`](https://www.npmjs.com/package/@respectify/astro) instead.
API-only outside Astro? Use [`@respectify/client`](https://www.npmjs.com/package/@respectify/client).

## Install

```bash
npm install @respectify/astro-moderation @respectify/client
```

## Setup

```ts
// astro.config.mjs
import { defineConfig } from "astro/config";
import respectifyModeration from "@respectify/astro-moderation";

export default defineConfig({
  integrations: [
    respectifyModeration({
      mode: "full", // or "spam-only" | "perspective"
      // Optional: override the API key's saved tolerances for the categories named
      tolerances: { insult: "relaxed", threat: "zero_tolerance" },
    }),
  ],
});
```

```env
RESPECTIFY_EMAIL=you@example.com
RESPECTIFY_API_KEY=your-api-key
```

## Moderate a comment

```ts
// e.g. src/pages/api/comments.ts or an Astro Action
import { moderateComment } from "@respectify/astro-moderation";

const result = await moderateComment({
  comment: userText,
  topicUrl: Astro.site ? new URL(`/blog/${slug}`, Astro.site).toString() : undefined,
});

if (!result.approved) {
  return { ok: false, feedback: result.feedback };
}

// save/publish the comment yourself
```

### Modes

| Mode | Behaviour |
| --- | --- |
| `full` (default) | Spam check + comment score when topic context is available |
| `spam-only` | Spam detection only |
| `perspective` | Perspective-compatible toxicity / insult / profanity scores |

### How the decision is made

| Mode | Blocked when |
| --- | --- |
| `full` | Spam, **or** the comment score's `exceeds_tolerance` is true, **or** `toxicity_score >= toxicityThreshold` *if you set a threshold* (none by default) |
| `spam-only` | Spam |
| `perspective` | `TOXICITY >= toxicityThreshold` (default `0.7`) |

In `full` mode, `exceeds_tolerance` is the main signal: Respectify sets it when the comment has a problem your site's tolerances do not accept. `toxicity_score` is not adjusted for tolerances, so only set `toxicityThreshold` in `full` mode if you want an extra, tolerance-independent cut-off. Without topic context (`articleId`, `topicUrl`, `topicText` or `defaultTopicUrl`) there is no comment score, so only spam is checked.

`result.exceedsTolerance` and `result.tolerances` (the full set the comment was judged under) are returned in `full` mode when a comment score was run.

### Moderation tolerances

Each API key has saved tolerances, one per category, set in the Respectify dashboard. The `tolerances` option overrides them for the categories it names; the rest keep their saved level. A per-call `tolerances` passed to `moderateComment()` is merged over the integration's.

- Categories: `threat`, `identity_attack`, `sexual_content`, `harassment`, `insult`, `profanity`, `dismissive_tone`, `logical_fallacy`, `low_effort`
- Levels: `relaxed`, `standard` (default), `strict`, `zero_tolerance`
- `threat`, `identity_attack`, `sexual_content` and `harassment` are floored: they can be made stricter but never `relaxed`. The integration throws at setup if you try, and `moderateComment()` rejects it per call.

### Tip: cache `articleId`

`moderateComment()` returns `articleId` when it initializes a topic. Reuse it for later comments on the same page to avoid re-init:

```ts
const result = await moderateComment({
  comment: userText,
  articleId: cachedArticleIdForThisPost,
});
```

## Compared to `@respectify/astro`

| | `@respectify/astro-moderation` | `@respectify/astro` |
| --- | --- | --- |
| Purpose | Moderate existing comments | Full comments product |
| UI | Yours | Included |
| Database | Yours | Astro DB |
| Setup | Integration + 2 env vars | DB + actions + component |

## Links

- Product: https://respectify.ai
- Comment moderation API guide: https://respectify.ai/comment-moderation-api
- Client SDK: https://www.npmjs.com/package/@respectify/client

## License

MIT
