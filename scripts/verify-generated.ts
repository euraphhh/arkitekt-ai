// Generates a project, installs it and runs its checks.
// Usage: tsx scripts/verify-generated.ts <language> <framework> <provider> <all|min>
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalog, defaultModel, parseOptions, type Capability } from "../src/lib/catalog";
import { generateFiles } from "../src/lib/generate";

const [language, framework, provider, caps] = process.argv.slice(2);
const capabilities: Capability[] =
  caps === "min" ? ["tests"] : (catalog.capabilities.map((c) => c.id) as Capability[]);

const options = parseOptions({
  name: "demo-agent",
  language,
  framework,
  provider,
  model: defaultModel(provider as never),
  capabilities,
});
if (!options) {
  console.error(`Invalid combination: ${process.argv.slice(2).join(" ")}`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "arkitekt-verify-"));
const dir = join(root, options.name);
for (const [path, content] of Object.entries(generateFiles(options))) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}
console.log(`Generated ${language}/${framework}/${provider}/${caps} in ${dir}`);

const env = { ...process.env, ANTHROPIC_API_KEY: "test", OPENAI_API_KEY: "test" };
function run(cmd: string, args: string[]) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: dir, stdio: "inherit", env, shell: process.platform === "win32" && /^np[mx]$/.test(cmd) });
  if (r.status !== 0) {
    console.error(`FAILED: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

if (language === "python") {
  const pkg = options.name.replace(/-/g, "_");
  const py = join(dir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  run("python", ["-m", "venv", ".venv"]);
  run(py, ["-m", "pip", "install", "-q", "-e", "."]);
  run(py, ["-m", "compileall", "-q", "src"]);
  run(py, ["-c", `import ${pkg}.agent` + (options.capabilities.includes("http") ? `, ${pkg}.server` : "")]);
  run(py, ["-m", "pytest", "-q"]);
} else {
  run("npm", ["install", "--no-audit", "--no-fund"]);
  run("npx", ["tsc", "--noEmit"]);
  run("npm", ["test"]);
}
console.log("\nOK");
