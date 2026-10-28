import JSZip from "jszip";
import type { Options } from "./catalog";
import { pythonProject } from "./generators/python";
import { typescriptProject } from "./generators/typescript";

export function generateFiles(o: Options): Record<string, string> {
  return o.language === "python" ? pythonProject(o) : typescriptProject(o);
}

export async function generateZip(o: Options): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(generateFiles(o))) {
    zip.file(`${o.name}/${path}`, content);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
