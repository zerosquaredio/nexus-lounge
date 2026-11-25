# The Public Hub's Terms

The terms of service and privacy notice of the public hub at
`hub.cyberspace.nexus`, run by zerosquared.io. The hub serves them at
`/terms` and `/privacy` from the files named in its config
(`policy.termsFile` and `policy.privacyFile`). It reads them on each request,
so a change shows without a restart. They're HTML fragments: the hub puts
its own page around them.

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
| Logs kept 3 months | the server's journal (`MaxRetentionSec=3month`) |
| Backups kept up to 12 months | the backup pull's retention (14 nightly, 12 monthly) |
| A removed BBS's name held 90 days | `NameHoldDays` in `control/src/registry.ts` |
| Closed reports lose what they said | `abuse.ts` and `moderation.ts` |
