# Known Bugs

Bugs we know about and haven't fixed, with what is known, how to work
around them, and where the fix belongs. When one is fixed, move it to
**Fixed** at the bottom with the commit, and drop it a release later.

## Open

### In Chrome, typing stops working after using enig-term's "Open this link?" dialog

*Found 2026-11-25 (first as "the main menu is slow", then as "no keys after
signing in through another tab"); cause found 2026-11-26.* Where the fix
belongs: **enig-term**, ENiGMA½'s web terminal (by Bryan Ashby, BSD
2-Clause), which the hub serves as a pinned release (hub plan H5). Seen in
release 0.3.x as the hub serves it.

**What happens.** Signing in to a board with Bluesky in the web terminal and
clicking the approval link: enig-term asks "Open this link?", and you click
**Open link**. Back in the terminal, ENTER, arrows and the like still work,
so the screens after login go by, but **letters typed do nothing**, which
shows at the main menu.

**Cause.** enig-term reads typing through a hidden text box. Its link
dialog takes the keyboard focus while it is open; clicking either of its
buttons (Open link or Cancel) closes it and gives the focus back to the text
box. In Chrome the box then has the focus but no working caret: the browser
delivers key presses to it (so ENTER and arrows, which enig-term handles on
key-down, still go through), but inserts no text, so no `input` event comes
and letters are never sent. Closing the same dialog with ESC doesn't do it,
nor does Firefox. enig-term's own `focus()` can't repair it, because the box
already has the focus, so the call changes nothing; that is why clicking the
terminal doesn't help. **Live** and **Full screen** are buttons: clicking one
really moves the focus, and enig-term then gives it back to the box, which
repairs it.

**Reproduced** (2026-11-26) in Chromium (Playwright) with the hub's release,
on a scratch board on the dev VM: a link written to the screen, clicked,
then either dialog button: typing dead, the box's caret at 0, no `input`
events. ESC: typing fine. Background tabs, page freezing and the new tab
turned out to play no part.

**Fix** (verified in the same setup by patching the page): when enig-term
focuses its input, also put the caret back, with its own `resetCaret()`:

```js
focus() {
    this.textarea.focus({ preventScroll: true });
    this.resetCaret();   //  a box focused after a dialog can have a dead caret (Chrome)
}
```

With that, typing works after either dialog button. (Moving the focus away
and back, `blur()` then `focus()`, works too.)

**Workarounds:** sign in with the QR code (no dialog), close the dialog with
ESC after copying the link, or press **Live** or **Full screen** once
afterwards.

**Offered upstream** (2026-11-26):
[NuSkooler/enig-term#6](https://github.com/NuSkooler/enig-term/pull/6),
from `zerosquaredio/enig-term`'s `fix/caret-after-dialog`: the fix, a test
that fails in Chromium without it, and a CHANGELOG entry. Built with the
pinned engine (Rust on the dev VM), and the browser suite passes on
chromium, firefox and chromium-pixel7. When a release has it, the hub pins
that release and this moves to **Fixed**. The issue text as first drafted:

> **Typing stops working in Chrome after clicking a button in the "Open this
> link?" dialog**
>
> In Chrome, after clicking **Open link** or **Cancel** in the link dialog,
> the terminal's hidden textarea keeps the focus but its caret is dead:
> keydown events arrive (so Enter and arrows still work), but no text is
> inserted and no `input` event fires, so typed letters are never sent.
> Closing the dialog with ESC doesn't trigger it; Firefox isn't affected.
> `input.focus()` can't repair it because the textarea is already focused;
> clicking a toolbar button (Live, Full screen) does, since the focus really
> moves and comes back.
>
> Steps: in Chrome, show an OSC 8 link, click it, click Open link (or
> Cancel), type letters: nothing is sent. `textarea.selectionStart` is 0.
>
> Fix that works for us: call `resetCaret()` in the input's `focus()`, after
> `textarea.focus()`.

## Fixed

### The hub's cleaned ANSI doubled full-width rows in a BBS terminal

*Found and fixed 2026-11-27.* The hub wrote a line break after every row of
the ANSI it cleans, so a full 80-column row moved down twice in a BBS
terminal. It now leaves the break out after a row as wide as the art (80
columns or more), as ANSI art does; the clean check counts a wrapped line
as the rows it wraps to; and the chat's drawing wraps at the art's width
(from its SAUCE), so files written either way draw the same. Three tests.

*(none yet)*
