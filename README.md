# rssmention

A [Webmention](https://www.w3.org/TR/webmention/) receiver for RSS and JSON Feed. It hosts
Subreddit- and Facebook-Groups-like discussion groups. Each group is a feed. Users post and comment by
publishing an item in their own feed (RSS or JSON Feed) and sending a webmention.

## Running

```
npm install
cp rssmention.example.json5 rssmention.json5   # edit baseUrl, groups, adminToken
cp .env.example .env
npm start
npm test
```

| Variable | Meaning |
|---|---|
| `RSSMENTION_CONFIG` | config file (default `./rssmention.json5`) |
| `RSSMENTION_VAR` | data directory (default `./var`) |
| `RSSMENTION_PORT`, `RSSMENTION_BASE_URL` | override `port` and `baseUrl` from the config |
| `OPENROUTER_API_KEY` | API key for the moderation model (`moderationLLM`) |
| `RSSMENTION_ALLOW_PRIVATE_TARGETS` | `true` allows fetching sources on private addresses (development only) |
| `LIMITS_*` | rate limits, see `lib/limits.middleware.ts` |
| `HAPPY_SECRET` | secret for the `/happy` health endpoints |

## Endpoints

All paths are below `/groups/<group>`. `.json` serves JSON Feed and `.xml` serves RSS 2.0. Both have the same content.

| Method & path | |
|---|---|
| `GET /posts.(json\|xml)` | the group feed: the latest 50 posts |
| `GET /archive/posts-<n>.(json\|xml)` | archives (RFC 5005: `prev-archive`, JSON Feed: `next_url`) |
| `GET /comments/<post>/comments.(json\|xml)` | direct replies to a post |
| `GET /comments/<post>/<comment>/comments.(json\|xml)` | direct replies to a comment |
| `POST /mention` | webmention endpoint (`source`, `target`; form-encoded or JSON) |
| `GET /status/<guid>` | submission status: `waiting`, `success`, `deleted` or `failure` (in memory, kept ≥ 1 hour) |

Admin endpoints need the header `Authorization: Bearer <adminToken>`:

| Method & path | |
|---|---|
| `GET /admin/(submissions\|failed\|published)[?archive=n]` | group logs with internal data |
| `GET /admin/items/<guid>` | a published post or comment, its post metadata, and failed replies |
| `PUT /admin/items/<guid>` `{title?, text}` | replaces a post or comment; the author becomes "Admin" |
| `DELETE /admin/items/<guid>` | deletes a post or comment and all replies to it |
| `POST /admin/items/<guid>/approve` | publishes a submission that failed moderation |
| `PUT /admin/posts/<guid>/commenting` `{allowComments}` | enables or disables comments on a post |

## Submitting

- **Source**: the feed with the user's item, written as `feed-url#guid` (JSON: `#id`). The fragment can be
  left out if the feed has only one item.
- **Target**:
  - a new post: the group feed (`…/posts.xml` or `…/posts.json`)
  - a comment on a post: the feed containing the post plus `#post-guid`
  - a reply to a comment: the comments feed containing the comment plus `#comment-guid`
- The item must have `source:inReplyTo` (RSS) or `_source.inReplyTo` (JSON) equal to the target. The `.xml`
  and `.json` URLs count as the same.
- If `requireSocialSpec` is set, the item or its feed must declare
  `<source:account service="socialspec">@host</source:account>` (JSON: `_source.accounts.socialspec`). The
  host must be the source feed's host name. When `requireSocialSpec` is not set, an account that does
  not match is left out of the republished item.
- Markdown (`source:markdown`, `_source.markdown`) takes precedence over HTML. Raw HTML inside Markdown is
  escaped.
- A submitted pubDate is kept if it is within 30 minutes of the submission. Otherwise the submission
  time is used.
- Re-sending the same source updates the item if `allowEdit` is set. If `allowDelete` is set and the
  feed answers 404/410, or the item is no longer in the feed, the item is deleted.

Synchronous checks (URL syntax, target exists, comments allowed, limits, depth) answer with 400. If the
checks pass, the response is `201` with `Location: <status page>`. Processing then runs asynchronously,
one submission at a time (queue limit 100, after that 503).

### Content rules

The HTML must be well-formed. `<p>` and `<br>` are always allowed. The other elements depend on the
rules:

| Rule | Elements |
|---|---|
| `allowStyle` | `strong`, `em` |
| `allowLinks` | `a` (requires `href`) |
| `allowCode` | `code`, `pre` |
| `allowQuote` | `q`, `blockquote` |
| `allowImages` | `img` (requires `src`) |
| `allowTables` | `table`, `thead`, `tbody`, `tr`, `td`, `th` (nesting is checked) |
| `allowLists` | `ul`, `ol`, `li` (nesting is checked) |
| `allowHeadlines` | `h1`–`h6` |

Any other element causes a rejection. All attributes except `a@href`, `img@src` and `img@alt` are
removed. URLs must be absolute http(s) and at most 512 characters, and link text at most 120 characters.
Runs of more than two `<br>` are cut to two. A submission is allowed 3 `<br>` plus 1 per 80 characters
of text, and 3 `<p>` plus 1 per 200. With `urlAutoLinking`, bare URLs become links after validation,
so this also works when `allowLinks` is off.

## Feed extensions

Every feed includes the submission configuration.

RSS (namespace `xmlns:rm="https://rssmention.bigwide.net/"`):

```xml
<rm:submissions>
  <rm:url>https://…/groups/twowaves/mention</rm:url>
  <rm:tos>https://…/tos.html</rm:tos>
  <rm:policies type="posts" maxLength="8000" title="required" … commentLimit="1000"/>
  <rm:policies type="comments" maxLength="4000" title="none" … commentLimit="20" maxDepth="5"/>
  <rm:republish>true</rm:republish>
</rm:submissions>
```

Each post has `<rm:commenting><rm:allowComments>true</rm:allowComments></rm:commenting>`. Posts and
comments have `<source:comments count="…" feedUrl="…"/>`.

JSON Feed: `_submissions` (`about`, `url`, `tos`, `policies: {posts, comments}`, `republish`).
`_commenting` (`about`, `allowComments`) on posts. `_source.comments` (`feedUrl`, `count`, plus `total`
on posts) as in Downread RFC-1. `_source.accounts` uses the map form, for example
`{"socialspec": "@host"}`.

## Storage

```
$RSSMENTION_VAR/groups/<group>/
  group-submissions.json, group-failed.json, group-published.json    latest 50, newest first
  archive/group-<log>-<n>.json                                        50 items per file
  comments/<post>/post.json                                           archive no., reply counts, allowComments
  comments/<post>/comments-published-<parent>.json                    direct replies to <parent>
  comments/<post>/comments-failed-<parent>.json                       latest 50 failed replies
  sources.json                                                        source URL → guid (edits/deletes)
```

Post guids are 10 base62 characters. A comment guid is `<parent-guid>-<5 base36 characters>`.
