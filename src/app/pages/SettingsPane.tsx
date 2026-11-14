import { useEffect, useState } from "react";
import type { SettingView } from "../../server/config";

/** What `GET /api/config` returns: the settings in effect and the file they came from. */
export interface LoadedConfig { file: string | null; settings: SettingView[] }

/** `default`, `file` or `env:NAME` as a short badge. */
const sourceLabel = (s: string) => (s.startsWith("env:") ? "env" : s);

/** The loaded settings, by section, each with its value and where the value came from. Hover a key for what it does. */
export function SettingsList({ config, filter = "" }: { config: LoadedConfig; filter?: string }) {
  const q = filter.trim().toLowerCase();
  const rows = config.settings.filter((s) => !q || s.key.includes(q) || s.env.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q));
  const groups = [...new Set(rows.map((s) => s.group))];
  return (
    <div className="settings-list">
      <p className="settings-file">{config.file ? <>Loaded <code>{config.file}</code></> : "No config file: defaults and the environment."}</p>
      {rows.length === 0 && <p className="settings-none">No setting matches.</p>}
      {groups.map((g) => (
        <section key={g} aria-label={g}>
          <h3>{g === "pages" ? "pages" : g}</h3>
          <dl>
            {rows.filter((s) => s.group === g).map((s) => (
              <div key={s.key} className={`setting src-${sourceLabel(s.source)}`} title={`${s.summary} Env: ${s.env}.`}>
                <dt>{s.key}</dt>
                <dd>
                  {s.value === null ? <span className="unset">unset</span> : s.value.map((v, i) => <span key={i} className={s.secret ? "secret" : undefined}>{v}</span>)}
                </dd>
                <span className="source" title={s.source === "default" ? "The default." : s.source === "file" ? "Set in the config file." : `Set by the environment variable ${s.source.slice(4)}.`}>{s.source.startsWith("env:") ? s.source.slice(4) : s.source}</span>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** The loaded settings tab of the settings dialog: fetches the config once when shown. */
export function SettingsPane({ initial }: { initial?: LoadedConfig }) {
  const [config, setConfig] = useState<LoadedConfig | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (initial) return;
    let live = true;
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((c) => live && setConfig(c))
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => { live = false; };
  }, [initial]);
  return (
    <div className="settings-pane">
      <input className="settings-filter" type="search" placeholder="Filter settings" aria-label="Filter settings" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {error && <p className="settings-none">Couldn't load the settings ({error}).</p>}
      {!config && !error && <p className="settings-none">Loading…</p>}
      {config && <SettingsList config={config} filter={filter} />}
    </div>
  );
}
