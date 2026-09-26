// The TUI backend for a real terminal (SPEC-TUI), drawn with Ink.
//
// Ink is a React renderer, but React stays inside this file: the CPI hands
// over a complete view each frame, and the only component with behavior is
// InputBridge, which turns key presses into events for the runtime.

import React from 'react';
import { render, Static, Text, useInput, type Instance, type Key } from 'ink';
import type { Value } from '../types.ts';
import type { TuiBackend, TuiMode } from './backend.ts';
import { isCtrlC, keyEvent, resizeEvent } from './events.ts';

type Streams = { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream };

export class TerminalTui implements TuiBackend {
    private readonly stdout: NodeJS.WriteStream;
    private readonly stdin: NodeJS.ReadStream;
    private instance: Instance | null = null;
    private view: React.ReactElement | null = null;
    private lines: string[] = [];
    private subscribed = false;
    private onInput: (event: Value) => void = () => {};
    private readonly onResize = () => {
        if (this.subscribed) this.onInput(resizeEvent(...this.size()));
    };

    constructor(streams: Streams = { stdout: process.stdout, stdin: process.stdin }) {
        this.stdout = streams.stdout;
        this.stdin = streams.stdin;
    }

    async open(mode: TuiMode, onInput: (event: Value) => void): Promise<void> {
        this.onInput = onInput;
        this.instance = render(this.root(), {
            stdout: this.stdout,
            stdin: this.stdin,
            exitOnCtrlC: false,
            patchConsole: false,
            alternateScreen: mode === 'fullscreen',
        });
        this.stdout.on('resize', this.onResize);
        await this.instance.waitUntilRenderFlush();
    }

    async render(view: React.ReactElement): Promise<void> {
        this.view = view;
        await this.redraw();
    }

    // Shown above the view by Ink's Static region, when the next frame is
    // drawn: at the latest by the next render, host::wait or close.
    print(line: string): void {
        this.lines = [...this.lines, line];
        this.instance?.rerender(this.root());
    }

    size(): readonly [number, number] {
        return [this.stdout.columns ?? 80, this.stdout.rows ?? 24];
    }

    canSubscribe(): boolean {
        return this.stdin.isTTY === true;
    }

    setSubscribed(subscribed: boolean): void {
        this.subscribed = subscribed;
        this.instance?.rerender(this.root());
    }

    async close(): Promise<void> {
        if (this.instance === null) return;
        const instance = this.instance;
        this.instance = null;
        this.stdout.off('resize', this.onResize);
        instance.unmount();
        await instance.waitUntilExit();
    }

    private async redraw(): Promise<void> {
        if (this.instance === null) return;
        this.instance.rerender(this.root());
        await this.instance.waitUntilRenderFlush();
    }

    private root(): React.ReactElement {
        return React.createElement(React.Fragment, null,
            React.createElement(Static<string>, {
                items: this.lines,
                children: (line: string, i: number) => React.createElement(Text, { key: i }, line),
            }),
            this.canSubscribe()
                ? React.createElement(InputBridge, { onKey: (input: string, key: Key) => this.key(input, key) })
                : null,
            this.view);
    }

    private key(input: string, key: Key): void {
        if (!this.subscribed) {
            // Without a subscription, Ctrl-C ends the image (section 6).
            if (isCtrlC(input, key)) void this.close().then(() => process.exit(130));
            return;
        }
        const event = keyEvent(input, key);
        if (event !== null) this.onInput(event);
    }
}

// The one component with behavior: it forwards key presses.
function InputBridge(props: { onKey: (input: string, key: Key) => void }): null {
    useInput(props.onKey);
    return null;
}
