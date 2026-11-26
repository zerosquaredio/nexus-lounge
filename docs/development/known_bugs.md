# Known Bugs

Bugs we know about and haven't fixed, with what is known, how to work
around them, and where the fix belongs. When one is fixed, move it to
**Fixed** at the bottom with the commit, and drop it a release later.

## Open

### In Chrome, the main menu takes no keys after signing in through another tab

*Found 2026-11-25 (first as "the main menu is slow"), narrowed down
2026-11-26.* Where the fix belongs: **enig-term**, ENiGMA½'s web terminal,
which the hub serves as a pinned release (hub plan H5).

**What happens.** Signing in to a board with Bluesky in the web terminal,
by opening the approval link in a new tab: after approving and coming back,
the board runs through its screens to the main menu, and then typing does
nothing. Letters typed then are lost, not just undrawn.

**What we know:**

- Only in **Chrome** (and so probably other Chromium browsers); not in
  Firefox.
- Only when the terminal's tab is **in the background** while the board
  sends its screens. Signing in with the **QR code** on a phone, the
  terminal tab staying in front, it doesn't happen.
- **Pressing Live** (enig-term's button that returns to the live screen,
  shown after scrolling up) brings typing back, and so does **full
  screen**. Clicking the terminal doesn't, and nor does scrolling back down
  by hand.
- It isn't the keyboard focus: a click puts the focus back in the terminal,
  and that doesn't help. It isn't the board: it is waiting at its menu.
- Chrome slows timers in background tabs sharply, and can freeze a tab
  outright, far more than Firefox. Places in enig-term that wait on a timer
  or an event and could be left stuck after that (from reading its code, not
  yet confirmed): output held while a font or sound loads, released on a
  timer or when the load ends; output held briefly while it checks for the
  start of a file transfer, released on a timer; and typing ignored while it
  thinks an input-method composition is in progress, until the matching
  browser event. None of these explains yet why Live, in particular,
  clears it.

**Workarounds:** sign in with the QR code, or press **Live** once at the
main menu (scroll up a little to show it), or go full screen and back.

**Next:** reproduce it on a scratch board on the dev VM (password login, so
no Bluesky step), freezing the terminal's tab with Chrome's own controls
(the DevTools protocol's page lifecycle) while the board sends its screens;
find which of the above it is; then offer the fix to enig-term (an issue or
a pull request, with the user's approval first).

## Fixed

*(none yet)*
