# rssmention

A [Webmention](https://www.w3.org/TR/webmention/) receiver for RSS and JSON Feed. It hosts comments
for blogs and other feeds, and Subreddit- and Facebook-Groups-like discussion groups. Users post and
comment by publishing an item in their own feed (RSS or JSON Feed) and sending a webmention. The
protocol is described in [RFC-4: Feed Submissions](https://github.com/bigwide-net/RFCs/blob/main/RFC-4-Feed-Submissions.md)
and [RFC-5: Comment HTML](https://github.com/bigwide-net/RFCs/blob/main/RFC-5-Comment-HTML.md).

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

## Groups and blogs

Every entry in `groups` is one target. Two options in the config change what it does:

- **Discussion group** (default): the group has its own posts feed. Anyone can post, and comment on posts.
- **Comments for a blog** (`externalFeeds`): the posts live in a feed elsewhere, for example
  `externalFeeds: ["https://alice.example/feed.xml", "https://alice.example/feed.json"]`. Comments target
  `<feed URL>#<post guid>`. rssmention fetches the feed to check that the post exists and that it does
  not have `allowComments: false` (`rm:commenting`, `_commenting`). The group has no posts feed. The blog
  links the comments of each post in `source:comments` (JSON: `_source.comments.feedUrl`) as
  `/groups/<group>/external/<post guid>/comments.(json|xml)`, and includes the `submissions` element from
  `/groups/<group>/submissions.(json|xml)` in its feed.
- **Comments only** (`submissionRules: { posts: false }`): a group whose posts are created by the admin
  only. The post rules still limit the comments per post (`posts.commentLimit`).

rssmention always republishes accepted submissions in full (`republish: "full"`). RFC-4 also defines
`summary` (an abstract with a link) and `no` (submissions go to the owner only), but rssmention doesn't
implement them.

## Endpoints

All paths are below `/groups/<group>`. `.json` serves JSON Feed and `.xml` serves RSS 2.0. Both have the same content.

| Method & path | |
|---|---|
| `GET /posts.(json\|xml)` | the group feed: the latest 50 posts |
| `GET /archive/posts-<n>.(json\|xml)` | archives (RFC 5005: `prev-archive`, JSON Feed: `next_url`) |
| `GET /comments/<post>/comments.(json\|xml)` | direct replies to a post |
| `GET /comments/<post>/<comment>/comments.(json\|xml)` | direct replies to a comment |
| `GET /external/<guid>/comments.(json\|xml)` | direct replies to post `<guid>` of an external feed (empty before the first comment) |
| `GET /submissions.(json\|xml)` | the `submissions` element, for external feeds to include |
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
  - a comment on a post: the feed containing the post plus `#post-guid`. For `externalFeeds`, that is
    the external feed: `https://alice.example/feed.xml#post-42`
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

### Example: sending a post

Alice publishes her feed at `https://alice.example.com/feed.xml` and wants to post in the group
`twowaves` on `https://rm.example.org`.

**1. Find the endpoint and the rules.** Fetch the group feed. The webmention endpoint is in
`<atom:link rel="webmention">` and `<rm:url>` (JSON: `_submissions.url`). `<rm:policies type="posts">`
lists the rules, for example whether a title is required and which HTML is allowed.

```
curl https://rm.example.org/groups/twowaves/posts.xml
```

**2. Publish the item in her own feed.** `source:inReplyTo` is the group feed. The `socialspec` account
must be the host name of her feed if `requireSocialSpec` is set.

```xml
<rss version="2.0" xmlns:source="http://source.scripting.com/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Alice's blog</title>
    <link>https://alice.example.com/</link>
    <source:account service="socialspec">@alice.example.com</source:account>
    <item>
      <guid isPermaLink="false">post-2026-11-04</guid>
      <title>Is RSS the better social network?</title>
      <link>https://alice.example.com/2026/11/rss-social</link>
      <pubDate>Wed, 04 Nov 2026 10:00:00 GMT</pubDate>
      <dc:creator>Alice</dc:creator>
      <description>&lt;p&gt;I think &lt;strong&gt;feeds&lt;/strong&gt; are all we need.&lt;/p&gt;</description>
      <source:markdown>I think **feeds** are all we need.</source:markdown>
      <source:inReplyTo>https://rm.example.org/groups/twowaves/posts.xml</source:inReplyTo>
    </item>
  </channel>
</rss>
```

The same item in JSON Feed:

```json
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "Alice's blog",
  "_source": { "accounts": { "socialspec": "@alice.example.com" } },
  "items": [{
    "id": "post-2026-11-04",
    "title": "Is RSS the better social network?",
    "url": "https://alice.example.com/2026/11/rss-social",
    "date_published": "2026-11-04T10:00:00Z",
    "authors": [{ "name": "Alice" }],
    "content_html": "<p>I think <strong>feeds</strong> are all we need.</p>",
    "_source": {
      "markdown": "I think **feeds** are all we need.",
      "inReplyTo": "https://rm.example.org/groups/twowaves/posts.json"
    }
  }]
}
```

**3. Send the webmention.** The source is the feed URL plus `#guid`. The target is the group feed.

```
curl -i https://rm.example.org/groups/twowaves/mention \
  --data-urlencode 'source=https://alice.example.com/feed.xml#post-2026-11-04' \
  --data-urlencode 'target=https://rm.example.org/groups/twowaves/posts.xml'
```

```
HTTP/1.1 201 Created
Location: https://rm.example.org/groups/twowaves/status/a8Kd03XpQz

{"status":"waiting","guid":"a8Kd03XpQz","statusUrl":"https://rm.example.org/groups/twowaves/status/a8Kd03XpQz"}
```

A request that fails the synchronous checks gets `400` with `{"type": "...", "message": "..."}`.

**4. Poll the status page** until the status is no longer `waiting`:

```
curl https://rm.example.org/groups/twowaves/status/a8Kd03XpQz
{"status":"success","pubDate":"2026-11-04T10:00:00.000Z","pubUrl":"https://rm.example.org/groups/twowaves/posts.json#a8Kd03XpQz"}
```

If the submission is rejected, the status contains a code and a reason, for example
`{"status":"failure","code":"title-required","text":"Posts require a title"}`. Other codes include
`too-short`, `too-long`, `fetch-failed`, `invalid-feed`, `item-not-found`, `ambiguous-source`, `in-reply-to-missing`,
`in-reply-to-mismatch`, `socialspec-missing`, `socialspec-mismatch`, `moderation-rejected` and `moderation-unavailable`.

**5. Comment on the post.** The post is now in the group feed with guid `a8Kd03XpQz`. To comment, Bob
publishes an item with `source:inReplyTo` set to
`https://rm.example.org/groups/twowaves/posts.xml#a8Kd03XpQz` and sends a webmention with that target.
His comment gets a guid like `a8Kd03XpQz-k2m9x` and appears in
`/groups/twowaves/comments/a8Kd03XpQz/comments.xml`. To reply to Bob, the target is that comments feed plus
`#a8Kd03XpQz-k2m9x`.

**6. Edit or delete (optional).** If the group sets `allowEdit`, Alice changes the item in her feed and
sends the same webmention again. If it sets `allowDelete`, she removes the item from her feed and sends
it again.

### Content rules

The HTML must be well-formed. `<p>` and `<br>` are always allowed. The other elements depend on the
rules:

| Rule | Elements |
|---|---|
| `allowStyle` | `strong`, `em`, `s` |
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

Length: `maxLength` counts the characters of the submitted Markdown, or of the HTML if there is no
Markdown. `minLength` (default 10) counts the visible text after rendering, with whitespace collapsed,
so markup doesn't count. A post that is only an image fails `minLength` unless it is set to 0.

## Feed extensions

Every feed, including archives and comment feeds, describes the group's submission rules. A client
can post and comment using only what the feed contains. rssmention uses two vocabularies:

- **Source**: the [RSS `source:` namespace](http://source.scripting.com/) and its JSON Feed equivalent
  `_source`, defined in [RFC-1: Source for JSON Feeds](https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md).
  It covers `markdown`, `accounts`, `inReplyTo` and `comments`. RFC-1 maps each `source:` element to a
  `_source` field, so both formats have the same content.
- **rssmention** (`https://rssmention.bigwide.net/`): `submissions` (the endpoint and rules) and
  `commenting` (whether a post accepts comments). In RSS these use the `rm:` prefix. In JSON Feed they
  are `_submissions` and `_commenting`, each with `about` set to the namespace URL.

### JSON Feed

The group feed `/groups/twowaves/posts.json`, with the rules from `rssmention.example.json5`:

```json
{
  "version": "https://jsonfeed.org/version/1.1",
  "title": "Two Waves RSS Discussion",
  "description": "Discussions about RSS, podcasts, open social networks and similar technology",
  "home_page_url": "https://rm.example.org/groups/twowaves/posts.json",
  "feed_url": "https://rm.example.org/groups/twowaves/posts.json",
  "next_url": "https://rm.example.org/groups/twowaves/archive/posts-3.json",
  "_submissions": {
    "about": "https://rssmention.bigwide.net/",
    "url": "https://rm.example.org/groups/twowaves/mention",
    "tos": "https://twowavesandadot.blog/discussion/tos.html",
    "policies": {
      "posts": {
        "minLength": 10, "maxLength": 8000, "urlAutoLinking": true, "allowStyle": true, "allowLinks": true,
        "allowCode": true, "allowQuote": false, "allowImages": false, "allowTables": false,
        "allowLists": true, "allowHeadlines": true, "requireSocialSpec": true, "title": "required",
        "allowEdit": false, "allowDelete": false, "commentLimit": 1000
      },
      "comments": {
        "minLength": 10, "maxLength": 4000, "urlAutoLinking": true, "allowStyle": true, "allowLinks": true,
        "allowCode": true, "allowQuote": false, "allowImages": false, "allowTables": false,
        "allowLists": false, "allowHeadlines": false, "requireSocialSpec": true, "title": "none",
        "allowEdit": false, "allowDelete": false, "commentLimit": 20, "maxDepth": 5
      }
    },
    "republish": "full"
  },
  "_source": {
    "about": "https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md",
    "accounts": { "socialspec": "@twowavesandadot.blog" }
  },
  "items": [{
    "id": "a8Kd03XpQz",
    "url": "https://alice.example.com/2026/11/rss-social",
    "title": "Is RSS the better social network?",
    "content_html": "<p>I think <strong>feeds</strong> are all we need.</p>",
    "date_published": "2026-11-04T10:00:00.000Z",
    "authors": [{ "name": "Alice" }],
    "_source": {
      "about": "https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md",
      "markdown": "I think **feeds** are all we need.",
      "accounts": { "socialspec": "@alice.example.com" },
      "comments": {
        "feedUrl": "https://rm.example.org/groups/twowaves/comments/a8Kd03XpQz/comments.json",
        "count": 3,
        "total": 7
      }
    },
    "_commenting": { "about": "https://rssmention.bigwide.net/", "allowComments": true }
  }]
}
```

A comment in `/groups/twowaves/comments/a8Kd03XpQz/comments.json` also has `_source.inReplyTo`, which
points to its parent. It has no `title` and no `_commenting`:

```json
{
  "id": "a8Kd03XpQz-k2m9x",
  "content_html": "<p>Agreed, but discovery is hard.</p>",
  "date_published": "2026-11-04T10:20:00.000Z",
  "authors": [{ "name": "Bob" }],
  "_source": {
    "about": "https://github.com/bigwide-net/RFCs/blob/main/RFC-1-Source-for-JSON-Feeds.md",
    "accounts": { "socialspec": "@bob.example.net" },
    "inReplyTo": "https://rm.example.org/groups/twowaves/posts.json#a8Kd03XpQz",
    "comments": {
      "feedUrl": "https://rm.example.org/groups/twowaves/comments/a8Kd03XpQz/a8Kd03XpQz-k2m9x/comments.json",
      "count": 1
    }
  }
}
```

| Field | Where | Meaning |
|---|---|---|
| `_submissions.url` | feed | webmention endpoint for posts and comments |
| `_submissions.tos` | feed | terms of service, if configured |
| `_submissions.policies.posts` / `.comments` | feed | the effective rules (see [Content rules](#content-rules) and `rssmention.example.json5`) |
| `_submissions.republish` | feed | always `"full"`: submissions are republished in full in this feed |
| `_source.accounts.socialspec` | feed, item | the group's account (feed) or the verified author account (item). RFC-1 map form |
| `_source.markdown` | item | the Markdown the author submitted, if any. `content_html` is always set |
| `_source.inReplyTo` | comment | the parent post or comment: its feed URL plus `#guid` |
| `_source.comments.feedUrl` | item | the feed with the direct replies. Use it plus `#guid` as the target of a reply |
| `_source.comments.count` | item | number of direct replies |
| `_source.comments.total` | post | number of comments on all levels (limit: `posts.commentLimit`) |
| `_commenting.allowComments` | post | `false` if an admin closed the post for comments |
| `next_url` | feed | the next older archive page |

When submitting, the client feed uses the same fields: `_source.inReplyTo`, `_source.markdown` and
`_source.accounts`. rssmention also accepts the RFC-1 list form of `accounts`
(`[{"service": "socialspec", "name": "@host"}]`) and `inReplyTo` as an object with `value`. A post
can set `_commenting.allowComments: false` to start with comments disabled.

### RSS

The same post in `/groups/twowaves/posts.xml`:

```xml
<rss version="2.0" xmlns:source="http://source.scripting.com/" xmlns:rm="https://rssmention.bigwide.net/"
     xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:fh="http://purl.org/syndication/history/1.0">
<channel>
<title>Two Waves RSS Discussion</title>
<link>https://rm.example.org/groups/twowaves/posts.xml</link>
<description>Discussions about RSS, podcasts, open social networks and similar technology</description>
<atom:link rel="self" href="https://rm.example.org/groups/twowaves/posts.xml" type="application/rss+xml"/>
<atom:link rel="webmention" href="https://rm.example.org/groups/twowaves/mention"/>
<atom:link rel="prev-archive" href="https://rm.example.org/groups/twowaves/archive/posts-3.xml"/>
<source:account service="socialspec">@twowavesandadot.blog</source:account>
<rm:submissions>
  <rm:url>https://rm.example.org/groups/twowaves/mention</rm:url>
  <rm:tos>https://twowavesandadot.blog/discussion/tos.html</rm:tos>
  <rm:policies type="posts" minLength="10" maxLength="8000" urlAutoLinking="true" allowStyle="true" allowLinks="true"
    allowCode="true" allowQuote="false" allowImages="false" allowTables="false" allowLists="true"
    allowHeadlines="true" requireSocialSpec="true" title="required" allowEdit="false" allowDelete="false"
    commentLimit="1000"/>
  <rm:policies type="comments" minLength="10" maxLength="4000" urlAutoLinking="true" allowStyle="true" allowLinks="true"
    allowCode="true" allowQuote="false" allowImages="false" allowTables="false" allowLists="false"
    allowHeadlines="false" requireSocialSpec="true" title="none" allowEdit="false" allowDelete="false"
    commentLimit="20" maxDepth="5"/>
  <rm:republish>full</rm:republish>
</rm:submissions>
<item>
  <title>Is RSS the better social network?</title>
  <link>https://alice.example.com/2026/11/rss-social</link>
  <guid isPermaLink="false">a8Kd03XpQz</guid>
  <pubDate>Wed, 04 Nov 2026 10:00:00 GMT</pubDate>
  <dc:creator>Alice</dc:creator>
  <description>&lt;p&gt;I think &lt;strong&gt;feeds&lt;/strong&gt; are all we need.&lt;/p&gt;</description>
  <source:markdown>I think **feeds** are all we need.</source:markdown>
  <source:account service="socialspec">@alice.example.com</source:account>
  <source:comments count="3" feedUrl="https://rm.example.org/groups/twowaves/comments/a8Kd03XpQz/comments.xml"/>
  <rm:commenting><rm:allowComments>true</rm:allowComments></rm:commenting>
</item>
</channel>
</rss>
```

Comments in RSS also have `<source:inReplyTo>`. RSS has no field for the total comment count. Archive
pages contain `<fh:archive/>` (RFC 5005).

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

Post guids are 10 base62 characters. For posts of external feeds, the post guid is derived from the
group id and the post's own guid (SHA-256), and `post.json` stores the original guid in `external`. A comment guid is `<parent-guid>-<5 base36 characters>`.

## License

MIT, see [LICENSE](LICENSE).
