/**
 * Pure helpers for the Superserve provider: shell quoting, key normalization,
 * PNG header parsing, and xdotool output parsing. No I/O.
 */
import { SandboxError } from '@mastra/core/workspace';

/**
 * Quote one argument for a POSIX shell. Same rule as Mastra core's built-in
 * `executeCommand`: safe characters pass through, everything else is wrapped
 * in single quotes with embedded single quotes escaped.
 */
export function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9._\-/=:@]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function invalidArgument(message: string, details?: Record<string, unknown>): SandboxError {
  return new SandboxError(message, 'INVALID_ARGUMENT', details);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Modifier aliases → the modifier names the Superserve SDK sends on the wire
 * (`ctrl`, `alt`, `shift`, `super`).
 */
const MODIFIERS: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'super',
  cmd: 'super',
  command: 'super',
  meta: 'super',
  win: 'super',
  windows: 'super',
};

/** A modifier pressed on its own (as the final key) is sent as its left-hand keysym. */
const MODIFIER_KEYSYMS: Record<string, string> = {
  ctrl: 'Control_L',
  alt: 'Alt_L',
  shift: 'Shift_L',
  super: 'Super_L',
};

/**
 * Common key names (DOM-style, abbreviations, punctuation) → X keysyms.
 * The SDK maps a few friendly names itself but passes anything unknown through
 * verbatim, so names like `ArrowUp`, `PgDn`, `Del` or `/` would reach X as
 * invalid keysyms. Normalizing here keeps the wire value a real keysym.
 */
const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  spacebar: 'space',
  ' ': 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Page_Up',
  page_up: 'Page_Up',
  pgup: 'Page_Up',
  pagedown: 'Page_Down',
  page_down: 'Page_Down',
  pgdn: 'Page_Down',
  capslock: 'Caps_Lock',
  printscreen: 'Print',
  print: 'Print',
  menu: 'Menu',
  contextmenu: 'Menu',
  '+': 'plus',
  '-': 'minus',
  '=': 'equal',
  '/': 'slash',
  '\\': 'backslash',
  '.': 'period',
  ',': 'comma',
  ';': 'semicolon',
  "'": 'apostrophe',
  '`': 'grave',
  '[': 'bracketleft',
  ']': 'bracketright',
};

/** X keysym names are identifiers: letters, digits, underscore. */
const KEYSYM_NAME = /^[A-Za-z0-9_]+$/;

function splitChordString(key: string): string[] {
  if (key === '+') return ['+'];
  // "ctrl++" → ["ctrl", "+"]
  if (key.length > 2 && key.endsWith('++')) return [...key.slice(0, -2).split('+'), '+'];
  return key.split('+');
}

function toFinalKeysym(raw: string, hasModifiers: boolean): string {
  const lower = raw.toLowerCase();
  const modifier = MODIFIERS[lower];
  if (modifier) return MODIFIER_KEYSYMS[modifier]!;
  const alias = KEY_ALIASES[lower] ?? KEY_ALIASES[raw];
  if (alias) return alias;
  const fn = /^f([1-9]|[12][0-9]|3[0-5])$/i.exec(raw); // X defines F1–F35
  if (fn) return `F${fn[1]}`;
  // In a chord, ["ctrl", "C"] means ctrl+c, not ctrl+shift+c.
  if (raw.length === 1 && /[A-Za-z]/.test(raw)) return hasModifiers ? lower : raw;
  if (raw.length === 1 && /[0-9]/.test(raw)) return raw;
  if (KEYSYM_NAME.test(raw)) return raw;
  throw invalidArgument(
    `Unsupported key "${raw}". Use a key name such as "Enter", "Tab", "ArrowUp", "F5", a single letter/digit, or an X keysym name.`,
    { key: raw },
  );
}

/**
 * Normalize a Mastra `press()` argument into the `[...modifiers, key]` array
 * the Superserve SDK sends. Accepts a single key (`"Enter"`), a `+`-joined
 * chord string (`"ctrl+shift+t"`), or an array chord (`["ctrl", "s"]`).
 *
 * @throws {SandboxError} `INVALID_ARGUMENT` for empty keys, unknown modifiers,
 *   or names that cannot be an X keysym.
 */
export function normalizeKey(key: string | string[]): string[] {
  const parts = Array.isArray(key) ? key : typeof key === 'string' ? splitChordString(key) : null;
  if (!parts || parts.length === 0) throw invalidArgument('press: key must be a non-empty string or array');
  const trimmed = parts.map((p) => {
    if (typeof p !== 'string') throw invalidArgument('press: every key must be a string');
    // A literal space is a key; otherwise surrounding whitespace is noise.
    const t = p === ' ' ? p : p.trim();
    if (t === '') throw invalidArgument(`press: empty key in ${JSON.stringify(key)}`);
    return t;
  });

  const modifiers = trimmed.slice(0, -1).map((m) => {
    const mapped = MODIFIERS[m.toLowerCase()];
    if (!mapped) {
      throw invalidArgument(
        `press: "${m}" is not a modifier. In a chord every key but the last must be ctrl, alt, shift or super (cmd/meta/win).`,
        { key },
      );
    }
    return mapped;
  });
  const final = toFinalKeysym(trimmed[trimmed.length - 1]!, modifiers.length > 0);
  return [...modifiers, final];
}

// ---------------------------------------------------------------------------
// Coordinates & scroll
// ---------------------------------------------------------------------------

export function assertCoordinate(x: unknown, y: unknown, label = 'coordinates'): asserts x is number {
  const ok = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!ok(x) || !ok(y)) {
    throw invalidArgument(`Invalid ${label} (${String(x)}, ${String(y)}): must be integers >= 0`, { x, y });
  }
}

export function assertScroll(direction: unknown, amount: unknown): void {
  if (direction !== 'up' && direction !== 'down') {
    throw invalidArgument(`Invalid scroll direction "${String(direction)}": must be "up" or "down"`);
  }
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
    throw invalidArgument(`Invalid scroll amount ${String(amount)}: must be a positive integer number of ticks`);
  }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Read width/height from a PNG's IHDR chunk, or null if the bytes are not a PNG. */
export function pngSize(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 24 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) return null;
  // IHDR must be the first chunk: length(4) "IHDR"(4) width(4) height(4)
  if (String.fromCharCode(buf[12]!, buf[13]!, buf[14]!, buf[15]!) !== 'IHDR') return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = dv.getUint32(16);
  const height = dv.getUint32(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

// ---------------------------------------------------------------------------
// xdotool
// ---------------------------------------------------------------------------

/** Command used for the cursor query (verified live in Phase 1, tests B1/B2/D4). */
export const CURSOR_QUERY_COMMAND = 'xdotool getmouselocation --shell';

/**
 * Parse `xdotool getmouselocation --shell` output (`X=…\nY=…\nSCREEN=…\nWINDOW=…`).
 * Returns null unless both X and Y are present as non-negative integers.
 */
export function parseMouseLocation(stdout: string): { x: number; y: number } | null {
  const vars: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) vars[m[1]!] = m[2]!;
  }
  const { X: xs, Y: ys } = vars;
  if (xs === undefined || ys === undefined || !/^\d+$/.test(xs) || !/^\d+$/.test(ys)) return null;
  return { x: Number(xs), y: Number(ys) };
}
