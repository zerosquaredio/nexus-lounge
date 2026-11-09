//  The hub site's HTML: small, plain, and escaped everywhere

export function esc(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const Style = `
:root { color-scheme: light dark; --bg: #f6f6f2; --fg: #1b1b1b; --dim: #666; --line: #ccc; --accent: #0a6b5a; --warn: #8a3b00; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f1214; --fg: #e4e4dc; --dim: #9a9a92; --line: #333; --accent: #4fd1b0; --warn: #ffb070; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
h1, h2 { font-family: ui-monospace, Consolas, monospace; letter-spacing: .02em; }
h1 { font-size: 1.4rem; color: var(--accent); }
h2 { font-size: 1.1rem; margin-top: 2rem; }
a { color: var(--accent); }
label { display: block; margin: .8rem 0 .2rem; }
input[type=text], textarea { width: 100%; padding: .5rem; font: inherit; background: transparent; color: inherit; border: 1px solid var(--line); border-radius: 4px; }
textarea { font: 13px/1.4 ui-monospace, Consolas, monospace; }
button { margin-top: 1rem; padding: .5rem 1rem; font: inherit; border: 1px solid var(--accent); border-radius: 4px; background: transparent; color: var(--accent); cursor: pointer; }
.hint, .dim { color: var(--dim); font-size: .9rem; }
.error { color: var(--warn); }
.warn { border-left: 3px solid var(--warn); padding: .2rem .8rem; }
table { width: 100%; border-collapse: collapse; }
td, th { text-align: left; padding: .4rem .3rem; border-bottom: 1px solid var(--line); vertical-align: top; }
form.inline { display: inline; }
form.inline button { margin: 0 .3rem 0 0; padding: .2rem .6rem; font-size: .9rem; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
`;

export function page(title: string, body: string, signedIn?: { handle: string | null; did: string }): string {
    const who = signedIn
        ? `<form class="inline" method="post" action="/signout"><span class="dim">${esc(
              signedIn.handle ? `@${signedIn.handle}` : signedIn.did
          )}</span> <button>Sign out</button></form>`
        : '';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${Style}</style>
</head>
<body><main>
<header><h1>${esc(title)}</h1>${who}</header>
${body}
</main></body>
</html>
`;
}
