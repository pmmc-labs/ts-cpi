// A TUI backend for tests (SPEC-TUI section 11): every view is rendered to
// text with Ink's renderToString and recorded, and input comes from a
// script. Selected only through the Runtime constructor.

import type { ReactElement } from 'react';
import { renderToString } from 'ink';
import type { Value } from '../types.ts';
import type { TuiBackend, TuiMode } from './backend.ts';

export class HeadlessTui implements TuiBackend {
    readonly frames: string[] = [];
    readonly lines: string[] = [];
    mode: TuiMode | null = null;
    closed = false;
    private readonly columns: number;
    private readonly rows: number;
    private readonly script: Value[];

    constructor(opts: { columns?: number; rows?: number; input?: Value[] } = {}) {
        this.columns = opts.columns ?? 80;
        this.rows = opts.rows ?? 24;
        this.script = [...(opts.input ?? [])];
    }

    async open(mode: TuiMode): Promise<void> {
        this.mode = mode;
    }

    async render(view: ReactElement): Promise<void> {
        this.frames.push(renderToString(view, { columns: this.columns }));
    }

    print(line: string): void {
        this.lines.push(line);
    }

    size(): readonly [number, number] {
        return [this.columns, this.rows];
    }

    canSubscribe(): boolean {
        return true;
    }

    setSubscribed(): void {}

    async close(): Promise<void> {
        this.closed = true;
    }

    nextScripted(): Value | null {
        return this.script.shift() ?? null;
    }
}
