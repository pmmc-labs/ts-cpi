#!/usr/bin/env python3
# Drives examples/runner/run.sh on a real pseudo-terminal: for each engine,
# picks it in the menu, sets the size and pace, runs for a few seconds, reads
# the stats off the screen, and measures how long `q` takes to be answered.
#
#   python3 tools/drive_runner.py [size-steps] [seconds] [engine-index ...]
#
# size-steps is how many times to press right on the size field (2 is 64x32,
# 4 is 128x64). The menu's field order is assumed; update the key sequence in
# run_engine if the menu changes.
import fcntl, os, pty, re, select, struct, sys, termios, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07')
RIGHT, LEFT, DOWN = '\x1b[C', '\x1b[D', '\x1b[B'


def spawn(cols=200, rows=60):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ROOT)
        os.execvp('examples/runner/run.sh', ['examples/runner/run.sh'])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    return pid, fd


def read_for(fd, seconds, until=None):
    out, end = [], time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 65536).decode('utf8', 'replace')
            except OSError:
                break
            out.append(chunk)
            if until and until in ANSI.sub('', ''.join(out)):
                break
    return ANSI.sub('', ''.join(out))


def send(fd, keys, gap=0.03):
    for k in keys:
        os.write(fd, k.encode())
        time.sleep(gap)


# The run screen shows each value before its label, e.g. "50  ms the engine took ...".
def last_int(text, label):
    found = re.findall(r'(\d+)\s+' + re.escape(label), text)
    return int(found[-1]) if found else None


def run_engine(index, size_steps, seconds):
    pid, fd = spawn()
    read_for(fd, 3, until='enter run')
    send(fd, [RIGHT] * index + [DOWN] + [RIGHT] * size_steps + [DOWN, DOWN, DOWN, LEFT, LEFT, '\r'])
    screen = read_for(fd, seconds)
    t0 = time.time()
    send(fd, ['q'])
    after = read_for(fd, 30, until='stopped at generation')
    latency = time.time() - t0
    send(fd, ['q'])
    read_for(fd, 2)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    text = screen + after
    names = re.findall(r'^ ?(\S[^·\n]*?)  R-pentomino', text, re.M)
    return {
        'engine': names[-1].strip() if names else '?',
        'generation': last_int(screen, 'generation'),
        'engine ms': last_int(screen, 'ms the engine took'),
        'draw ms': last_int(screen, 'ms to draw'),
        'frame ms': last_int(screen, 'ms since the previous frame'),
        'q answered in ms': round(latency * 1000),
    }


if __name__ == '__main__':
    size_steps = int(sys.argv[1]) if len(sys.argv) > 1 else 2   # 2 = 64 x 32
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 4
    which = [int(a) for a in sys.argv[3:]] or list(range(11))
    for i in which:
        print(run_engine(i, size_steps, seconds), flush=True)
