"use client";

import { useEffect, useMemo, useState } from "react";
import { catalog, defaultModel, frameworksFor, parseOptions, type Capability, type Options } from "@/lib/catalog";

const NAME_RE = /^[a-z][a-z0-9-]{0,49}$/;

const INITIAL: Options = {
  name: "my-agent",
  description: "",
  language: "python",
  provider: "anthropic",
  model: defaultModel("anthropic"),
  framework: "sdk",
  capabilities: ["tools", "http"],
};

type Row = { label: string; depth: number; dir: boolean; path?: string };

// Turns a flat, sorted list of paths into indented tree rows.
function toRows(root: string, paths: string[]): Row[] {
  const rows: Row[] = [{ label: `${root}/`, depth: 0, dir: true }];
  const seen = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    parts.forEach((part, i) => {
      const key = parts.slice(0, i + 1).join("/");
      if (seen.has(key)) return;
      seen.add(key);
      const dir = i < parts.length - 1;
      rows.push({ label: dir ? `${part}/` : part, depth: i + 1, dir, path: dir ? undefined : path });
    });
  }
  return rows;
}

function toQuery(o: Options) {
  return new URLSearchParams({
    name: o.name,
    description: o.description,
    language: o.language,
    framework: o.framework,
    provider: o.provider,
    model: o.model,
    caps: o.capabilities.join(","),
  });
}

function fromQuery(search: string): Options | null {
  const p = new URLSearchParams(search);
  if (!p.has("name")) return null;
  return parseOptions({
    name: p.get("name"),
    description: p.get("description") ?? "",
    language: p.get("language"),
    framework: p.get("framework") ?? undefined,
    provider: p.get("provider"),
    model: p.get("model") ?? undefined,
    capabilities: (p.get("caps") ?? "").split(",").filter(Boolean),
  });
}

function curlCommand(origin: string, o: Options) {
  const body = JSON.stringify(o).replace(/'/g, `'\\''`);
  return `curl -sS -X POST ${origin}/api/starter.zip -H 'content-type: application/json' -d '${body}' -o ${o.name}.zip && unzip ${o.name}.zip`;
}

export default function Home() {
  const [opts, setOpts] = useState<Options>(INITIAL);
  const [ready, setReady] = useState(false);
  const [origin, setOrigin] = useState("");
  const [files, setFiles] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const valid = NAME_RE.test(opts.name);

  // Restore a shared configuration from the URL, then keep the URL in sync.
  useEffect(() => {
    const shared = fromQuery(window.location.search);
    if (shared) setOpts(shared);
    setOrigin(window.location.origin);
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) window.history.replaceState(null, "", `?${toQuery(opts)}`);
  }, [opts, ready]);

  useEffect(() => {
    if (!valid) return setFiles({});
    const ctrl = new AbortController();
    fetch("/api/starter.zip", { method: "PUT", body: JSON.stringify(opts), signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => setFiles(d.files ?? {}))
      .catch(() => {});
    return () => ctrl.abort();
  }, [opts, valid]);

  const paths = useMemo(() => Object.keys(files).sort(), [files]);
  const rows = useMemo(() => toRows(opts.name, paths), [opts.name, paths]);
  const current = files[selected] !== undefined ? selected : (paths.find((p) => /agent\.(py|ts)$/.test(p)) ?? paths[0] ?? "");
  // Re-key the tree when the shape changes so rows draw in again.
  const treeKey = `${opts.language}-${opts.framework}-${opts.provider}-${opts.capabilities.join()}`;

  const set = (patch: Partial<Options>) => setOpts((o) => ({ ...o, ...patch }));
  const setLanguage = (language: Options["language"]) =>
    setOpts((o) => ({
      ...o,
      language,
      framework: frameworksFor(language).some((f) => f.id === o.framework) ? o.framework : "sdk",
    }));
  const setProvider = (provider: Options["provider"]) => set({ provider, model: defaultModel(provider) });
  const toggle = (c: Capability) =>
    setOpts((o) => ({
      ...o,
      capabilities: o.capabilities.includes(c) ? o.capabilities.filter((x) => x !== c) : [...o.capabilities, c],
    }));

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setError("Couldn't copy to the clipboard. Select the text and copy it manually.");
    }
  }

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/starter.zip", { method: "POST", body: JSON.stringify(opts) });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      Object.assign(document.createElement("a"), { href: url, download: `${opts.name}.zip` }).click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Couldn't generate the project. Check the options and try again.");
    } finally {
      setBusy(false);
    }
  }

  const languageName = catalog.languages.find((l) => l.id === opts.language)?.name;
  const frameworkName = catalog.frameworks.find((f) => f.id === opts.framework)?.name;
  const modelName = catalog.models[opts.provider].find((m) => m.id === opts.model)?.name;
  const command = curlCommand(origin || "https://your-site", opts);

  return (
    <div className="page">
      <div className="top">
        <svg className="mark" viewBox="0 0 22 22" fill="none" stroke="#fff" strokeWidth="2" aria-hidden="true">
          <rect x="2" y="2" width="18" height="18" />
          <path d="M2 20 20 2" />
        </svg>
        Arkitekt.ai
      </div>

      <header className="hero">
        <h1>Sketch your agent. Download the project.</h1>
        <p>Choose a language, a framework, a model and what the agent should include. You get a folder that installs and runs.</p>
      </header>

      <div className="layout">
        <form onSubmit={(e) => e.preventDefault()}>
          <fieldset>
            <legend>Project</legend>
            <label className="text">
              <span>Name</span>
              <input
                className="mono"
                value={opts.name}
                onChange={(e) => set({ name: e.target.value })}
                aria-invalid={!valid}
                aria-describedby={valid ? undefined : "name-error"}
                spellCheck={false}
              />
            </label>
            {!valid && (
              <p id="name-error" className="error">
                Start with a lowercase letter, then use letters, digits or hyphens.
              </p>
            )}
            <label className="text">
              <span>Description</span>
              <input value={opts.description} onChange={(e) => set({ description: e.target.value })} />
            </label>
          </fieldset>

          <fieldset>
            <legend>Language</legend>
            {catalog.languages.map((l) => (
              <label key={l.id} className="opt">
                <input type="radio" name="language" checked={opts.language === l.id} onChange={() => setLanguage(l.id as Options["language"])} />
                <span className="box" />
                <span>
                  <span className="name">{l.name}</span>
                  <span className="desc">{l.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend>Agent framework</legend>
            {frameworksFor(opts.language).map((f) => (
              <label key={f.id} className="opt">
                <input type="radio" name="framework" checked={opts.framework === f.id} onChange={() => set({ framework: f.id as Options["framework"] })} />
                <span className="box" />
                <span>
                  <span className="name">{f.name}</span>
                  <span className="desc">{f.description}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend>Model</legend>
            {catalog.providers.map((p) => (
              <label key={p.id} className="opt">
                <input type="radio" name="provider" checked={opts.provider === p.id} onChange={() => setProvider(p.id as Options["provider"])} />
                <span className="box" />
                <span>
                  <span className="name">{p.name}</span>
                  <span className="desc">{p.description}</span>
                </span>
              </label>
            ))}
            <label className="text" style={{ marginTop: 12 }}>
              <span>Default model</span>
              <select value={opts.model} onChange={(e) => set({ model: e.target.value })}>
                {catalog.models[opts.provider].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset>
            <legend>Include</legend>
            {catalog.capabilities.map((c) => (
              <label key={c.id} className="opt">
                <input type="checkbox" checked={opts.capabilities.includes(c.id as Capability)} onChange={() => toggle(c.id as Capability)} />
                <span className="box" />
                <span>
                  <span className="name">{c.name}</span>
                  <span className="desc">{c.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </form>

        <div className="sheet-wrap">
          <div className="sheet">
            <div className="bar">
              <b>{valid ? opts.name : "—"}/</b>
              <span>{valid ? `${paths.length} files` : ""}</span>
            </div>
            <div className="tree" key={treeKey}>
              {valid && rows.length > 1 ? (
                rows.map((r, i) => {
                  const pad = Array.from({ length: r.depth }, (_, d) => <span key={d} className="g" />);
                  const style = { "--i": i } as React.CSSProperties;
                  return r.path ? (
                    <button
                      key={r.path}
                      type="button"
                      className={`row file ${r.path === current ? "sel" : ""}`}
                      style={style}
                      onClick={() => setSelected(r.path!)}
                      aria-pressed={r.path === current}
                    >
                      {pad}
                      {r.label}
                    </button>
                  ) : (
                    <div key={r.label + i} className="row dir" style={style}>
                      {pad}
                      {r.label}
                    </div>
                  );
                })
              ) : (
                <p className="empty">Fix the project name to see its files.</p>
              )}
            </div>
            {valid && current && (
              <div className="code">
                <div className="code-head">
                  <span>{current}</span>
                  <button type="button" className="ghost" onClick={() => copy("file", files[current])}>
                    {copied === "file" ? "Copied" : "Copy file"}
                  </button>
                </div>
                <pre tabIndex={0}>
                  <code>{files[current]}</code>
                </pre>
              </div>
            )}
            <dl className="stats">
              <div>
                <dt>Project</dt>
                <dd>{valid ? opts.name : "—"}</dd>
              </div>
              <div>
                <dt>Stack</dt>
                <dd>
                  {languageName} · {frameworkName}
                </dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{modelName}</dd>
              </div>
              <div>
                <dt>Files</dt>
                <dd>{valid ? paths.length : "—"}</dd>
              </div>
            </dl>
          </div>

          <button className="go" disabled={!valid || busy} onClick={generate}>
            {busy ? "Generating…" : `Download ${valid ? opts.name : "project"}.zip`}
          </button>
          {error && <p className="fail" role="alert">{error}</p>}

          <div className="share">
            <button type="button" className="ghost" onClick={() => copy("link", window.location.href)}>
              {copied === "link" ? "Link copied" : "Copy link to this setup"}
            </button>
            <button type="button" className="ghost" disabled={!valid} onClick={() => copy("cmd", command)}>
              {copied === "cmd" ? "Command copied" : "Copy curl command"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
