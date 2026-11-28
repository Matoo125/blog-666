/*
 * tmux lab: a small tmux (and byobu) simulator with guided exercises.
 *
 * Nothing here runs a real shell. TmuxSim models sessions, windows and panes
 * and answers the same keys and commands tmux does. The second half of the
 * file draws it and tracks the exercises embedded in the article.
 */

const PROMPT = 'you@lab:~$ ';
const MAX_LINES = 2000;
const LAYOUTS = ['even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical', 'tiled'];
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'OS'];
const ARROWS = { ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D' };

const FILES = {
  'notes.txt': [
    'tmux in one breath:',
    '  a server holds sessions, a session holds windows,',
    '  a window holds panes, and every pane runs a shell.',
    '',
    'Detach with Ctrl+b d. Everything keeps running.',
    'Come back with: tmux attach',
  ],
  'server.log': Array.from({ length: 60 }, (_, i) => {
    const s = String(i % 60).padStart(2, '0');
    const what = ['GET /api/health 200', 'GET /posts 200', 'POST /login 302', 'GET /favicon.ico 404', 'worker heartbeat ok'][i % 5];
    return `2026-11-28T09:14:${s}Z ${what}`;
  }),
};

const TMUX_KEYS_HELP = [
  'C-b ?        List key bindings (this screen, q to close)',
  'C-b d        Detach from the session',
  'C-b $        Rename the session',
  'C-b s        Choose a session from a list',
  'C-b ( )      Previous / next session',
  'C-b c        Create a new window',
  'C-b ,        Rename the window',
  'C-b n p      Next / previous window',
  'C-b l        Last used window',
  'C-b 0..9     Select window by number',
  'C-b w        Choose a window from a list',
  'C-b f        Find a window by name',
  'C-b &        Kill the window',
  'C-b %        Split left/right',
  'C-b "        Split top/bottom',
  'C-b Arrow    Select the pane in that direction',
  'C-b o        Next pane',
  'C-b ;        Last used pane',
  'C-b q        Show pane numbers',
  'C-b z        Zoom the pane',
  'C-b C-Arrow  Resize the pane by 1',
  'C-b M-Arrow  Resize the pane by 5',
  'C-b Space    Next layout',
  'C-b !        Break the pane into a window',
  'C-b x        Kill the pane',
  'C-b [        Enter copy mode',
  'C-b ]        Paste the most recent buffer',
  'C-b :        Command prompt',
];

const BYOBU_KEYS_HELP = [
  'F2             New window',
  'Shift-F2       Split top/bottom',
  'Ctrl-F2        Split left/right',
  'Ctrl-Shift-F2  New session',
  'F3 / F4        Previous / next window',
  'Alt-Left/Right Previous / next window',
  'Shift-F3 / F4  Previous / next split',
  'Shift-Arrow    Move focus between splits',
  'Shift-Alt-Arrow Resize the split',
  'Alt-Up / Down  Previous / next session',
  'F6             Detach',
  'Ctrl-F6        Kill the focused split',
  'F7             Scrollback (copy mode)',
  'F8             Rename the window',
  'Ctrl-F8        Rename the session',
  'Shift-F8       Next split layout',
  'Shift-F11      Zoom the split',
  'Shift-F1       This help (q to close)',
  'Ctrl-a         Prefix key, then any tmux key',
];

function wrap(s, w) {
  if (s.length <= w) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w));
  return out;
}

function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

class Pane {
  constructor() {
    this.lines = [];
    this.input = '';
    this.cur = 0;
    this.hist = [];
    this.hi = -1;
    this.copy = null;
    this.rect = null;
    this.node = null;
    this.proc = null;
    this.seen = 0;
  }

  print(text) {
    for (const l of String(text).split('\n')) this.lines.push(l);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
  }
}

export class TmuxSim {
  constructor({ cols = 80, rows = 24, onEvent = () => {}, onChange = () => {} } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.onEvent = onEvent;
    this.onChange = onChange;
    this.timers = new Set();
    this.reset('outer');
  }

  /* ---------- lifecycle ---------- */

  reset(setup = 'outer') {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.sessions) for (const s of this.sessions) this.stopSession(s);
    if (this.outer) this.stopProc(this.outer);
    this.sessions = [];
    this.nextSessionName = 0;
    this.tick = 0;
    this.attached = null;
    this.buffer = '';
    this.outer = new Pane();
    this.outer.print('A simulated shell. Type tmux to start, or help to see what works here.');
    this.clearModes();
    if (setup === 'session') {
      this.attached = this.createSession('practice', false);
    }
  }

  clearModes() {
    this.prefix = false;
    this.prompt = null;
    this.overlay = null;
    this.message = null;
    this.showNumbers = false;
    this.repeatUntil = 0;
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
  }

  emit(type, data = {}) {
    this.onEvent({ type, ...data });
  }

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
      this.onChange();
    }, ms);
    this.timers.add(t);
    return t;
  }

  say(text) {
    this.message = text;
    const mine = text;
    this.later(() => {
      if (this.message === mine) this.message = null;
    }, 2500);
  }

  /* ---------- model ---------- */

  createSession(name, byobu) {
    if (name == null) {
      do name = String(this.nextSessionName++);
      while (this.sessions.some((s) => s.name === name));
    }
    const sess = { name, windows: [], cur: null, last: null, byobu: !!byobu, created: new Date() };
    this.sessions.push(sess);
    this.createWindow(sess);
    return sess;
  }

  createWindow(sess, name, pane) {
    let index = 0;
    while (sess.windows.some((w) => w.index === index)) index++;
    const p = pane || new Pane();
    const win = { index, name: name || 'bash', root: null, active: p, lastPane: null, zoomed: false, layoutIdx: -1 };
    win.root = { type: 'leaf', pane: p, parent: null };
    p.node = win.root;
    p.seen = ++this.tick;
    sess.windows.push(win);
    sess.windows.sort((a, b) => a.index - b.index);
    if (sess.cur) sess.last = sess.cur;
    sess.cur = win;
    return win;
  }

  panes(win) {
    const out = [];
    const walk = (n) => {
      if (n.type === 'leaf') out.push(n.pane);
      else {
        walk(n.a);
        walk(n.b);
      }
    };
    walk(win.root);
    return out;
  }

  layout(win) {
    const W = this.cols;
    const H = this.rows - 1;
    const seps = [];
    const all = this.panes(win);
    if (win.zoomed) {
      for (const p of all) p.rect = null;
      win.active.rect = { x: 0, y: 0, w: W, h: H };
      return seps;
    }
    const walk = (n, x, y, w, h) => {
      n.rect = { x, y, w, h };
      if (n.type === 'leaf') {
        n.pane.rect = n.rect;
        return;
      }
      if (n.dir === 'h') {
        const total = w - 1;
        const wa = clamp(Math.round(n.ratio * total), 1, Math.max(1, total - 1));
        walk(n.a, x, y, wa, h);
        seps.push({ dir: 'h', x: x + wa, y, len: h });
        walk(n.b, x + wa + 1, y, total - wa, h);
      } else {
        const total = h - 1;
        const ha = clamp(Math.round(n.ratio * total), 1, Math.max(1, total - 1));
        walk(n.a, x, y, w, ha);
        seps.push({ dir: 'v', x, y: y + ha, len: w });
        walk(n.b, x, y + ha + 1, w, total - ha);
      }
    };
    walk(win.root, 0, 0, W, H);
    return seps;
  }

  setActive(win, pane) {
    if (pane !== win.active) {
      win.lastPane = win.active;
      win.active = pane;
    }
    pane.seen = ++this.tick;
  }

  /* Put `pane` next to `target`. Returns false when there is no room. */
  splitWith(win, target, dir, pane) {
    win.zoomed = false;
    this.layout(win);
    const r = target.rect;
    if ((dir === 'h' && r.w < 5) || (dir === 'v' && r.h < 3)) return false;
    const leaf = target.node;
    const fresh = { type: 'leaf', pane, parent: null };
    pane.node = fresh;
    const split = { type: 'split', dir, a: leaf, b: fresh, ratio: 0.5, parent: leaf.parent };
    if (!leaf.parent) win.root = split;
    else if (leaf.parent.a === leaf) leaf.parent.a = split;
    else leaf.parent.b = split;
    leaf.parent = split;
    fresh.parent = split;
    this.setActive(win, pane);
    return true;
  }

  /* Take a pane out of its window's tree. Returns true if the window is now empty. */
  unlink(win, pane) {
    win.zoomed = false;
    const leaf = pane.node;
    const parent = leaf.parent;
    if (!parent) return true;
    const sibling = parent.a === leaf ? parent.b : parent.a;
    sibling.parent = parent.parent;
    if (!parent.parent) win.root = sibling;
    else if (parent.parent.a === parent) parent.parent.a = sibling;
    else parent.parent.b = sibling;
    if (win.lastPane === pane) win.lastPane = null;
    if (win.active === pane) {
      const rest = this.panes(win);
      win.active = win.lastPane && rest.includes(win.lastPane) ? win.lastPane : rest.sort((a, b) => b.seen - a.seen)[0];
      win.lastPane = null;
    }
    pane.node = null;
    return false;
  }

  stopProc(pane) {
    if (pane.proc) {
      clearInterval(pane.proc.timer);
      pane.proc = null;
    }
  }

  stopSession(sess) {
    for (const w of sess.windows) for (const p of this.panes(w)) this.stopProc(p);
  }

  sessionOf(win) {
    return this.sessions.find((s) => s.windows.includes(win));
  }

  windowOf(pane) {
    for (const s of this.sessions) for (const w of s.windows) if (this.panes(w).includes(pane)) return w;
    return null;
  }

  killPane(pane) {
    const win = this.windowOf(pane);
    if (!win) return;
    this.stopProc(pane);
    if (this.unlink(win, pane)) this.removeWindow(win);
    this.emit('kill-pane');
  }

  removeWindow(win) {
    const sess = this.sessionOf(win);
    for (const p of this.panes(win)) this.stopProc(p);
    sess.windows = sess.windows.filter((w) => w !== win);
    if (sess.last === win) sess.last = null;
    if (!sess.windows.length) {
      this.destroySession(sess);
      return;
    }
    if (sess.cur === win) {
      sess.cur = sess.last || sess.windows.find((w) => w.index > win.index) || sess.windows[sess.windows.length - 1];
      sess.last = null;
    }
  }

  killWindow(win) {
    this.removeWindow(win);
    this.emit('kill-window');
  }

  destroySession(sess) {
    this.stopSession(sess);
    this.sessions = this.sessions.filter((s) => s !== sess);
    if (this.attached === sess) {
      this.attached = null;
      this.clearModes();
      this.outer.print('[exited]');
    }
    this.emit('kill-session', { name: sess.name });
  }

  attach(sess) {
    this.attached = sess;
    this.clearModes();
    this.emit('attach', { name: sess.name });
  }

  detach() {
    const sess = this.attached;
    if (!sess) return;
    this.attached = null;
    this.clearModes();
    this.outer.print(`[detached (from session ${sess.name})]`);
    this.emit('detach', { name: sess.name });
  }

  selectWindow(sess, win, how) {
    if (win !== sess.cur) {
      sess.last = sess.cur;
      sess.cur = win;
    }
    this.emit('select-window', { how, index: win.index });
  }

  stepWindow(sess, delta, how) {
    const i = sess.windows.indexOf(sess.cur);
    const n = sess.windows.length;
    this.selectWindow(sess, sess.windows[(i + delta + n) % n], how);
  }

  stepSession(delta) {
    const i = this.sessions.indexOf(this.attached);
    const n = this.sessions.length;
    this.attached = this.sessions[(i + delta + n) % n];
    this.emit('switch-session', { name: this.attached.name });
  }

  newWindow(sess, name) {
    const win = this.createWindow(sess, name);
    this.emit('new-window', { index: win.index });
    return win;
  }

  split(win, dir) {
    if (!this.splitWith(win, win.active, dir, new Pane())) {
      this.say('no space for new pane');
      return;
    }
    this.emit('split', { dir });
  }

  neighbor(win, pane, d) {
    this.layout(win);
    const a = pane.rect;
    const W = this.cols;
    const H = this.rows - 1;
    const others = this.panes(win).filter((p) => p !== pane);
    const ov = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1) > 0;
    const rows = (p) => ov(a.y, a.y + a.h, p.rect.y, p.rect.y + p.rect.h);
    const cols = (p) => ov(a.x, a.x + a.w, p.rect.x, p.rect.x + p.rect.w);
    const tests = {
      R: [(p) => p.rect.x === a.x + a.w + 1 && rows(p), (p) => p.rect.x === 0 && rows(p)],
      L: [(p) => p.rect.x + p.rect.w + 1 === a.x && rows(p), (p) => p.rect.x + p.rect.w === W && rows(p)],
      D: [(p) => p.rect.y === a.y + a.h + 1 && cols(p), (p) => p.rect.y === 0 && cols(p)],
      U: [(p) => p.rect.y + p.rect.h + 1 === a.y && cols(p), (p) => p.rect.y + p.rect.h === H && cols(p)],
    }[d];
    for (const t of tests) {
      const found = others.filter(t).sort((p, q) => q.seen - p.seen);
      if (found.length) return found[0];
    }
    return null;
  }

  selectPaneDir(win, d) {
    win.zoomed = false;
    const next = this.neighbor(win, win.active, d);
    if (!next) return;
    this.setActive(win, next);
    this.emit('select-pane', { how: 'dir' });
  }

  cyclePane(win, delta) {
    const all = this.panes(win);
    if (all.length < 2) return;
    win.zoomed = false;
    const i = all.indexOf(win.active);
    this.setActive(win, all[(i + delta + all.length) % all.length]);
    this.emit('select-pane', { how: 'cycle' });
  }

  /* The separator next to the pane moves `n` cells in direction `d`. */
  resizePane(win, pane, d, n) {
    win.zoomed = false;
    this.layout(win);
    const axis = d === 'L' || d === 'R' ? 'h' : 'v';
    let node = pane.node;
    let pick = null;
    let fallback = null;
    while (node.parent) {
      const par = node.parent;
      if (par.dir === axis) {
        if (par.a === node && !pick) pick = par;
        if (!fallback) fallback = par;
      }
      node = par;
    }
    const target = pick || fallback;
    if (!target) return;
    const total = (axis === 'h' ? target.rect.w : target.rect.h) - 1;
    const min = axis === 'h' ? 2 : 1;
    if (total < min * 2) return;
    const now = clamp(Math.round(target.ratio * total), 1, total - 1);
    const delta = d === 'R' || d === 'D' ? n : -n;
    target.ratio = clamp(now + delta, min, total - min) / total;
    this.emit('resize', { dir: d });
  }

  toggleZoom(win) {
    if (this.panes(win).length < 2) return;
    win.zoomed = !win.zoomed;
    this.emit('zoom', { on: win.zoomed });
  }

  applyLayout(win, name) {
    const all = this.panes(win);
    win.zoomed = false;
    const leaf = (p) => {
      const n = { type: 'leaf', pane: p, parent: null };
      p.node = n;
      return n;
    };
    const join = (dir, a, b, ratio) => {
      const n = { type: 'split', dir, a, b, ratio, parent: null };
      a.parent = n;
      b.parent = n;
      return n;
    };
    const even = (list, dir) => (list.length === 1 ? list[0] : join(dir, list[0], even(list.slice(1), dir), 1 / list.length));
    const leaves = all.map(leaf);
    let root;
    if (leaves.length === 1) root = leaves[0];
    else if (name === 'even-horizontal') root = even(leaves, 'h');
    else if (name === 'even-vertical') root = even(leaves, 'v');
    else if (name === 'main-horizontal') root = join('v', leaves[0], even(leaves.slice(1), 'h'), 0.6);
    else if (name === 'main-vertical') root = join('h', leaves[0], even(leaves.slice(1), 'v'), 0.6);
    else {
      const perRow = Math.ceil(Math.sqrt(leaves.length));
      const rows = [];
      for (let i = 0; i < leaves.length; i += perRow) rows.push(even(leaves.slice(i, i + perRow), 'h'));
      root = even(rows, 'v');
    }
    root.parent = null;
    win.root = root;
    win.layoutIdx = LAYOUTS.indexOf(name);
    this.emit('layout', { name });
  }

  breakPane(sess, win) {
    if (this.panes(win).length < 2) {
      this.say("can't break with only one pane");
      return;
    }
    const pane = win.active;
    this.unlink(win, pane);
    this.createWindow(sess, null, pane);
    this.emit('break-pane');
  }

  joinPane(sess, win, target) {
    if (target === win) {
      this.say('source and target panes must be different');
      return;
    }
    const pane = win.active;
    const emptied = this.unlink(win, pane);
    if (!this.splitWith(target, target.active, 'v', pane)) {
      /* no room: put it back as its own window */
      if (emptied) {
        win.root = { type: 'leaf', pane, parent: null };
        pane.node = win.root;
      } else this.createWindow(sess, null, pane);
      this.say('no space for new pane');
      return;
    }
    if (emptied) {
      sess.windows = sess.windows.filter((w) => w !== win);
      if (sess.last === win) sess.last = null;
    }
    sess.cur = target;
    this.emit('join-pane');
  }

  /* ---------- shell ---------- */

  visual(pane, w) {
    const rows = [];
    for (const l of pane.lines) for (const part of wrap(l, w)) rows.push(part);
    if (pane.proc) return { rows, curRow: rows.length, curCol: 0, promptRow: -1 };
    const promptRow = rows.length;
    const full = PROMPT + pane.input;
    for (const part of wrap(full, w)) rows.push(part);
    const idx = PROMPT.length + pane.cur;
    const curRow = promptRow + Math.floor(idx / w);
    if (curRow >= rows.length) rows.push('');
    return { rows, curRow, curCol: idx % w, promptRow };
  }

  shellKey(pane, k) {
    const { key } = k;
    if (k.ctrl) {
      if (key === 'c') {
        if (pane.proc) {
          const n = pane.proc.count;
          this.stopProc(pane);
          pane.print(`^C\n--- lab ping statistics ---\n${n} packets transmitted, ${n} received, 0% packet loss`);
        } else {
          pane.print(PROMPT + pane.input + '^C');
          pane.input = '';
          pane.cur = 0;
        }
        return true;
      }
      if (pane.proc) return false;
      if (key === 'l') {
        pane.lines = [];
        return true;
      }
      if (key === 'u') {
        pane.input = pane.input.slice(pane.cur);
        pane.cur = 0;
        return true;
      }
      if (key === 'a') {
        pane.cur = 0;
        return true;
      }
      if (key === 'e') {
        pane.cur = pane.input.length;
        return true;
      }
      if (key === 'd') {
        if (!pane.input) this.shellRun(pane, 'exit');
        return true;
      }
      return false;
    }
    if (pane.proc) return key.length === 1 || key === 'Enter';
    if (k.alt) return false;
    switch (key) {
      case 'Enter': {
        const line = pane.input;
        pane.input = '';
        pane.cur = 0;
        pane.hi = -1;
        this.shellRun(pane, line);
        return true;
      }
      case 'Backspace':
        if (pane.cur > 0) {
          pane.input = pane.input.slice(0, pane.cur - 1) + pane.input.slice(pane.cur);
          pane.cur--;
        }
        return true;
      case 'Delete':
        pane.input = pane.input.slice(0, pane.cur) + pane.input.slice(pane.cur + 1);
        return true;
      case 'ArrowLeft':
        pane.cur = Math.max(0, pane.cur - 1);
        return true;
      case 'ArrowRight':
        pane.cur = Math.min(pane.input.length, pane.cur + 1);
        return true;
      case 'Home':
        pane.cur = 0;
        return true;
      case 'End':
        pane.cur = pane.input.length;
        return true;
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!pane.hist.length) return true;
        if (pane.hi === -1) pane.hi = pane.hist.length;
        pane.hi = clamp(pane.hi + (key === 'ArrowUp' ? -1 : 1), 0, pane.hist.length);
        pane.input = pane.hist[pane.hi] || '';
        pane.cur = pane.input.length;
        return true;
      }
      default:
        if (key.length === 1) {
          pane.input = pane.input.slice(0, pane.cur) + key + pane.input.slice(pane.cur);
          pane.cur++;
          return true;
        }
        return false;
    }
  }

  typeText(pane, text) {
    const flat = text.replace(/\s*\n\s*/g, ' ');
    pane.input = pane.input.slice(0, pane.cur) + flat + pane.input.slice(pane.cur);
    pane.cur += flat.length;
  }

  shellRun(pane, line) {
    pane.print(PROMPT + line);
    const text = line.trim();
    if (!text) return;
    pane.hist.push(text);
    const argv = tokenize(text);
    const cmd = argv[0];
    const args = argv.slice(1);
    const inside = pane !== this.outer;
    this.emit('shell', { cmd, args, inside });
    switch (cmd) {
      case 'tmux':
        this.tmux(args, { from: inside ? 'pane' : 'outer', pane, out: (m) => pane.print(m) });
        break;
      case 'byobu':
        if (inside) pane.print('byobu: already inside a session. Detach first (F6 or Ctrl+b d).');
        else this.attachByobu();
        break;
      case 'help':
        pane.print(
          [
            'This shell is a simulation. It understands:',
            '  tmux ...      new, ls, attach, kill-session, split-window, and more',
            '  byobu         start or reattach a byobu session',
            '  ls, cat       try: cat notes.txt   or   cat server.log',
            '  seq N         print 1..N (handy for filling the scrollback)',
            '  ping lab      a process that keeps running until Ctrl+c',
            '  echo, date, whoami, hostname, pwd, history, clear, exit',
            inside ? 'Inside tmux, press Ctrl+b ? for the key bindings.' : 'Start with: tmux',
          ].join('\n'),
        );
        break;
      case 'echo':
        pane.print(args.join(' '));
        break;
      case 'clear':
        pane.lines = [];
        break;
      case 'ls':
        pane.print('notes.txt  server.log');
        break;
      case 'cat':
        if (!args.length) pane.print('cat: which file? Try notes.txt or server.log');
        for (const f of args) pane.print(FILES[f] ? FILES[f].join('\n') : `cat: ${f}: No such file or directory`);
        break;
      case 'seq': {
        const n = clamp(parseInt(args[args.length - 1], 10) || 0, 0, 500);
        if (!n) pane.print('seq: give me a number, for example: seq 100');
        else pane.print(Array.from({ length: n }, (_, i) => i + 1).join('\n'));
        break;
      }
      case 'ping': {
        pane.print('PING lab (10.0.0.1) 56(84) bytes of data.');
        const proc = { count: 0, timer: null };
        proc.timer = setInterval(() => {
          proc.count++;
          pane.print(`64 bytes from lab (10.0.0.1): icmp_seq=${proc.count} ttl=64 time=0.0${1 + (proc.count % 7)} ms`);
          if (proc.count >= 600) this.stopProc(pane);
          this.onChange();
        }, 1000);
        pane.proc = proc;
        break;
      }
      case 'date':
        pane.print(new Date().toString());
        break;
      case 'whoami':
        pane.print('you');
        break;
      case 'hostname':
        pane.print('lab');
        break;
      case 'pwd':
        pane.print('/home/you');
        break;
      case 'cd':
        break;
      case 'history':
        pane.print(pane.hist.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join('\n'));
        break;
      case 'exit':
      case 'logout':
        if (inside) this.killPane(pane);
        else pane.print('This is the outermost shell of the lab, so there is nothing to exit to.');
        break;
      case 'man':
        pane.print('No manual pages here. Inside tmux, Ctrl+b ? lists every key binding.');
        break;
      case 'screen':
      case 'zellij':
      case 'herdr':
      case 'tuios':
        pane.print(`${cmd}: not installed in this lab. It simulates tmux and byobu only.`);
        break;
      default:
        pane.print(`${cmd}: command not found (this is a simulated shell, try: help)`);
    }
  }

  attachByobu() {
    const sess = this.sessions.find((s) => s.byobu) || this.createSession(null, true);
    this.attach(sess);
  }

  /* ---------- tmux commands ---------- */

  findSession(target) {
    if (target == null) return null;
    const name = String(target).replace(/^[=$]/, '').replace(/:.*$/, '');
    return this.sessions.find((s) => s.name === name) || this.sessions.find((s) => s.name.startsWith(name)) || null;
  }

  findWindow(sess, target) {
    let t = String(target);
    if (t.includes(':')) {
      const [s, w] = t.split(':');
      if (s) sess = this.findSession(s) || sess;
      t = w.split('.')[0];
    }
    if (!sess) return null;
    if (t === '') return sess.cur;
    if (/^\d+$/.test(t)) return sess.windows.find((w) => w.index === Number(t)) || null;
    return sess.windows.find((w) => w.name === t) || sess.windows.find((w) => w.name.startsWith(t)) || null;
  }

  tmux(argv, ctx) {
    const out = ctx.out;
    const inside = ctx.from !== 'outer';
    let sess = this.attached;
    let win = sess ? sess.cur : null;
    if (ctx.from === 'pane') {
      win = this.windowOf(ctx.pane) || win;
      sess = win ? this.sessionOf(win) : sess;
    }

    let cmd = argv[0];
    let rest = argv.slice(1);
    if (cmd === '-V') return out('tmux 3.5a');
    if (cmd == null) cmd = 'new-session';
    const opt = {};
    const pos = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (/^-[tsncxy]$/.test(a)) opt[a[1]] = rest[++i];
      else if (/^-[A-Za-z]+$/.test(a)) for (const ch of a.slice(1)) opt[ch] = true;
      else pos.push(a);
    }
    this.emit('cmd', { name: cmd, from: ctx.from });

    const needServer = () => {
      if (this.sessions.length) return true;
      out('no server running on /tmp/tmux-1000/default');
      return false;
    };
    const needInside = () => {
      if (sess && win) return true;
      out(needServer() ? 'no current client' : '');
      return false;
    };
    const nested = () => out('sessions should be nested with care, unset $TMUX to force');

    switch (cmd) {
      case 'new':
      case 'new-session': {
        const name = opt.s === true ? undefined : opt.s;
        if (name != null && this.sessions.some((s) => s.name === name)) return out(`duplicate session: ${name}`);
        if (ctx.from === 'pane' && !opt.d) return nested();
        const created = this.createSession(name ?? null, false);
        if (typeof opt.n === 'string') created.cur.name = opt.n;
        this.emit('new-session', { name: created.name });
        if (!opt.d) this.attach(created);
        return;
      }
      case 'ls':
      case 'list-sessions':
        if (!needServer()) return;
        return out(
          this.sessions
            .map((s) => {
              const d = s.created;
              const when = `${d.toDateString()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
              return `${s.name}: ${s.windows.length} windows (created ${when})${s === this.attached ? ' (attached)' : ''}`;
            })
            .join('\n'),
        );
      case 'a':
      case 'at':
      case 'attach':
      case 'attach-session': {
        if (!this.sessions.length) return out('no sessions');
        if (ctx.from === 'pane') return nested();
        const target = opt.t != null ? this.findSession(opt.t) : this.sessions[this.sessions.length - 1];
        if (!target) return out(`can't find session: ${opt.t}`);
        return this.attach(target);
      }
      case 'switch':
      case 'switchc':
      case 'switch-client': {
        if (!needInside()) return;
        const target = this.findSession(opt.t);
        if (!target) return out(`can't find session: ${opt.t ?? ''}`);
        this.attached = target;
        return this.emit('switch-session', { name: target.name });
      }
      case 'detach':
      case 'detach-client':
        if (!needInside()) return;
        return this.detach();
      case 'has':
      case 'has-session':
        if (!this.findSession(opt.t)) out(`can't find session: ${opt.t ?? ''}`);
        return;
      case 'kill-session': {
        if (!needServer()) return;
        const target = opt.t != null ? this.findSession(opt.t) : sess || this.sessions[this.sessions.length - 1];
        if (!target) return out(`can't find session: ${opt.t}`);
        return this.destroySession(target);
      }
      case 'kill-server':
        if (!needServer()) return;
        for (const s of [...this.sessions]) this.destroySession(s);
        return;
      case 'rename':
      case 'rename-session': {
        if (!needServer()) return;
        const target = opt.t != null ? this.findSession(opt.t) : sess || this.sessions[this.sessions.length - 1];
        if (!target) return out(`can't find session: ${opt.t}`);
        if (!pos[0]) return out('usage: rename-session [-t target-session] new-name');
        if (this.sessions.some((s) => s.name === pos[0])) return out(`duplicate session: ${pos[0]}`);
        target.name = pos[0];
        return this.emit('rename-session', { name: pos[0] });
      }
      case 'neww':
      case 'new-window':
        if (!needInside()) return;
        return void this.newWindow(sess, typeof opt.n === 'string' ? opt.n : undefined);
      case 'renamew':
      case 'rename-window':
        if (!needInside()) return;
        if (!pos[0]) return out('usage: rename-window [-t target-window] new-name');
        (opt.t != null ? this.findWindow(sess, opt.t) || win : win).name = pos[0];
        return this.emit('rename-window', { name: pos[0] });
      case 'selectw':
      case 'select-window': {
        if (!needInside()) return;
        const target = this.findWindow(sess, opt.t ?? '');
        if (!target) return out(`can't find window: ${opt.t}`);
        return this.selectWindow(this.sessionOf(target), target, 'index');
      }
      case 'next':
      case 'next-window':
        if (!needInside()) return;
        return this.stepWindow(sess, 1, 'next');
      case 'prev':
      case 'previous-window':
        if (!needInside()) return;
        return this.stepWindow(sess, -1, 'prev');
      case 'last':
      case 'last-window':
        if (!needInside()) return;
        if (!sess.last) return out('no last window');
        return this.selectWindow(sess, sess.last, 'last');
      case 'killw':
      case 'kill-window': {
        if (!needInside()) return;
        const target = opt.t != null ? this.findWindow(sess, opt.t) : win;
        if (!target) return out(`can't find window: ${opt.t}`);
        return this.killWindow(target);
      }
      case 'lsw':
      case 'list-windows':
        if (!needInside()) return;
        return out(
          sess.windows
            .map((w) => `${w.index}: ${w.name}${w === sess.cur ? '*' : w === sess.last ? '-' : ''} (${this.panes(w).length} panes)`)
            .join('\n'),
        );
      case 'splitw':
      case 'split-window':
        if (!needInside()) return;
        return this.split(win, opt.h ? 'h' : 'v');
      case 'selectp':
      case 'select-pane': {
        if (!needInside()) return;
        const d = ['L', 'R', 'U', 'D'].find((x) => opt[x]);
        if (d) return this.selectPaneDir(win, d);
        const p = this.panes(win)[Number(String(opt.t ?? '').replace(/^.*\./, ''))];
        if (!p) return out(`can't find pane: ${opt.t ?? ''}`);
        win.zoomed = false;
        this.setActive(win, p);
        return this.emit('select-pane', { how: 'index' });
      }
      case 'resizep':
      case 'resize-pane': {
        if (!needInside()) return;
        if (opt.Z) return this.toggleZoom(win);
        const d = ['L', 'R', 'U', 'D'].find((x) => opt[x]);
        if (!d) return out('usage: resize-pane [-DLRUZ] [adjustment]');
        return this.resizePane(win, win.active, d, parseInt(pos[0], 10) || 1);
      }
      case 'killp':
      case 'kill-pane':
        if (!needInside()) return;
        return this.killPane(win.active);
      case 'lsp':
      case 'list-panes':
        if (!needInside()) return;
        this.layout(win);
        return out(
          this.panes(win)
            .map((p, i) => `${i}: [${p.rect ? `${p.rect.w}x${p.rect.h}` : 'hidden'}]${p === win.active ? ' (active)' : ''}`)
            .join('\n'),
        );
      case 'selectl':
      case 'select-layout':
        if (!needInside()) return;
        if (!LAYOUTS.includes(pos[0])) return out(`unknown layout: ${pos[0] ?? ''} (try ${LAYOUTS.join(', ')})`);
        return this.applyLayout(win, pos[0]);
      case 'nextl':
      case 'next-layout':
        if (!needInside()) return;
        return this.applyLayout(win, LAYOUTS[(win.layoutIdx + 1) % LAYOUTS.length]);
      case 'breakp':
      case 'break-pane':
        if (!needInside()) return;
        return this.breakPane(sess, win);
      case 'joinp':
      case 'join-pane': {
        if (!needInside()) return;
        const target = this.findWindow(sess, opt.t ?? '');
        if (!target) return out(`can't find window: ${opt.t ?? ''}`);
        return this.joinPane(sess, win, target);
      }
      case 'displayp':
      case 'display-panes':
        if (!needInside()) return;
        return this.flashNumbers();
      case 'copy-mode':
        if (!needInside()) return;
        return this.enterCopy(win.active);
      case 'pasteb':
      case 'paste-buffer':
        if (!needInside()) return;
        return this.paste(win.active);
      case 'lsk':
      case 'list-keys':
        if (ctx.from === 'prompt') this.overlay = { type: 'help', lines: TMUX_KEYS_HELP, scroll: 0 };
        else out(TMUX_KEYS_HELP.join('\n'));
        return;
      case 'display':
      case 'display-message':
        if (!needInside()) return;
        return this.say(pos.join(' '));
      case 'source':
      case 'source-file':
        return out('The lab runs with tmux defaults, so config files are not loaded here.');
      case 'set':
      case 'setw':
      case 'set-option':
      case 'set-window-option':
      case 'bind':
      case 'bind-key':
      case 'unbind':
      case 'unbind-key':
        return out('Options and key bindings are fixed in this lab.');
      default:
        return out(`unknown command: ${cmd}`);
    }
  }

  /* ---------- copy mode ---------- */

  enterCopy(pane) {
    if (pane.copy) return;
    const v = this.visual(pane, pane.rect ? pane.rect.w : this.cols);
    const h = pane.rect ? pane.rect.h : this.rows;
    const top = Math.max(0, v.rows.length - h);
    pane.copy = { off: 0, cy: clamp(v.curRow - top, 0, h - 1), cx: v.curCol, sel: null };
    this.emit('copy-enter');
  }

  copyKey(pane, k) {
    const c = pane.copy;
    const w = pane.rect.w;
    const h = pane.rect.h;
    const v = this.visual(pane, w);
    const total = v.rows.length;
    const maxOff = Math.max(0, total - h);
    const lastRow = Math.min(h, total) - 1;
    const top = () => maxOff - c.off;
    const scroll = (n) => {
      const before = c.off;
      c.off = clamp(c.off + n, 0, maxOff);
      if (c.off !== before) this.emit('copy-scroll');
      return c.off !== before;
    };
    const up = () => {
      if (c.cy > 0) c.cy--;
      else scroll(1);
    };
    const down = () => {
      if (c.cy < lastRow) c.cy++;
      else scroll(-1);
    };
    const key = k.key;
    const lineLen = () => (v.rows[top() + c.cy] || '').length;

    if (k.ctrl) {
      if (key === ' ') c.sel = { row: top() + c.cy, x: c.cx };
      else if (key === 'w') return this.copySelection(pane, v, top()), true;
      else if (key === 'c' || key === 'g') pane.copy = null;
      else if (key === 'p') up();
      else if (key === 'n') down();
      else if (key === 'u') scroll(Math.ceil(h / 2));
      else if (key === 'd') scroll(-Math.ceil(h / 2));
      else if (key === 'b') scroll(h);
      else if (key === 'f') scroll(-h);
      else return false;
      return true;
    }
    if (k.alt) {
      if (key === 'w') return this.copySelection(pane, v, top()), true;
      if (key === 'v') return scroll(h), true;
      return false;
    }
    switch (key) {
      case 'q':
      case 'Escape':
        pane.copy = null;
        break;
      case 'ArrowUp':
      case 'k':
        up();
        break;
      case 'ArrowDown':
      case 'j':
        down();
        break;
      case 'ArrowLeft':
      case 'h':
        c.cx = Math.max(0, c.cx - 1);
        break;
      case 'ArrowRight':
      case 'l':
        c.cx = Math.min(w - 1, c.cx + 1);
        break;
      case 'PageUp':
        scroll(h);
        break;
      case 'PageDown':
        scroll(-h);
        break;
      case 'g':
        scroll(maxOff);
        c.cy = 0;
        break;
      case 'G':
        scroll(-maxOff);
        c.cy = lastRow;
        break;
      case '0':
      case 'Home':
        c.cx = 0;
        break;
      case '$':
      case 'End':
        c.cx = Math.max(0, lineLen() - 1);
        break;
      case 'w': {
        const s = v.rows[top() + c.cy] || '';
        const m = /\s\S/.exec(s.slice(c.cx));
        c.cx = m ? c.cx + m.index + 1 : Math.max(0, s.length - 1);
        break;
      }
      case 'b': {
        const s = (v.rows[top() + c.cy] || '').slice(0, c.cx);
        const m = /\S+\s*$/.exec(s);
        c.cx = m ? m.index : 0;
        break;
      }
      case ' ':
      case 'v':
        c.sel = { row: top() + c.cy, x: c.cx };
        break;
      case 'Enter':
      case 'y':
        this.copySelection(pane, v, top());
        break;
      default:
        break;
    }
    return true;
  }

  selectionRange(pane, top) {
    const c = pane.copy;
    if (!c || !c.sel) return null;
    const a = { row: c.sel.row, x: c.sel.x };
    const b = { row: top + c.cy, x: c.cx };
    return a.row < b.row || (a.row === b.row && a.x <= b.x) ? [a, b] : [b, a];
  }

  copySelection(pane, v, top) {
    const range = this.selectionRange(pane, top);
    pane.copy = null;
    if (!range) return;
    const [a, b] = range;
    const parts = [];
    for (let r = a.row; r <= b.row; r++) {
      const s = v.rows[r] || '';
      parts.push(s.slice(r === a.row ? a.x : 0, r === b.row ? b.x + 1 : s.length));
    }
    this.buffer = parts.join('\n');
    this.emit('copy-copy', { text: this.buffer });
  }

  paste(pane) {
    if (!this.buffer) {
      this.say('no buffers');
      return;
    }
    if (pane.copy || pane.proc) return;
    this.typeText(pane, this.buffer);
    this.emit('paste');
  }

  flashNumbers() {
    this.showNumbers = true;
    this.later(() => {
      this.showNumbers = false;
    }, 1500);
  }

  /* ---------- keys ---------- */

  ask(label, value, onSubmit) {
    this.prompt = { label, value, onSubmit, confirm: false };
  }

  confirm(label, onYes) {
    this.prompt = { label, value: '', onSubmit: onYes, confirm: true };
  }

  openTree(kind) {
    const items = [];
    if (kind === 's') {
      for (const s of this.sessions) {
        items.push({ text: `${s.name}: ${s.windows.length} windows${s === this.attached ? ' (attached)' : ''}`, sess: s });
      }
    } else {
      for (const s of this.sessions) {
        for (const w of s.windows) {
          items.push({ text: `${s.name}:${w.index}  ${w.name}${w === s.cur ? '*' : ''}  (${this.panes(w).length} panes)`, sess: s, win: w });
        }
      }
    }
    const idx = Math.max(0, items.findIndex((i) => i.sess === this.attached && (!i.win || i.win === this.attached.cur)));
    this.overlay = { type: 'tree', kind, items, idx };
  }

  overlayKey(k) {
    const o = this.overlay;
    const key = k.key;
    if (key === 'q' || key === 'Escape') {
      this.overlay = null;
      return true;
    }
    if (o.type === 'help') {
      const max = Math.max(0, o.lines.length - (this.rows - 1));
      if (key === 'ArrowDown' || key === 'j') o.scroll = Math.min(max, o.scroll + 1);
      else if (key === 'ArrowUp' || key === 'k') o.scroll = Math.max(0, o.scroll - 1);
      else if (key === 'Enter') this.overlay = null;
      return true;
    }
    if (key === 'ArrowDown' || key === 'j') o.idx = (o.idx + 1) % o.items.length;
    else if (key === 'ArrowUp' || key === 'k') o.idx = (o.idx - 1 + o.items.length) % o.items.length;
    else if (/^\d$/.test(key) && o.items[Number(key)]) o.idx = Number(key);
    else if (key === 'Enter') {
      const it = o.items[o.idx];
      this.overlay = null;
      if (it) {
        this.attached = it.sess;
        if (it.win && it.win !== it.sess.cur) {
          it.sess.last = it.sess.cur;
          it.sess.cur = it.win;
        }
        this.emit('tree-select', { kind: o.kind });
      }
    }
    return true;
  }

  promptKey(k) {
    const p = this.prompt;
    const key = k.key;
    if (p.confirm) {
      this.prompt = null;
      if (key === 'y' || key === 'Y') p.onSubmit();
      return true;
    }
    if (key === 'Escape' || (k.ctrl && (key === 'c' || key === 'g'))) this.prompt = null;
    else if (key === 'Enter') {
      this.prompt = null;
      p.onSubmit(p.value);
    } else if (key === 'Backspace') p.value = p.value.slice(0, -1);
    else if (k.ctrl && key === 'u') p.value = '';
    else if (key.length === 1 && !k.ctrl && !k.alt) p.value += key;
    return true;
  }

  renameWindowPrompt(win) {
    this.ask('(rename-window) ', win.name, (v) => {
      if (!v) return;
      win.name = v;
      this.emit('rename-window', { name: v });
    });
  }

  renameSessionPrompt(sess) {
    this.ask('(rename-session) ', sess.name, (v) => {
      if (!v) return;
      if (this.sessions.some((s) => s !== sess && s.name === v)) return this.say(`duplicate session: ${v}`);
      sess.name = v;
      this.emit('rename-session', { name: v });
    });
  }

  prefixKey(k) {
    const sess = this.attached;
    const win = sess.cur;
    const key = k.key;
    const dir = ARROWS[key];
    if (dir) {
      if (k.ctrl || k.alt) {
        this.resizePane(win, win.active, dir, k.alt ? 5 : 1);
        this.repeatUntil = Date.now() + 600;
      } else this.selectPaneDir(win, dir);
      return true;
    }
    if (k.ctrl) return true;
    if (/^\d$/.test(key)) {
      const target = sess.windows.find((w) => w.index === Number(key));
      if (target) this.selectWindow(sess, target, 'index');
      else this.say(`can't find window: ${key}`);
      return true;
    }
    switch (key) {
      case 'c':
        this.newWindow(sess);
        break;
      case 'n':
        this.stepWindow(sess, 1, 'next');
        break;
      case 'p':
        this.stepWindow(sess, -1, 'prev');
        break;
      case 'l':
        if (sess.last) this.selectWindow(sess, sess.last, 'last');
        break;
      case 'w':
        this.openTree('w');
        break;
      case 's':
        this.openTree('s');
        break;
      case 'd':
        this.detach();
        break;
      case '$':
        this.renameSessionPrompt(sess);
        break;
      case ',':
        this.renameWindowPrompt(win);
        break;
      case 'f':
        this.ask('(find-window) ', '', (v) => {
          const found = v && sess.windows.find((w) => w.name.includes(v));
          if (found) this.selectWindow(sess, found, 'find');
          else this.say(`no windows matching: ${v}`);
        });
        break;
      case '&':
        this.confirm(`kill-window ${win.name}? (y/n)`, () => this.killWindow(win));
        break;
      case 'x':
        this.confirm(`kill-pane ${this.panes(win).indexOf(win.active)}? (y/n)`, () => this.killPane(win.active));
        break;
      case '%':
        this.split(win, 'h');
        break;
      case '"':
        this.split(win, 'v');
        break;
      case 'o':
        this.cyclePane(win, 1);
        break;
      case ';':
        if (win.lastPane && win.lastPane.node) {
          win.zoomed = false;
          this.setActive(win, win.lastPane);
          this.emit('select-pane', { how: 'last' });
        }
        break;
      case 'q':
        this.flashNumbers();
        break;
      case 'z':
        this.toggleZoom(win);
        break;
      case ' ':
        this.applyLayout(win, LAYOUTS[(win.layoutIdx + 1) % LAYOUTS.length]);
        break;
      case '!':
        this.breakPane(sess, win);
        break;
      case '[':
        this.layout(win);
        this.enterCopy(win.active);
        break;
      case 'PageUp':
        this.layout(win);
        this.enterCopy(win.active);
        this.copyKey(win.active, { key: 'PageUp' });
        break;
      case ']':
        this.paste(win.active);
        break;
      case ':':
        this.ask(':', '', (v) => {
          const argv = tokenize(v);
          if (argv.length) this.tmux(argv, { from: 'prompt', out: (m) => m && this.say(m.split('\n')[0]) });
        });
        break;
      case '?':
        this.overlay = { type: 'help', lines: sess.byobu ? [...BYOBU_KEYS_HELP, '', ...TMUX_KEYS_HELP.map((l) => l.replace(/^C-b/, 'C-a'))] : TMUX_KEYS_HELP, scroll: 0 };
        break;
      case '(':
        this.stepSession(-1);
        break;
      case ')':
        this.stepSession(1);
        break;
      default:
        break;
    }
    return true;
  }

  byobuKey(k) {
    const sess = this.attached;
    const win = sess.cur;
    const key = k.key;
    const dir = ARROWS[key];
    if (dir) {
      if (k.shift && k.alt) this.resizePane(win, win.active, dir, 1);
      else if (k.shift) this.selectPaneDir(win, dir);
      else if (k.alt && dir === 'L') this.stepWindow(sess, -1, 'prev');
      else if (k.alt && dir === 'R') this.stepWindow(sess, 1, 'next');
      else if (k.alt) this.stepSession(dir === 'U' ? -1 : 1);
      else return false;
      return true;
    }
    switch (key) {
      case 'F1':
        if (!k.shift) return false;
        this.overlay = { type: 'help', lines: BYOBU_KEYS_HELP, scroll: 0 };
        return true;
      case 'F2':
        if (k.ctrl && k.shift) {
          this.attached = this.createSession(null, true);
          this.emit('new-session', { name: this.attached.name });
        } else if (k.ctrl) this.split(win, 'h');
        else if (k.shift) this.split(win, 'v');
        else this.newWindow(sess);
        return true;
      case 'F3':
      case 'F4': {
        const delta = key === 'F3' ? -1 : 1;
        if (k.shift) this.cyclePane(win, delta);
        else this.stepWindow(sess, delta, delta < 0 ? 'prev' : 'next');
        return true;
      }
      case 'F5':
        this.say('byobu: profile reloaded');
        return true;
      case 'F6':
        if (k.ctrl) this.killPane(win.active);
        else this.detach();
        return true;
      case 'F7':
        this.layout(win);
        this.enterCopy(win.active);
        return true;
      case 'F8':
        if (k.ctrl) this.renameSessionPrompt(sess);
        else if (k.shift) this.applyLayout(win, LAYOUTS[(win.layoutIdx + 1) % LAYOUTS.length]);
        else this.renameWindowPrompt(win);
        return true;
      case 'F9':
        this.say('byobu-config opens a settings menu here. It is not part of this lab.');
        return true;
      case 'F11':
        if (!k.shift) return false;
        this.toggleZoom(win);
        return true;
      default:
        return false;
    }
  }

  handleKey(k) {
    if (MODIFIER_KEYS.includes(k.key)) return false;
    if (!this.attached) return this.shellKey(this.outer, k);

    this.message = null;
    const sess = this.attached;
    this.layout(sess.cur);

    if (this.overlay) return this.overlayKey(k);
    if (this.prompt) return this.promptKey(k);
    if (this.showNumbers && /^\d$/.test(k.key) && !this.prefix) {
      this.showNumbers = false;
      const p = this.panes(sess.cur)[Number(k.key)];
      if (p) {
        sess.cur.zoomed = false;
        this.setActive(sess.cur, p);
        this.emit('select-pane', { how: 'index' });
      }
      return true;
    }
    if (this.prefix) {
      this.prefix = false;
      return this.prefixKey(k);
    }
    if (Date.now() < this.repeatUntil && ARROWS[k.key] && (k.ctrl || k.alt)) return this.prefixKey(k);
    this.repeatUntil = 0;

    const prefixLetter = sess.byobu ? 'a' : 'b';
    if (k.ctrl && !k.alt && k.key.toLowerCase() === prefixLetter) {
      this.prefix = true;
      return true;
    }
    if (sess.byobu && this.byobuKey(k)) return true;

    const pane = sess.cur.active;
    if (pane.copy) return this.copyKey(pane, k);
    return this.shellKey(pane, k);
  }

  /* Text arriving without key events: paste, on-screen keyboards. */
  handleText(text) {
    const pane = this.attached ? this.attached.cur.active : this.outer;
    if (this.attached && (this.prefix || this.prompt || this.overlay || pane.copy)) {
      for (const ch of text) this.handleKey({ key: ch === '\n' ? 'Enter' : ch });
      return;
    }
    if (!pane.proc) this.typeText(pane, text);
  }

  /* ---------- view ---------- */

  paneView(pane, rect, active, num) {
    const v = this.visual(pane, rect.w);
    const total = v.rows.length;
    const maxOff = Math.max(0, total - rect.h);
    let top = maxOff;
    let indicator = null;
    let cursor = null;
    let range = null;
    if (pane.copy) {
      pane.copy.off = clamp(pane.copy.off, 0, maxOff);
      pane.copy.cy = clamp(pane.copy.cy, 0, rect.h - 1);
      pane.copy.cx = clamp(pane.copy.cx, 0, rect.w - 1);
      top = maxOff - pane.copy.off;
      indicator = `[${pane.copy.off}/${maxOff}]`;
      cursor = { x: pane.copy.cx, y: pane.copy.cy };
      range = this.selectionRange(pane, top);
    } else if (active) {
      cursor = { x: v.curCol, y: v.curRow - top };
    }
    const rows = [];
    for (let i = 0; i < rect.h; i++) {
      const abs = top + i;
      const text = v.rows[abs] ?? '';
      let sel = null;
      if (range && abs >= range[0].row && abs <= range[1].row) {
        sel = [abs === range[0].row ? range[0].x : 0, abs === range[1].row ? range[1].x + 1 : Math.max(text.length, 1)];
      }
      rows.push({ text, sel, prompt: abs === v.promptRow || text.startsWith(PROMPT) });
    }
    return { rect, rows, cursor, active, indicator, num, copy: !!pane.copy };
  }

  view() {
    if (!this.attached) {
      const rect = { x: 0, y: 0, w: this.cols, h: this.rows };
      return { panes: [this.paneView(this.outer, rect, true, 0)], seps: [], status: null, overlay: null, numbers: false };
    }
    const sess = this.attached;
    const win = sess.cur;
    const seps = this.layout(win);
    const all = this.panes(win);
    const a = win.active.rect;
    for (const s of seps) {
      /* highlight the stretch of border that touches the active pane */
      if (s.dir === 'h' && (a.x + a.w === s.x || a.x === s.x + 1)) {
        const from = Math.max(s.y, a.y);
        const to = Math.min(s.y + s.len, a.y + a.h);
        if (to > from) s.hl = [from - s.y, to - s.y];
      }
      if (s.dir === 'v' && (a.y + a.h === s.y || a.y === s.y + 1)) {
        const from = Math.max(s.x, a.x);
        const to = Math.min(s.x + s.len, a.x + a.w);
        if (to > from) s.hl = [from - s.x, to - s.x];
      }
    }
    const panes = all.filter((p) => p.rect).map((p) => this.paneView(p, p.rect, p === win.active, all.indexOf(p)));

    const now = new Date();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const status = {
      byobu: sess.byobu,
      left: sess.byobu ? ' byobu ' : `[${sess.name}] `,
      wins: sess.windows.map((w) => ({
        text: `${w.index}:${w.name}${w === sess.cur ? '*' : w === sess.last ? '-' : ''}${w === sess.cur && w.zoomed ? 'Z' : ''}`,
        cur: w === sess.cur,
      })),
      right: sess.byobu
        ? `${sess.name}  up 3d  0.42  ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${clock}`
        : `"lab" ${clock} ${pad2(now.getDate())}-${months[now.getMonth()]}-${String(now.getFullYear()).slice(2)}`,
      prefix: this.prefix,
      line: null,
    };
    if (this.prompt) status.line = { text: this.prompt.label + this.prompt.value, cursor: !this.prompt.confirm };
    else if (this.message) status.line = { text: this.message, cursor: false };

    let overlay = null;
    if (this.overlay) {
      const o = this.overlay;
      overlay =
        o.type === 'help'
          ? { rows: o.lines.slice(o.scroll, o.scroll + this.rows - 1).map((text) => ({ text })) }
          : { rows: o.items.map((it, i) => ({ text: `(${i}) ${it.text}`, cur: i === o.idx })) };
    }
    return { panes, seps, status, overlay, numbers: this.showNumbers };
  }
}

/* =====================================================================
 * Exercises
 * ===================================================================== */

const K = (...keys) => keys.map((k) => `<kbd>${k}</kbd>`).join(' ');

const LABS = {
  sessions: {
    title: 'Sessions',
    setup: 'outer',
    tasks: [
      { text: 'Start a session named <code>work</code>.', hint: 'Type <code>tmux new -s work</code> and press Enter.', check: (s) => s.attached && s.attached.name === 'work' },
      { text: 'Detach from it. The session keeps running.', hint: `${K('Ctrl+b')} then ${K('d')}`, check: (s, e) => e.type === 'detach' },
      { text: 'List the running sessions from the plain shell.', hint: 'Type <code>tmux ls</code>.', check: (s, e) => e.type === 'cmd' && /^(ls|list-sessions)$/.test(e.name) && !s.attached },
      { text: 'Attach to <code>work</code> again.', hint: 'Type <code>tmux a -t work</code>.', check: (s, e) => e.type === 'attach' && e.name === 'work' },
      { text: 'Rename the session to <code>demo</code> without leaving it.', hint: `${K('Ctrl+b')} then ${K('$')}, clear the old name, type <code>demo</code>, Enter.`, check: (s) => s.attached && s.attached.name === 'demo' },
      { text: 'Detach, then kill <code>demo</code> from the plain shell.', hint: `${K('Ctrl+b')} ${K('d')}, then <code>tmux kill-session -t demo</code>.`, check: (s, e) => e.type === 'kill-session' && !s.attached && !s.sessions.length },
    ],
  },
  windows: {
    title: 'Windows',
    setup: 'session',
    tasks: [
      { text: 'Create a second window.', hint: `${K('Ctrl+b')} then ${K('c')}`, check: (s, e) => e.type === 'new-window' },
      { text: 'Rename it to <code>logs</code>.', hint: `${K('Ctrl+b')} then ${K(',')}, clear the old name, type <code>logs</code>, Enter.`, check: (s) => s.attached && s.attached.cur.name === 'logs' },
      { text: 'Go back to the previous window.', hint: `${K('Ctrl+b')} then ${K('p')}`, check: (s, e) => e.type === 'select-window' && (e.how === 'prev' || e.how === 'next') },
      { text: 'Jump to window 1 by its number.', hint: `${K('Ctrl+b')} then ${K('1')}`, check: (s, e) => e.type === 'select-window' && e.how === 'index' && e.index === 1 },
      { text: 'Open the window list and pick a window from it.', hint: `${K('Ctrl+b')} then ${K('w')}, move with the arrow keys, Enter.`, check: (s, e) => e.type === 'tree-select' },
      { text: 'Close the current window.', hint: `${K('Ctrl+b')} then ${K('&')}, confirm with ${K('y')}.`, check: (s, e) => e.type === 'kill-window' },
    ],
  },
  panes: {
    title: 'Panes',
    setup: 'session',
    tasks: [
      { text: 'Split the window into left and right panes.', hint: `${K('Ctrl+b')} then ${K('%')}`, check: (s, e) => e.type === 'split' && e.dir === 'h' },
      { text: 'Split the pane you are in into top and bottom.', hint: `${K('Ctrl+b')} then ${K('"')}`, check: (s, e) => e.type === 'split' && e.dir === 'v' },
      { text: 'Move to another pane with an arrow key.', hint: `${K('Ctrl+b')} then ${K('←')}`, check: (s, e) => e.type === 'select-pane' && e.how === 'dir' },
      { text: 'Zoom the pane to fill the window.', hint: `${K('Ctrl+b')} then ${K('z')}`, check: (s, e) => e.type === 'zoom' && e.on },
      { text: 'Unzoom it again.', hint: `${K('Ctrl+b')} then ${K('z')} once more.`, check: (s, e) => e.type === 'zoom' && !e.on },
      { text: 'Resize the pane.', hint: `${K('Ctrl+b')} then ${K('Ctrl+→')}. Keep tapping ${K('Ctrl+→')} quickly to keep going.`, check: (s, e) => e.type === 'resize' },
      { text: 'Switch to the next preset layout.', hint: `${K('Ctrl+b')} then ${K('Space')}`, check: (s, e) => e.type === 'layout' },
      { text: 'Close one pane.', hint: `${K('Ctrl+b')} then ${K('x')}, confirm with ${K('y')}.`, check: (s, e) => e.type === 'kill-pane' },
    ],
  },
  copy: {
    title: 'Copy mode',
    setup: 'session',
    tasks: [
      { text: 'Fill the screen with output: run <code>seq 200</code>.', hint: 'Type <code>seq 200</code> and press Enter.', check: (s, e) => e.type === 'shell' && e.cmd === 'seq' },
      { text: 'Enter copy mode.', hint: `${K('Ctrl+b')} then ${K('[')}`, check: (s, e) => e.type === 'copy-enter' },
      { text: 'Scroll up through the history.', hint: `${K('PageUp')} or hold ${K('↑')}.`, check: (s, e) => e.type === 'copy-scroll' },
      { text: 'Select some text and copy it.', hint: `${K('Space')} starts the selection, arrow keys extend it, ${K('Enter')} copies.`, check: (s, e) => e.type === 'copy-copy' && e.text },
      { text: 'Paste what you copied at the prompt.', hint: `${K('Ctrl+b')} then ${K(']')}`, check: (s, e) => e.type === 'paste' },
    ],
  },
  byobu: {
    title: 'Byobu',
    setup: 'outer',
    tasks: [
      { text: 'Start byobu.', hint: 'Type <code>byobu</code> and press Enter.', check: (s) => s.attached && s.attached.byobu },
      { text: 'Open a new window.', hint: K('F2'), check: (s, e) => e.type === 'new-window' },
      { text: 'Switch to the previous window.', hint: `${K('F3')} (and ${K('F4')} for the next one).`, check: (s, e) => e.type === 'select-window' },
      { text: 'Split the window left and right.', hint: K('Ctrl+F2'), check: (s, e) => e.type === 'split' && e.dir === 'h' },
      { text: 'Split the pane top and bottom.', hint: K('Shift+F2'), check: (s, e) => e.type === 'split' && e.dir === 'v' },
      { text: 'Move focus to another split.', hint: `${K('Shift+←')} (any Shift+arrow).`, check: (s, e) => e.type === 'select-pane' },
      { text: 'Zoom the split, then zoom back out.', hint: `${K('Shift+F11')}, twice.`, check: (s, e) => e.type === 'zoom' && !e.on },
      { text: 'Detach.', hint: K('F6'), check: (s, e) => e.type === 'detach' },
    ],
  },
};

/* =====================================================================
 * UI
 * ===================================================================== */

const STORE_KEY = 'tmux-lab-progress';

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveProgress(p) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* progress just won't survive a reload */
  }
}

function initLab() {
  const slot = document.getElementById('tmux-lab');
  if (!slot) return;

  slot.innerHTML = `
    <div class="tl-frame">
      <div class="tl-bar">
        <div class="tl-task" aria-live="polite"></div>
        <div class="tl-actions">
          <button type="button" class="tl-btn" data-act="hint">Hint</button>
          <button type="button" class="tl-btn" data-act="reset">Reset</button>
          <button type="button" class="tl-btn" data-act="dock" aria-pressed="false">Dock</button>
        </div>
      </div>
      <div class="tl-hint" hidden></div>
      <div class="tl-screen" tabindex="-1">
        <div class="tl-canvas"></div>
        <textarea class="tl-input" aria-label="Simulated terminal. Type here; press Tab to leave." autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
        <div class="tl-veil">Click to type</div>
      </div>
      <div class="tl-touch">
        <button type="button" class="tl-btn" data-key="prefix">Ctrl+b</button>
        <button type="button" class="tl-btn" data-key="Escape">Esc</button>
        <button type="button" class="tl-btn" data-key="ArrowLeft" aria-label="Left">←</button>
        <button type="button" class="tl-btn" data-key="ArrowUp" aria-label="Up">↑</button>
        <button type="button" class="tl-btn" data-key="ArrowDown" aria-label="Down">↓</button>
        <button type="button" class="tl-btn" data-key="ArrowRight" aria-label="Right">→</button>
        <button type="button" class="tl-btn" data-key="Enter">Enter</button>
      </div>
    </div>
    <p class="tl-docked-note" hidden>The terminal is docked to the bottom of the window. <button type="button" class="tl-link" data-act="undock">Bring it back here</button></p>`;

  const frame = slot.querySelector('.tl-frame');
  const screen = slot.querySelector('.tl-screen');
  const canvas = slot.querySelector('.tl-canvas');
  const input = slot.querySelector('.tl-input');
  const taskEl = slot.querySelector('.tl-task');
  const hintEl = slot.querySelector('.tl-hint');
  const dockBtn = slot.querySelector('[data-act="dock"]');
  const dockedNote = slot.querySelector('.tl-docked-note');

  const progress = loadProgress();
  let active = null; /* { id, step } */
  let docked = false;
  let cw = 8;
  let lh = 18;

  const sim = new TmuxSim({
    onEvent: (e) => check(e),
    onChange: () => render(),
  });

  /* ----- sizing ----- */

  function measure() {
    const probe = document.createElement('span');
    probe.className = 'tl-probe';
    probe.textContent = 'MMMMMMMMMMMMMMMMMMMM';
    canvas.appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    if (r.width) cw = r.width / 20;
    lh = Math.round(parseFloat(getComputedStyle(canvas).fontSize) * 1.4);
  }

  function fit() {
    measure();
    const cols = clamp(Math.floor(screen.clientWidth / cw), 20, 140);
    const rows = docked ? clamp(Math.floor((window.innerHeight * 0.38) / lh), 8, 18) : 20;
    sim.resize(cols, rows);
    canvas.style.setProperty('--tl-lh', `${lh}px`);
    canvas.style.setProperty('--tl-cw', `${cw}px`);
    canvas.style.width = `${cols * cw}px`;
    canvas.style.height = `${rows * lh}px`;
    document.body.style.paddingBottom = docked ? `${frame.offsetHeight}px` : '';
    render();
  }

  /* ----- drawing ----- */

  const box = (x, y, w, h) => `left:${x * cw}px;top:${y * lh}px;width:${w * cw}px;height:${h * lh}px`;

  function rowHtml(row) {
    const t = row.text;
    if (row.sel) {
      const [a, b] = row.sel;
      const padded = t.padEnd(b, ' ');
      return `${esc(padded.slice(0, a))}<span class="tl-sel">${esc(padded.slice(a, b))}</span>${esc(padded.slice(b))}`;
    }
    if (row.prompt && t.startsWith(PROMPT)) return `<span class="tl-prompt">${esc(PROMPT)}</span>${esc(t.slice(PROMPT.length))}`;
    return esc(t);
  }

  function render() {
    const v = sim.view();
    const html = [];
    for (const p of v.panes) {
      const r = p.rect;
      html.push(`<div class="tl-pane" style="${box(r.x, r.y, r.w, r.h)}">`);
      for (const row of p.rows) html.push(`<div class="tl-row">${rowHtml(row) || ' '}</div>`);
      if (p.cursor && p.cursor.y >= 0 && p.cursor.y < r.h && !v.overlay) {
        html.push(`<span class="tl-cursor${p.copy ? ' tl-cursor-copy' : ''}" style="${box(p.cursor.x, p.cursor.y, 1, 1)}"></span>`);
      }
      if (p.indicator) html.push(`<span class="tl-indicator">${esc(p.indicator)}</span>`);
      if (v.numbers) html.push(`<span class="tl-number${p.active ? ' tl-number-active' : ''}">${p.num}</span>`);
      html.push('</div>');
    }
    for (const s of v.seps) {
      const cls = s.dir === 'h' ? 'tl-sep tl-sep-v' : 'tl-sep tl-sep-h';
      html.push(`<div class="${cls}" style="${s.dir === 'h' ? box(s.x, s.y, 1, s.len) : box(s.x, s.y, s.len, 1)}"></div>`);
      if (s.hl) {
        const [a, b] = s.hl;
        const style = s.dir === 'h' ? box(s.x, s.y + a, 1, b - a) : box(s.x + a, s.y, b - a, 1);
        html.push(`<div class="${cls} tl-sep-active" style="${style}"></div>`);
      }
    }
    if (v.overlay) {
      html.push(`<div class="tl-overlay" style="${box(0, 0, sim.cols, sim.rows - 1)}">`);
      for (const row of v.overlay.rows) html.push(`<div class="tl-row${row.cur ? ' tl-row-cur' : ''}">${esc(row.text.padEnd(sim.cols, ' '))}</div>`);
      html.push('</div>');
    }
    if (v.status) {
      const st = v.status;
      const pos = box(0, sim.rows - 1, sim.cols, 1);
      if (st.line) {
        html.push(`<div class="tl-status tl-status-line" style="${pos}">${esc(st.line.text)}${st.line.cursor ? '<span class="tl-status-cursor"> </span>' : ''}</div>`);
      } else {
        const wins = st.wins.map((w) => `<span class="${w.cur ? 'tl-win-cur' : 'tl-win'}">${esc(w.text)}</span>`).join(' ');
        const badge = st.prefix ? '<span class="tl-prefix">PREFIX</span> ' : '';
        html.push(
          `<div class="tl-status${st.byobu ? ' tl-status-byobu' : ''}" style="${pos}"><span class="tl-status-left">${esc(st.left)}${wins}</span><span class="tl-status-right">${badge}${esc(st.right)}</span></div>`,
        );
      }
    }
    canvas.innerHTML = html.join('');
  }

  /* ----- exercises ----- */

  const cards = [...document.querySelectorAll('.tmux-exercise')].filter((el) => LABS[el.dataset.lab]);

  function renderCards() {
    for (const el of cards) {
      const id = el.dataset.lab;
      const lab = LABS[id];
      const isActive = active && active.id === id;
      const done = isActive ? active.step : progress[id] || 0;
      const total = lab.tasks.length;
      const finished = done >= total;
      const items = lab.tasks
        .map((t, i) => {
          const state = i < done ? 'done' : isActive && i === done ? 'current' : 'todo';
          const mark = state === 'done' ? '<span class="tx-mark" aria-label="Done">✓</span>' : `<span class="tx-mark" aria-hidden="true">${i + 1}</span>`;
          return `<li class="tx-${state}">${mark}<span>${t.text}</span></li>`;
        })
        .join('');
      const label = isActive && !finished ? 'Restart' : done ? 'Practise again' : 'Start practising';
      el.innerHTML = `
        <div class="tx-head">
          <span class="tx-title">Practice: ${lab.title}</span>
          <span class="tx-count">${finished ? 'Complete' : `${done} of ${total}`}</span>
        </div>
        <ol class="tx-tasks">${items}</ol>
        <button type="button" class="tl-btn tx-start">${label}</button>`;
      el.classList.toggle('tx-active', !!isActive);
      el.querySelector('.tx-start').addEventListener('click', () => startLab(id));
    }
  }

  function renderTask() {
    hintEl.hidden = true;
    const hintBtn = slot.querySelector('[data-act="hint"]');
    if (!active) {
      taskEl.innerHTML = '<span class="tl-task-label">Free play</span> Type <code>tmux</code> to begin.';
      hintBtn.hidden = true;
      return;
    }
    const lab = LABS[active.id];
    const total = lab.tasks.length;
    if (active.step >= total) {
      taskEl.innerHTML = `<span class="tl-task-label">${lab.title}</span> <span class="tl-task-done">All ${total} done.</span> Keep playing, or pick another exercise.`;
      hintBtn.hidden = true;
      return;
    }
    taskEl.innerHTML = `<span class="tl-task-label">${lab.title} ${active.step + 1}/${total}</span> ${lab.tasks[active.step].text}`;
    hintBtn.hidden = false;
  }

  function check(e) {
    if (!active) return;
    const lab = LABS[active.id];
    const task = lab.tasks[active.step];
    if (!task || !task.check(sim, e)) return;
    active.step++;
    progress[active.id] = Math.max(progress[active.id] || 0, active.step);
    saveProgress(progress);
    renderTask();
    renderCards();
  }

  function startLab(id) {
    active = { id, step: 0 };
    sim.reset(LABS[id].setup);
    if (!docked) setDocked(true);
    renderTask();
    renderCards();
    render();
    focus();
  }

  /* ----- dock ----- */

  function setDocked(on) {
    docked = on;
    frame.classList.toggle('tl-docked', on);
    dockBtn.textContent = on ? 'Undock' : 'Dock';
    dockBtn.setAttribute('aria-pressed', String(on));
    dockedNote.hidden = !on;
    fit();
  }

  /* ----- input ----- */

  function focus() {
    input.focus({ preventScroll: true });
  }

  function afterInput() {
    check({ type: 'tick' });
    render();
  }

  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.metaKey || e.key === 'Tab') return;
    let key = e.key;
    if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code[3].toLowerCase();
    if (e.ctrlKey && key.length === 1) key = key.toLowerCase();
    if (sim.handleKey({ key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })) {
      e.preventDefault();
      afterInput();
    }
  });

  /* on-screen keyboards and IME deliver text here instead of keydown */
  input.addEventListener('input', () => {
    const text = input.value;
    input.value = '';
    if (!text) return;
    for (const ch of text) {
      if (ch === '\n') sim.handleKey({ key: 'Enter' });
      else sim.handleKey({ key: ch });
    }
    afterInput();
  });

  input.addEventListener('paste', (e) => {
    e.preventDefault();
    sim.handleText((e.clipboardData || window.clipboardData).getData('text'));
    afterInput();
  });

  input.addEventListener('focus', () => frame.classList.add('tl-focused'));
  input.addEventListener('blur', () => frame.classList.remove('tl-focused'));
  screen.addEventListener('mousedown', (e) => {
    e.preventDefault();
    focus();
  });

  frame.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'dock') {
      setDocked(!docked);
      focus();
    } else if (act === 'reset') {
      sim.reset(active ? LABS[active.id].setup : 'outer');
      if (active) active.step = 0;
      renderTask();
      renderCards();
      render();
      focus();
    } else if (act === 'hint' && active) {
      const task = LABS[active.id].tasks[active.step];
      if (task) {
        hintEl.innerHTML = task.hint;
        hintEl.hidden = !hintEl.hidden;
        if (docked) document.body.style.paddingBottom = `${frame.offsetHeight}px`;
      }
      focus();
    } else if (btn.dataset.key) {
      const k = btn.dataset.key;
      const prefixLetter = sim.attached && sim.attached.byobu ? 'a' : 'b';
      sim.handleKey(k === 'prefix' ? { key: prefixLetter, ctrl: true } : { key: k });
      afterInput();
      focus();
    }
  });

  dockedNote.querySelector('[data-act="undock"]').addEventListener('click', () => {
    setDocked(false);
    slot.scrollIntoView({ block: 'center' });
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, 100);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);

  renderTask();
  renderCards();
  fit();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initLab);
  else initLab();
}
