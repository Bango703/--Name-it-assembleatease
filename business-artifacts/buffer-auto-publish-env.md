# AssembleAtEase Buffer Auto-Publishing Env Vars

Buffer is the social publishing hub. AssembleAtEase generates the content kit, then sends posts to Buffer channels instead of connecting to Facebook, Instagram, LinkedIn, and Google Business Profile separately.

## Why Buffer

- One API key instead of separate social platform tokens.
- One place to connect and reconnect social accounts.
- Buffer handles each platform's publishing rules, queue, and channel health.
- The owner can still review posts in Buffer before they go out if the channel or workspace requires approval.

## Required

`BUFFER_API_KEY=...`

Create this in Buffer API settings. Buffer authenticates GraphQL requests with a Bearer token.

## Channel IDs

Add the Buffer channel IDs you want AssembleAtEase to publish to:

`BUFFER_FACEBOOK_CHANNEL_ID=6a2ae0a838b5579345855678`
`BUFFER_INSTAGRAM_CHANNEL_ID=...`
`BUFFER_LINKEDIN_CHANNEL_ID=...`
`BUFFER_GOOGLE_BUSINESS_CHANNEL_ID=6a2c5eb738b55793458c2939`

The system skips any channel ID that is missing and shows the missing value in the owner dashboard.

## Optional

`SOCIAL_AUTO_PUBLISH=true`

When true, future auto-blog posts are automatically sent to Buffer after the Guide is created. Leave this off until the Buffer channels are confirmed.

`BUFFER_POST_MODE=addToQueue`

Recommended. Sends posts into the normal Buffer queue. Other Buffer modes can be used later if needed.

`BUFFER_SCHEDULING_TYPE=automatic`

Recommended for channels that can publish automatically.

`BUFFER_ATTACH_IMAGE=true`

Default is true. The system sends the article image URL as a Buffer image asset when available.

## Owner Dashboard

Open `Owner Dashboard -> Content Kit`.

- `Generate` previews the content kit.
- `Test only` shows the exact Buffer post payloads without publishing.
- `Publish now` sends the post to every configured Buffer channel.
- `Email to me` keeps an owner-side record.

## Buffer Docs Used

- API overview: https://buffer.com/api
- Data model: https://developers.buffer.com/guides/data-model.html
- Create text post: https://developers.buffer.com/examples/create-text-post.html
- Create image post: https://developers.buffer.com/examples/create-image-post.html
- Get channels: https://developers.buffer.com/examples/get-channels.html
