import { config } from "../../config";
import type { AgentEngine, EngineModel } from "../engine";
import { cmdEngine } from "./cmd";
import { piEngine } from "./pi";

const pi = piEngine();
/**
 * Pi, the one real engine. A page chooses its own model; an engine that can't run says why in the model list.
 * `AGENT_CMD` (a JSON argv) puts a stand-in named `fake` first: the tests' fake, a process speaking stream-json. Read
 * on each call, since tests set it as they go.
 */
const builtins = (): AgentEngine[] => (process.env.AGENT_CMD ? [cmdEngine, pi] : [pi]);
/** Engines set by `setEngines`, in place of the built-ins. */
let registered: AgentEngine[] | null = null;
/** The engines a page's agent can run on, in the order the model picker lists them. The first one's first model is the default. */
export const engines = () => registered ?? builtins();
/** Replaces the registered engines (tests add a fake one). Returns the old list. */
export function setEngines(list: AgentEngine[] | null): AgentEngine[] | null {
  const old = registered;
  registered = list;
  return old;
}

/** A model choice: `engine:model`, e.g. `pi:openrouter/~deepseek/deepseek-flash-latest`. */
export const choiceOf = (engine: string, model: string) => `${engine}:${model}`;
/**
 * The model a page starts on: the first of the writer's preferred models (`agent.preferred_models`) whose engine can
 * run now, and otherwise the first engine's first model. A preferred model no engine has is passed over.
 */
export function defaultChoice(): string {
  for (const x of config().agent.preferred_models) {
    const c = parseChoice(x);
    if (c && !c.engine.unavailable()) return c.choice;
  }
  const e = engines()[0]!;
  return choiceOf(e.name, e.models()[0]!.id);
}

/** Every model an engine could run: its catalog when it has one, else the shortlist it offers. */
const everyModel = (e: AgentEngine) => e.catalog?.() ?? e.models();
/**
 * Whether an engine can run this model id: its own answer, or whether one of its lists has it. An engine that reads a
 * catalog answers for itself, so a model it has but doesn't list at a glance — one the writer searched out — still
 * counts as its own.
 */
export const engineKnows = (e: AgentEngine, model: string) => (e.knows ? e.knows(model) : everyModel(e).some((m) => m.id === model));
/**
 * Whether an engine offers this model to pick now: it must be one of the models it lists, not merely one it would
 * take. Where the writer is choosing (`POST …/agent`), so that a typo is refused there and not six minutes later in a
 * run; `engineKnows` is the wider one, for a model the engine would take that it doesn't list.
 */
export const engineOffers = (e: AgentEngine, model: string) => everyModel(e).some((m) => m.id === model);
/** Lets every engine read what its lists need (Pi's model catalog), once. Never throws: an engine that can't is listed as it was. */
export const warmEngines = async () => { await Promise.all(engines().map((e) => e.warm?.().catch(() => {}))); };

/** Reads a model choice, `engine:model`. Null when there is no such engine, or it doesn't have that model. */
export function parseChoice(x: unknown): { engine: AgentEngine; model: string; choice: string } | null {
  if (typeof x !== "string" || !x) return null;
  const colon = x.indexOf(":");
  const named = colon > 0 ? engines().find((e) => e.name === x.slice(0, colon)) : undefined;
  if (!named) return null;
  const model = x.slice(colon + 1);
  return engineKnows(named, model) ? { engine: named, model, choice: x } : null;
}

/** A model as the picker shows it: the choice to send back, which engine it belongs to, and why it can't run now. */
export interface ModelOption extends EngineModel { engine: string; unavailable?: string; preferred?: true }
const option = (e: AgentEngine, why: string | null, m: EngineModel): ModelOption =>
  ({ ...m, id: choiceOf(e.name, m.id), engine: e.title, ...(why ? { unavailable: why } : {}) });

/** The writer's preferred models (`agent.preferred_models`) as the picker shows them, in their own order. */
const preferred = (): ModelOption[] => {
  const out: ModelOption[] = [];
  for (const x of config().agent.preferred_models) {
    const c = parseChoice(x);
    if (!c || out.some((o) => o.id === c.choice)) continue;
    // Its own entry when the engine has one (a title, a price); otherwise the bare id, which `start` will resolve.
    const m = everyModel(c.engine).find((e) => e.id === c.model) ?? { id: c.model, title: c.model };
    out.push({ ...option(c.engine, c.engine.unavailable(), m), preferred: true });
  }
  return out;
};

/** The shortlist the picker shows at a glance: the preferred models first, then each engine's own. */
export const modelList = (): ModelOption[] => {
  const out = preferred();
  for (const e of engines()) {
    const why = e.unavailable();
    for (const m of e.models()) { const o = option(e, why, m); if (!out.some((x) => x.id === o.id)) out.push(o); }
  }
  return out;
};

/** Every model every engine could run, for the picker's search. Call `warmEngines` first, or an engine may have nothing to say yet. */
export const modelCatalog = (): ModelOption[] => {
  const pinned = new Set(preferred().map((m) => m.id));
  return engines().flatMap((e) => {
    const why = e.unavailable();
    return everyModel(e).map((m) => { const o = option(e, why, m); return pinned.has(o.id) ? { ...o, preferred: true as const } : o; });
  });
};
