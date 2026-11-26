# Where Your Art Lives, and How Much Fits

For sysops whose boards publish art, and anyone publishing art from their
own Bluesky account. Last checked 2026-11-26; Bluesky's figures change, so
the sources are below.

## Where things are kept

| What | Where it lives | Who can see it |
|---|---|---|
| A board's listing, status, art records and their files | The board's own Bluesky (AT Protocol) account, on its account server, usually Bluesky's own (`bsky.social`) | Anyone: AT records and files are public |
| A board's splash screen and emblem | On the board itself, served to its hub through its tunnel, and named in its listing | Anyone the hub shows them to |
| Copies the hub drew from the art (cleaned ANSI, pictures, text) | On the hub, named by their content | Anyone using the hub |

So the files themselves stay in the account that published them. A hub
keeps its own cleaned copies, so it can show the art while the board is
offline. When a board stops publishing a piece, the hub stops showing it the
next time it looks, within about ten minutes.

**Everything published is public, and stays copyable.** Publish only art
that is yours to share, and give its licence. Taking a piece down removes it
from the account and the hub, but anyone may already have saved a copy.

## What the hub takes

The hub has its own limits, much smaller than Bluesky's:

- **ANSI art only, for now**, at most **64 KB** a file, **160 columns** wide
  and **1,000 lines** long. That's room for almost any BBS screen; a full
  80 by 25 screen is usually 2 to 10 KB.
- The hub cleans each file before showing it: nothing but characters,
  colours and line ends survives, and ENiGMA½'s menu codes are blanked, so
  none of a board's live details (node numbers, dates, addresses) show.
- Credit comes from the file's SAUCE record (title, artist, group), so it's
  worth filling in when you draw a piece.

## What Bluesky's servers allow

Bluesky doesn't publish a total storage limit for an account. What it does
publish:

- **Each file:** up to **50 MB** in Bluesky's rate-limit docs. Bluesky raised
  its video uploads to 300 MB in August 2026, so the limit for other files
  may now be higher too; we haven't confirmed it.
- **Writing records:** each account has **5,000 points an hour** and
  **35,000 a day**. Creating a record costs 3 points, changing one 2,
  deleting one 1, so at most about 1,666 new records an hour. Uploading a
  file costs no points.
- **Pictures in Bluesky posts** are limited to about 2 MB by Bluesky's own
  apps. That's Bluesky's limit for its posts, not ours.
- **A file nothing uses is cleared** after a while: a file uploaded but never
  named by a record. Boards upload a piece and publish its record together,
  so this only matters if something goes wrong in between.

## What this means

- **ANSI art is nowhere near any of this.** A board could publish hundreds of
  pieces without coming close.
- **Large art later, such as 3D models and avatars, is different.** One can be
  tens of megabytes. That fits within a single file's limit, but keeping
  many on `bsky.social`, with no published quota, relies on Bluesky's
  goodwill. A self-hosted account server holds whatever its owner allows;
  the project plans one a hub can run, and resource nodes for people's own
  storage.

## Sources

- [Bluesky rate limits](https://bsky.network/docs/rate-limits/) (bsky.network)
- [Rate limits](https://docs.bsky.app/docs/advanced-guides/rate-limits) and
  [rate limits, PDS v3](https://docs.bsky.app/blog/rate-limits-pds-v3) (Bluesky's docs)
- [The account server's own defaults](https://github.com/bluesky-social/pds) (bluesky-social/pds)
- [Bluesky raises its video limit](https://www.thebrief.news/en/standard/article/15830/bluesky-raises-video-limit-to-10-minutes-triples-upload-speed) (The Brief)
- [Bluesky's image size limit](https://adaptlypost.com/blog/bluesky-image-size-limit) and
  [API rate limits](https://adaptlypost.com/blog/bluesky-api-rate-limit) (AdaptlyPost)
