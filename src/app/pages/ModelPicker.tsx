import { useEffect, useMemo, useRef, useState } from "react";
import { getAgentModels } from "../doc/client";
import { EngineIcon, engineOf } from "./EngineIcon";
import { modelOf } from "../../shared/choice";

/** A model the server offers (`engine:model`), with whatever its engine knows about it, and why it can't run now. */
export interface AgentModelOption {
  id: string;
  engine: string;
  title: string;
  unavailable?: string;
  /** The group it is listed under while searching ("DeepSeek"); its engine when absent. */
  vendor?: string;
  /** Its context window, in tokens. */
  context?: number;
  /** Dollars per million tokens, in and out. */
  inUsd?: number;
  outUsd?: number;
  /** A few words beside it in the list ("Pi's own default"). */
  note?: string;
  /** One of the writer's preferred models (`agent.preferred_models`): listed first. */
  preferred?: boolean;
}

/** How many results a search shows before it asks for more typing: a whole catalog is hundreds of models long. */
const MAX_RESULTS = 60;

/** A context window as a writer reads it: 200K, 1M. */
export const contextSize = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

const money = (n: number) => (n >= 1 ? `$${+n.toFixed(2)}` : `$${+n.toFixed(3)}`);
/** What a million tokens cost, in then out, or "free"; null when the engine doesn't say. */
export function priceOf(m: AgentModelOption): string | null {
  if (m.inUsd === undefined && m.outUsd === undefined) return null;
  if (!m.inUsd && !m.outUsd) return "free";
  return `${money(m.inUsd ?? 0)} / ${money(m.outUsd ?? 0)}`;
}

/** What a model's row says under its name: how much it holds and what it costs. */
const meta = (m: AgentModelOption) => [m.context ? contextSize(m.context) : null, priceOf(m)].filter(Boolean).join(" · ");

/**
 * The models a query finds: every word of it somewhere in the name, the vendor, the engine or the id. A name that
 * begins with what was typed comes first, then one that merely contains it, and a preferred model ahead of its equals.
 */
export function searchModels(catalog: AgentModelOption[], query: string): AgentModelOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: { m: AgentModelOption; score: number }[] = [];
  for (const m of catalog) {
    const hay = `${m.title} ${m.vendor ?? ""} ${m.engine} ${m.id}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const name = m.title.toLowerCase();
    const first = words[0]!;
    hits.push({ m, score: (name.startsWith(first) ? 0 : name.includes(first) ? 1 : 2) - (m.preferred ? 0.5 : 0) });
  }
  return hits.sort((a, b) => a.score - b.score || a.m.title.localeCompare(b.m.title)).map((h) => h.m);
}

/** What the open picker shows for a query: the rows, how many more matched, and which of them can be picked. */
export function rowsFor(offered: AgentModelOption[], catalog: AgentModelOption[], query: string) {
  const searching = query.trim().length > 0;
  const found = searching ? searchModels(catalog, query) : offered;
  const rows = found.slice(0, MAX_RESULTS);
  return { searching, rows, more: Math.max(0, found.length - MAX_RESULTS), pickable: rows.filter((m) => !m.unavailable) };
}

/** The list as it is shown: the shortlist under Preferred and each engine, or the search's results by vendor. */
export function groupModels(list: AgentModelOption[], searching: boolean): { group: string; items: AgentModelOption[] }[] {
  const groups: { group: string; items: AgentModelOption[] }[] = [];
  for (const m of list) {
    const name = searching ? m.vendor || m.engine : m.preferred ? "Preferred" : m.engine;
    const g = groups.find((x) => x.group === name);
    if (g) g.items.push(m);
    else groups.push({ group: name, items: [m] });
  }
  return groups;
}

/**
 * The open picker: the search field, the models under their groups, and the line that says how many there are. It
 * keeps nothing of its own, so it can be pictured in any state (`FEATURES.html`); `ModelSelect` is what a page uses.
 */
export function ModelMenu({ model, offered, catalog, query, active, onQuery, onActive, onChoose, onKeys, fieldRef, listRef }: {
  model: string;
  /** The shortlist, shown before anything is typed. */
  offered: AgentModelOption[];
  /** Every model the engines can run, which the search looks through. */
  catalog: AgentModelOption[];
  query: string;
  /** Which of the pickable rows the keys are on. */
  active: number;
  onQuery(q: string): void;
  onActive(i: number): void;
  onChoose(m: AgentModelOption): void;
  onKeys?(e: React.KeyboardEvent): void;
  fieldRef?: React.Ref<HTMLInputElement>;
  listRef?: React.Ref<HTMLDivElement>;
}) {
  const { searching, rows, more, pickable } = rowsFor(offered, catalog, query);
  const groups = groupModels(rows, searching);
  return (
    <div className="model-menu" role="dialog" aria-label="Choose a model">
      <div className="model-search">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true"><circle cx="5" cy="5" r="3.2" /><path d="M7.4 7.4L10 10" /></svg>
        <input
          ref={fieldRef} type="search" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onKeys}
          placeholder={`Search ${catalog.length} model${catalog.length === 1 ? "" : "s"}…`} aria-label="Search models" autoComplete="off" spellCheck={false}
        />
      </div>
      <div className="model-list" role="listbox" aria-label="Models" ref={listRef}>
        {groups.map((g) => (
          <div className="model-group" key={g.group}>
            <div className="model-group-name">{g.group}</div>
            {g.items.map((m) => {
              const i = pickable.indexOf(m);
              const info = meta(m);
              return (
                <div
                  key={m.id} role="option" aria-selected={m.id === model} aria-disabled={!!m.unavailable}
                  className={`model-row${m.id === model ? " on" : ""}${m.unavailable ? " off" : ""}`}
                  data-active={i >= 0 && i === active ? "1" : undefined} title={m.unavailable}
                  onMouseEnter={() => { if (i >= 0) onActive(i); }}
                  onClick={() => onChoose(m)}
                >
                  <EngineIcon engine={engineOf(m.id)} size={12} className="model-row-icon" />
                  <div className="model-row-text">
                    <div className="model-row-top">
                      <span className="model-row-name">{m.title}</span>
                      {m.note && <span className="model-row-note">{m.note}</span>}
                      {m.unavailable && <span className="model-row-note warn">not set up</span>}
                    </div>
                    {(info || searching) && <div className="model-row-meta">{[info, searching ? m.engine : null].filter(Boolean).join(" · ")}</div>}
                  </div>
                  {m.id === model && (
                    <svg className="model-tick" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 6.4l2.4 2.4 4.6-5.2" /></svg>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {!rows.length && <p className="model-none">{searching ? "No model matches." : "No model is offered yet."}</p>}
      </div>
      <div className="model-foot">
        {more > 0
          ? `${more} more match — keep typing to narrow it.`
          : searching
            ? `${rows.length} of ${catalog.length} models`
            : "Type to search every model your engines can run."}
      </div>
    </div>
  );
}

/**
 * The model picker: the page's choice, a shortlist to pick from at a glance, and a search over every model the
 * writer's engines can run — for Pi, every model their own Pi has credentials for, which is hundreds, so the catalog
 * is read from the server the first time the picker is opened rather than carried in the page's stream.
 *
 * Preferred models (`agent.preferred_models`) are listed first; a model whose engine can't run now is there but can't
 * be chosen, and says why. ↑ ↓ move, Enter picks, Escape closes, and so does a click outside.
 */
export function ModelSelect({ model, models, onModel, className = "", title, catalog: given }: {
  model: string;
  models: AgentModelOption[];
  onModel(m: string): void;
  className?: string;
  title?: string;
  /** The full catalog, when the caller already has it (the features catalog, the tests); read from the server otherwise. */
  catalog?: AgentModelOption[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [fetched, setFetched] = useState<AgentModelOption[] | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // Before the server has said anything, the current choice alone, so the picker always names what the page is on.
  const offered = models.length ? models : [{ id: model, engine: engineOf(model), title: modelOf(model) }];
  const catalog = given ?? fetched ?? offered;
  const pickable = useMemo(() => rowsFor(offered, catalog, query).pickable, [offered, catalog, query]);
  const current = catalog.find((m) => m.id === model) ?? offered.find((m) => m.id === model);

  // The catalog is read once, when the picker is first opened: it is far longer than a page's stream wants to carry.
  useEffect(() => {
    if (!open || given || fetched) return;
    let gone = false;
    void getAgentModels().then((r) => { if (!gone && r) setFetched(r.catalog); });
    return () => { gone = true; };
  }, [open, given, fetched]);

  // Opened: the search field takes the keys at once, so the writer can type a name instead of hunting for it.
  useEffect(() => {
    if (open) field.current?.focus();
    else { setQuery(""); setActive(0); }
  }, [open]);

  // A click anywhere else closes it, as a native select would.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => { setActive(0); }, [query]);
  // Keeps the row the keys are on in sight.
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[data-active="1"]');
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, query, open]);

  const choose = (m: AgentModelOption) => {
    if (m.unavailable) return;
    setOpen(false);
    if (m.id !== model) onModel(m.id);
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!pickable.length) return;
      const by = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + by + pickable.length) % pickable.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const m = pickable[active];
      if (m) choose(m);
    }
  };

  const label = current?.title ?? model;
  return (
    <div className={`model-pick ${className}`.trim()} ref={box} title={open ? undefined : title}>
      <button
        type="button" className="model-trigger" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "Enter")) { e.preventDefault(); setOpen(true); } }}
      >
        <EngineIcon engine={engineOf(model)} size={12} />
        <span className="model-name">{label}</span>
        <svg className="model-caret" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4" /></svg>
      </button>

      {open && (
        <ModelMenu
          model={model} offered={offered} catalog={catalog} query={query} active={active}
          onQuery={setQuery} onActive={setActive} onChoose={choose} onKeys={keys} fieldRef={field} listRef={list}
        />
      )}
    </div>
  );
}
