//  Views (assets spec §3.6): how a person sees the hub. A view is data, not
//  CSS: colours for the slots the hub's pages are built on, which fonts to
//  use, how art is drawn (pictures, ANSI or text), and optionally colours
//  for ANSI art. The hub builds the CSS from those values, so a view can
//  restyle a page but never hide, move or fake anything on it, and checks
//  that its text can be read (WCAG's contrast ratio).
//
//  For now the views are the hub's own; later leaves publish theirs as
//  assets, and the menu lists them all, each credited.

import { VgaFontPath } from './art_html.ts';
import { esc } from './html.ts';

export type ArtForm = 'pictures' | 'ansi' | 'text';

export interface ViewColours {
    bg: string;
    fg: string;
    dim: string;
    line: string;
    accent: string;
    warn: string;
}

export interface View {
    id: string;
    name: string;
    //  who made it
    credit: string;
    //  null: the hub's own colours, light or dark as the device prefers
    colours: ViewColours | null;
    fonts: { body?: 'vga'; heading?: 'vga' };
    art: ArtForm;
    //  the 16 ANSI colours, in ANSI order, for art drawn as characters:
    //  recoloured as it's drawn, in the viewer's browser, never copied
    ansi?: string[];
}

export const ViewCookie = 'hub_view';
export const ViewPath = '/view';
//  the least contrast text may have against its background (WCAG AA)
export const MinContrast = 4.5;

export const Views: View[] = [
    {
        id: 'hub',
        name: 'Hub',
        credit: 'the hub',
        colours: null,
        fonts: {},
        art: 'pictures',
    },
    {
        id: 'bbs',
        name: 'BBS',
        credit: 'the hub',
        colours: {
            bg: '#000000',
            fg: '#aaaaaa',
            dim: '#8a8a8a',
            line: '#555555',
            accent: '#55ffff',
            warn: '#ffff55',
        },
        fonts: { body: 'vga', heading: 'vga' },
        art: 'ansi',
    },
    {
        id: 'pink',
        name: 'Pink and white',
        credit: 'the hub',
        colours: {
            bg: '#fff5f9',
            fg: '#3d1030',
            dim: '#7a3d66',
            line: '#f0c2d8',
            accent: '#c2185b',
            warn: '#8a3b00',
        },
        fonts: { heading: 'vga' },
        art: 'ansi',
        //  dark on light: black becomes the page's white, white the deepest plum
        ansi: [
            '#fff5f9',
            '#c2185b',
            '#f06292',
            '#d81b60',
            '#f8bbd0',
            '#ad1457',
            '#f48fb1',
            '#880e4f',
            '#fce4ec',
            '#e91e63',
            '#ec407a',
            '#ff80ab',
            '#f8bbd0',
            '#d81b60',
            '#f06292',
            '#4a0e2e',
        ],
    },
];

export function viewById(id: string | undefined): View {
    return Views.find(v => v.id === id) ?? Views[0]!;
}

function luminance(hex: string): number {
    const channel = (at: number) => {
        const v = parseInt(hex.slice(at, at + 2), 16) / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

//  WCAG's contrast ratio between two colours, 1 to 21
export function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
    return (x + 0.05) / (y + 0.05);
}

const HexRe = /^#[0-9a-f]{6}$/;

//  What's wrong with a view, if anything: colours that aren't colours, or
//  text that can't be read against the background
export function viewProblems(view: View): string[] {
    const problems: string[] = [];
    if (view.colours) {
        for (const [slot, value] of Object.entries(view.colours)) {
            if (!HexRe.test(value)) {
                problems.push(`${slot} isn't a colour like #1a2b3c`);
            }
        }
        for (const slot of ['fg', 'dim', 'accent', 'warn'] as const) {
            const ratio = contrast(view.colours[slot], view.colours.bg);
            if (ratio < MinContrast) {
                problems.push(
                    `${slot} on the background has a contrast of ${ratio.toFixed(1)}, under ${MinContrast}`
                );
            }
        }
    }
    if (view.ansi && (16 !== view.ansi.length || !view.ansi.every(c => HexRe.test(c)))) {
        problems.push('ANSI colours must be 16 colours like #1a2b3c');
    }
    return problems;
}

//  The CSS a view makes. It comes after the hub's own, and sets only the
//  colour slots, fonts and ANSI colours: nothing that moves or hides
export function viewCss(view: View): string {
    const parts: string[] = [];
    if (view.fonts.body || view.fonts.heading) {
        parts.push(
            `@font-face { font-family: "Hub VGA"; src: url("${VgaFontPath}") format("woff"); font-display: swap; }`
        );
    }
    if (view.colours) {
        const c = view.colours;
        parts.push(
            `:root { color-scheme: ${luminance(c.bg) < 0.2 ? 'dark' : 'light'}; --bg: ${c.bg}; --fg: ${c.fg}; --dim: ${c.dim}; --line: ${c.line}; --accent: ${c.accent}; --warn: ${c.warn}; }`
        );
    }
    if ('vga' === view.fonts.body) {
        parts.push(
            'body, input, textarea, button, select { font-family: "Hub VGA", ui-monospace, monospace; font-size: 16px; }'
        );
    }
    if ('vga' === view.fonts.heading) {
        parts.push('h1, h2, h3 { font-family: "Hub VGA", ui-monospace, monospace; font-weight: normal; }');
        parts.push(
            'h1 { font-size: 32px; line-height: 1.2; } h2 { font-size: 24px; } h3 { font-size: 16px; }'
        );
    }
    const ansi = view.ansi;
    if (ansi) {
        parts.push(
            ansi
                .map(
                    (hex, i) =>
                        `html[data-view] .ansi .f${i} { color: ${hex}; } html[data-view] .ansi .b${i} { background: ${hex}; }`
                )
                .join('\n')
        );
        parts.push(`html[data-view] pre.ansi { background: ${ansi[0]}; }`);
    }
    return parts.join('\n');
}

//  The menu in each page's header. A form, so it works without scripts
export function viewPicker(current: View, back: string, action = ViewPath): string {
    const options = Views.map(
        v => `<option value="${esc(v.id)}"${v.id === current.id ? ' selected' : ''}>${esc(v.name)}</option>`
    ).join('');
    return `<form class="inline view-pick" method="post" action="${esc(action)}"><input type="hidden" name="back" value="${esc(
        back
    )}"><label for="view-pick">View</label> <select id="view-pick" name="view">${options}</select> <button>Use</button></form>`;
}
