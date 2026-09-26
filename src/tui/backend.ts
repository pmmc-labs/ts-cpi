// The host side of `tui::` (SPEC-TUI): what the runtime needs from a
// terminal. Two backends implement it: terminal.ts draws with Ink, and
// headless.ts renders to text for tests.

import type { ReactElement } from 'react';
import type { Value } from '../types.ts';

export type TuiMode = 'inline' | 'fullscreen';

export interface TuiBackend {
    // Takes over the terminal. `onInput` receives input events as values,
    // `(key name modifiers)` or `(resize columns rows)`, at any time the
    // host has control; the runtime holds them until `host::wait`.
    open(mode: TuiMode, onInput: (event: Value) => void): Promise<void>;
    // Resolves once `view` is on screen (SPEC-TUI section 5).
    render(view: ReactElement): Promise<void>;
    // A line of `IO::print` output, shown above the view (inline mode).
    print(line: string): void;
    size(): readonly [number, number];
    // Whether input can be read (it is a terminal).
    canSubscribe(): boolean;
    // Whether the CPI is subscribed; decides what Ctrl-C does (section 6).
    setSubscribed(subscribed: boolean): void;
    // Restores the terminal. Safe to call more than once.
    close(): Promise<void>;
    // Test backends only: the next scripted input event, or null. The
    // virtual clock asks for one when `host::wait` would otherwise idle.
    nextScripted?(): Value | null;
}
