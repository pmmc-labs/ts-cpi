#!/usr/bin/env python3
# Runs a command on a real pseudo-terminal until it exits, reading (and
# discarding) what it draws, so a TUI program can run unattended. Optionally
# presses keys once it has started, and saves the last screenful of output.
#
#   python3 tools/pty_run.py [--cols 160] [--rows 40] [--keys ff] [--after 2]
#                            [--screen FILE] [--frame-start TEXT] -- command [args ...]
#
# --keys are sent one at a time, --after seconds after the start. --screen
# writes, without escape sequences, the output from the last place TEXT
# begins a frame (by default the top-left corner of a rounded border, "╭"):
# the last frame drawn, and whatever the program printed after it.
import argparse, codecs, fcntl, os, pty, re, select, struct, sys, termios, time

ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cols', type=int, default=160)
    ap.add_argument('--rows', type=int, default=40)
    ap.add_argument('--keys', default='')
    ap.add_argument('--after', type=float, default=2.0)
    ap.add_argument('--screen')
    ap.add_argument('--frame-start', default='\u256d')
    ap.add_argument('command', nargs=argparse.REMAINDER)
    args = ap.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(command[0], command)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.cols, 0, 0))

    started, keys, tail = time.time(), list(args.keys), ''
    # A character can be split between two reads.
    decoder = codecs.getincrementaldecoder('utf8')('replace')
    while True:
        if keys and time.time() - started >= args.after:
            os.write(fd, keys.pop(0).encode())
            time.sleep(0.1)
        r, _, _ = select.select([fd], [], [], 0.05)
        if not r:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        chunk = decoder.decode(data)
        tail = (tail + chunk)[-200000:]
    _, status = os.waitpid(pid, 0)
    if args.screen:
        plain = ANSI.sub('', tail)
        cut = plain.rfind(args.frame_start)
        with open(args.screen, 'w') as f:
            f.write(plain[cut:] if cut >= 0 else plain)
    sys.exit(os.waitstatus_to_exitcode(status))


if __name__ == '__main__':
    main()
