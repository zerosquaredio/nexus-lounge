# The Public Hub's Terms

The terms of service and privacy notice of the public hub at
`hub.cyberspace.nexus`, run by zerosquared.io. The hub serves them at
`/terms` and `/privacy` from the files named in its config
(`policy.termsFile` and `policy.privacyFile`). It reads them on each request,
so a change shows without a restart. They're HTML fragments: the hub puts
its own page around them.

`drafts/` holds sections not yet in force, for the lawyer's review first:
`terms-art.html`, on the art the hub shows (with the questions for the
lawyer in a comment at its end). The hub doesn't serve them.

Another hub should write its own, since these name this hub's operator, its
age limit, its content rules and how long it keeps things. They're a
starting point, not legal advice, and they haven't yet been reviewed by a
lawyer.

What they say must match what the hub does. When the hub changes what it
keeps, or for how long, update the privacy notice, and its date, in the same
change:

| The notice says | Where that comes from |
|---|---|
| 16 or older | `policy.minimumAge` |
| General rating only | `directory.ratings` (`["general"]`) |
| Sessions last up to 7 days | `SessionDays` in `control/src/signin.ts` |
| Two cookies: `hub_session`, and `hub_view` for a year, not passed to BBSes | `sessionCookie()` and `viewCookie()` in `control/src/site.ts`; `ViewCookieRe2` in `generate.ts` (the edge takes it out) |
| BBSes see the common space and speak for members who confirmed them | `/api/bbs/live` and `/api/bbs/chat/*` in `control/src/site.ts` |
| Pictures: read every few hours, deleted when off, on removal, or unseen a week; none for labelled profiles | `control/src/pictures.ts` |
| Logs kept 3 months | the server's journal (`MaxRetentionSec=3month`) |
| Backups kept up to 12 months | the backup pull's retention (14 nightly, 12 monthly) |
| A removed BBS's name held 90 days | `NameHoldDays` in `control/src/registry.ts` |
| Closed reports lose what they said | `abuse.ts` and `moderation.ts` |
