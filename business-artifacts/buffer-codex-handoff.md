# Buffer / Content Engine Handoff For Next Codex Chat

Use this note to let another Codex chat continue the Buffer setup without re-discovering context.

## Strict Instructions From User

The user is preparing AssembleAtEase for real launch and is very concerned about accidental breakage.

Follow these rules exactly:

- Do not add emojis anywhere in the platform.
- Do not add playful copy, casual filler, or gimmicky language.
- Do not make random visual/design changes.
- Do not change unrelated files.
- Do not remove existing working features.
- Do not push unless the user explicitly says `push`.
- Do not deploy unless the user explicitly approves.
- Do not touch live data unless the user explicitly approves.
- Do not turn on automatic publishing until a manual Buffer test succeeds.
- Do not add independent Facebook/Instagram/LinkedIn/Google APIs. Use Buffer as the hub.
- Do not make the site cluttered.
- Keep customer-facing language professional, welcoming, clear, and not scary.
- If auditing, audit first and recommend before fixing.
- If coding, make the smallest safe change and test it.

The user specifically does not want another chat adding emojis or ignoring strict instructions.

## Current Goal

AssembleAtEase should use Buffer as the single social publishing hub instead of separate Facebook, Instagram, LinkedIn, and Google Business Profile APIs.

The user wants automation now:

- Website blog/content kit creates social versions.
- Owner can publish through Buffer from the owner dashboard.
- Auto-blog can publish to Buffer when enabled.
- Free Buffer plan currently allows 3 channels, but the launch focus is 2 channels first:
  - Facebook
  - Google Business Profile

LinkedIn is not ready for the user right now. Instagram should wait.

## Buffer Account Info From Working Codex Chat

The user's other Codex chat successfully connected to Buffer and reported:

- Name: `tg703664`
- Email: `tg703664@gmail.com`
- Timezone: `America/Chicago`
- Organization: `My Organization`
- Limits: 3 channels, 10 scheduled posts, 100 ideas, 3 tags

This current chat's Buffer MCP token kept returning expired-token errors, but the other Codex chat can access Buffer.

## Ask The Working Chat For Channel IDs

Ask the working Buffer-connected Codex chat:

```text
List my Buffer channels for My Organization. Show channel ID, service, display name, and connection status.
```

Needed values:

```env
BUFFER_FACEBOOK_CHANNEL_ID=6a2ae0a838b5579345855678
BUFFER_GOOGLE_BUSINESS_CHANNEL_ID=6a2c5eb738b55793458c2939
```

Optional later:

```env
BUFFER_LINKEDIN_CHANNEL_ID=
BUFFER_INSTAGRAM_CHANNEL_ID=
```

## Env Setup Needed

Required:

```env
BUFFER_API_KEY=
BUFFER_FACEBOOK_CHANNEL_ID=6a2ae0a838b5579345855678
BUFFER_GOOGLE_BUSINESS_CHANNEL_ID=6a2c5eb738b55793458c2939
```

Optional:

```env
SOCIAL_AUTO_PUBLISH=true
BUFFER_POST_MODE=addToQueue
BUFFER_SCHEDULING_TYPE=automatic
BUFFER_ATTACH_IMAGE=true
```

Leave LinkedIn and Instagram blank until those channels are ready. The code skips missing channels.

## Local Files Changed In This Workspace

These changes were made locally and were not pushed from this chat:

- `api/_social-publisher.js`
  - New Buffer-backed social publisher.
  - Exports `getSocialAutomationStatus()` and `publishContentKit()`.
  - Uses Buffer GraphQL endpoint `https://api.buffer.com`.
  - Publishes per channel using Buffer channel IDs.
  - Supports dry run.

- `api/owner/content-kit.js`
  - Keeps existing owner-auth behavior.
  - Adds POST publishing flow through Buffer.
  - GET still generates/list/emails content kits.

- `api/cron/auto-blog.js`
  - Uses Buffer publisher when `SOCIAL_AUTO_PUBLISH=true`.
  - Keeps owner email kit behavior.

- `owner/index.html`
  - Owner dashboard Content Kit modal now references Buffer.
  - Adds Publish now and Test only actions.
  - Shows Buffer connection status.

- `business-artifacts/buffer-auto-publish-env.md`
  - Documents Buffer setup.

- `business-artifacts/content-engine-plan.md`
  - Automation gate updated from individual social APIs to Buffer.

## Checks Already Passed

These checks passed in this workspace:

```powershell
node --check api\_social-publisher.js
node --check api\owner\content-kit.js
node --check api\cron\auto-blog.js
npm test
git diff --check
```

Owner dashboard inline script parsing also passed:

```text
owner/index.html: 2 scripts, 0 errors
```

Dry-run Buffer publishing was tested with fake channel IDs and produced payloads for:

- Facebook
- Instagram
- LinkedIn
- Google Business Profile

No real Buffer post was sent from this chat.

## Recommended Next Step

1. In the working Buffer-connected Codex chat, list the Buffer channels.
2. Copy the Facebook and Google Business Profile channel IDs.
3. Add the env vars to the deployment provider.
4. Run the owner dashboard `Test only` button first.
5. Then publish one real low-risk test post to Buffer queue.
6. Only after that, set `SOCIAL_AUTO_PUBLISH=true`.

## Do Not Do Yet

- Do not add Instagram until the business has enough visual content.
- Do not force LinkedIn until the user can connect it cleanly.
- Do not turn on full auto-publish before a manual Buffer dry run succeeds.
- Do not push unless the user explicitly asks.
