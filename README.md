# @respectify/astro-moderation

Thin Astro integration for [Respectify](https://respectify.ai) comment moderation.

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
      toxicityThreshold: 0.7,
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
