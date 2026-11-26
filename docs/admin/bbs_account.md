# A BBS's AT Account and Hub Handle

How a BBS gets its own AT account, and a handle under its hub such as
`@coolbbs.hub.example`: the steps, how the check works, and who writes what.
For sysops and hub operators. The rules themselves are in
[hub.md](../development/hub.md) §4.1 and [publishing.md](../development/publishing.md) §2.

## 1. Why a BBS has its own account

A BBS speaks for itself on AT: its listing, status and announcements come
from its own account, not the sysop's ([publishing.md](../development/publishing.md) §2).
That keeps the sysop's personal account separate, and lets the BBS be handed
to someone else later. The account can be any AT account, including an
ordinary `bsky.social` one.

A hub can then give that account a handle under the hub's domain. The handle
shows people that the account really is the BBS at that address.

## 2. What a handle is

An AT account has a permanent ID, its **DID** (such as `did:plc:abc123`), and
a **handle**, a domain name for people to read (such as
`@coolbbs.hub.example`). The handle can change; the DID, the account's posts
and its followers never depend on it.

A handle is valid only when two public answers agree:

1. **The account names the handle.** The account's DID document (for
   `did:plc` accounts, in the [PLC directory](https://plc.directory)) lists
   `at://coolbbs.hub.example`. Only the account can change this, through
   its host (PDS), which holds its signing key. On its own this is just a
   claim: anyone can claim any name in their own record.
2. **The name points back at the account.** Whoever answers for the domain
   name confirms the DID, in one of two ways:
   - a DNS TXT record at `_atproto.coolbbs.hub.example`, holding
     `did=did:plc:abc123`; or
   - an HTTPS answer at
     `https://coolbbs.hub.example/.well-known/atproto-did`, holding just the
     DID.

The account's host checks both when the handle is set, and apps check again
from time to time. If the name stops pointing back, the handle shows as
invalid until it does again, or until the account picks another handle.

## 3. How the hub answers for its names

The hub operator sets up DNS once: `A` and `AAAA` records for the hub's
domain and a wildcard below it (`hub` and `*.hub`), pointing at the hub
server. Every name under the hub then reaches the hub, with no DNS record per
BBS. The hub's edge gets each name its HTTPS certificate when first asked,
but only for registered BBSes.

For `/.well-known/atproto-did`, the hub answers **itself**, from its
registry:

- If the name is a registered BBS with an account set, it returns that DID.
- Otherwise it returns 404.
- The request never reaches the BBS, so a BBS can't claim another DID, and
  the handle keeps working while the BBS is offline.

So the hub is the authority for every handle under its domain, as Bluesky is
for `*.bsky.social`. The hub publishes no records for this: it only answers
the question when asked. Setting a BBS's account changes a field in the
hub's own database; the one public record that changes is the account's DID
document, written by the account's host when the handle is switched.

## 4. Steps

### 4.1 Make the account

Make an AT account for the BBS, separate from your own: on Bluesky, or any
other host. Its first handle doesn't matter, since it gets replaced. Keep
its password to yourself, as with any account.

Each account needs its own email address. With Gmail, a `+` tag gives you
more without new mailboxes: `you+coolbbs@gmail.com` arrives in your usual
inbox, but counts as a different address.

### 4.2 Register the account with the hub

Tell the hub which account is the BBS's. Either:

- **On the hub's site:** "Your BBS's own Bluesky account" when registering,
  or the account form on **Your BBSes** (`/bbs`) afterwards. It takes a handle or a
  DID; empty clears it.
- **By the hub operator:** `hubctl set-did NAME DID` (or `clear`), or
  `hubctl add NAME --sysop DID --did BBS_DID` for a new BBS.

Then check the hub's answer; it should be just the DID:

```
curl https://coolbbs.hub.example/.well-known/atproto-did
```

### 4.3 Switch the handle

In Bluesky, signed in as the BBS's account: **Settings → Account → Handle →
I have my own domain**. Enter `coolbbs.hub.example`, choose **No DNS
panel**, and press **Verify Text File**. The page asks you to upload a file
holding the DID: skip that, since the hub already answers there. Then switch
to the new handle.

Bluesky keeps the account's old `.bsky.social` handle reserved for it, so
it can switch back later, and nobody else can take that name.

### 4.4 Check it from outside

```
curl "https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=coolbbs.hub.example"
curl https://plc.directory/did:plc:abc123
```

The first should return the DID. The second, the account's DID document,
should list `at://coolbbs.hub.example` under `alsoKnownAs`.

## 5. When things change

- **The BBS is removed, or its account cleared:** the hub stops answering
  for the name at once, and the handle turns invalid. The account keeps
  everything else, and can go back to its reserved handle.
- **The BBS is suspended:** the hub refuses its tunnel and new
  certificates, and answers for active BBSes only, so the handle stops
  verifying at once as well. Resuming the BBS brings it back.
- **The BBS moves to another hub, or its own domain:** set the account on
  the new hub (or a DNS TXT record on the BBS's own domain), then switch the
  handle again.

## 6. If it doesn't verify

| Symptom | Likely cause |
|---|---|
| The hub's answer is 404 | No account set for that BBS on the hub, or the name isn't registered |
| No HTTPS at all for the name | The name isn't registered, so the hub's edge won't get it a certificate |
| The answer is a different DID | The account set on the hub is another one; set it again |
| Bluesky says it can't verify | Check the hub's answer first; it must be the bare DID, nothing else |

## 7. Worked example

The public test hub, 2026-11-23: two Bluesky accounts were made for the test
boards. Each was registered with its board on the hub (`hubctl set-did`, and
`hubctl add ... --did` for the second), and each switched its handle through
"No DNS panel", becoming `@test.hub.cyberspace.nexus` and
`@test2.hub.cyberspace.nexus`. Clearing the first board's account made the
hub answer 404 at once; setting it again restored it.
