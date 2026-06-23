/**
 * Event log — a categorized live trail rendered into the right drawer.
 *
 * The rest of the app emits into a singleton; the drawer subscribes and renders
 * incoming events with timestamps, category tags, levels, and optional metadata.
 * Filterable by category.
 */

export type EventCategory = 'system' | 'ui' | 'crypto' | 'image' | 'stego' | 'io';
export type EventLevel = 'info' | 'ok' | 'warn' | 'err';

export interface LogEvent {
  ts: number;
  cat: EventCategory;
  level: EventLevel;
  msg: string;
  meta?: Record<string, string | number>;
}

const ALL_CATS: EventCategory[] = ['system', 'ui', 'crypto', 'image', 'stego', 'io'];
const MAX_EVENTS = 800;

let events: LogEvent[] = [];
let listeners: Array<(e: LogEvent) => void> = [];
const activeCats: Set<EventCategory> = new Set(ALL_CATS);
let listEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let autoScroll = true;

/** Push an event into the log. */
export function emit(
  cat: EventCategory,
  level: EventLevel,
  msg: string,
  meta?: Record<string, string | number>,
): void {
  const e: LogEvent = { ts: Date.now(), cat, level, msg, meta };
  events.push(e);
  if (events.length > MAX_EVENTS) {
    events.shift();
    if (listEl) {
      const first = listEl.querySelector('.event');
      if (first) first.remove();
    }
  }
  for (const l of listeners) l(e);
}

export function clearLog(): void {
  events = [];
  if (listEl) listEl.innerHTML = '';
  if (countEl) countEl.textContent = '0';
}

/** Mount the live drawer into a container. Returns a dispose function. */
export function mountEventDrawer(container: HTMLElement): () => void {
  container.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'drawer-head';
  head.innerHTML = `
    <div class="drawer-title">live event trail</div>
    <div class="drawer-controls">
      <span class="count"><strong id="ev-count">0</strong>&nbsp;events</span>
    </div>
  `;
  container.appendChild(head);

  const filters = document.createElement('div');
  filters.className = 'drawer-filters';
  for (const c of ALL_CATS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-pill on';
    btn.dataset.cat = c;
    btn.textContent = c;
    btn.addEventListener('click', () => {
      if (activeCats.has(c)) {
        activeCats.delete(c);
        btn.classList.remove('on');
      } else {
        activeCats.add(c);
        btn.classList.add('on');
      }
      reflow();
    });
    filters.appendChild(btn);
  }
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'filter-pill';
  clearBtn.style.marginLeft = 'auto';
  clearBtn.textContent = 'clear';
  clearBtn.addEventListener('click', () => clearLog());
  filters.appendChild(clearBtn);
  container.appendChild(filters);

  const list = document.createElement('div');
  list.className = 'drawer-list';
  container.appendChild(list);

  listEl = list;
  countEl = container.querySelector('#ev-count');

  list.addEventListener('scroll', () => {
    autoScroll = list.scrollTop + list.clientHeight >= list.scrollHeight - 32;
  });

  reflow();

  const onEvent = (e: LogEvent) => {
    if (activeCats.has(e.cat)) appendEvent(e);
    bumpCount();
  };
  listeners.push(onEvent);

  return () => {
    listeners = listeners.filter((l) => l !== onEvent);
    listEl = null;
    countEl = null;
  };
}

function bumpCount(): void {
  if (countEl) countEl.textContent = String(events.length);
}

function reflow(): void {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const e of events) {
    if (!activeCats.has(e.cat)) continue;
    appendEvent(e, false);
  }
  listEl.scrollTop = listEl.scrollHeight;
  bumpCount();
}

function appendEvent(e: LogEvent, scroll = true): void {
  if (!listEl) return;
  const row = document.createElement('div');
  row.className = 'event';
  row.dataset.cat = e.cat;
  row.dataset.level = e.level;

  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = formatTs(e.ts);
  const cat = document.createElement('span');
  cat.className = 'cat';
  cat.textContent = e.cat;
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = e.msg;
  row.append(ts, cat, msg);

  if (e.meta) {
    const meta = document.createElement('span');
    meta.className = 'meta';
    const parts: string[] = [];
    for (const [k, v] of Object.entries(e.meta)) {
      parts.push(`<span class="k">${escapeHtml(k)}</span>=<span class="v">${escapeHtml(String(v))}</span>`);
    }
    meta.innerHTML = parts.join(' · ');
    row.appendChild(meta);
  }

  listEl.appendChild(row);
  if (scroll && autoScroll) listEl.scrollTop = listEl.scrollHeight;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
