// Input events as values (SPEC-TUI section 6).

import type { Key } from 'ink';
import type { Value } from '../types.ts';
import { int, list, str, sym } from '../values.ts';

const SPECIAL: ReadonlyArray<readonly [keyof Key, string]> = [
    ['upArrow', 'up'], ['downArrow', 'down'], ['leftArrow', 'left'], ['rightArrow', 'right'],
    ['return', 'return'], ['escape', 'escape'], ['tab', 'tab'], ['backspace', 'backspace'],
    ['delete', 'delete'], ['pageUp', 'pageup'], ['pageDown', 'pagedown'], ['home', 'home'], ['end', 'end'],
];

// `(key name modifiers)`, from what Ink's useInput reports. Null for input
// that names no key (e.g. a key release, or an empty paste).
export function keyEvent(input: string, key: Key): Value | null {
    if (key.eventType === 'release') return null;
    const special = SPECIAL.find(([field]) => key[field] === true);
    const name = special !== undefined ? sym(special[1]) : input.length > 0 ? str(input) : null;
    if (name === null) return null;
    const mods = [key.ctrl && 'ctrl', key.shift && 'shift', key.meta && 'meta']
        .filter((m): m is string => typeof m === 'string')
        .map((m) => sym(m));
    return list(sym('key'), name, list(...mods));
}

export const resizeEvent = (columns: number, rows: number): Value =>
    list(sym('resize'), int(columns), int(rows));

export const isCtrlC = (input: string, key: Key): boolean => key.ctrl && input === 'c';
