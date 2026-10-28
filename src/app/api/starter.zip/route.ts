import { parseOptions } from "@/lib/catalog";
import { generateFiles, generateZip } from "@/lib/generate";

export const runtime = "nodejs";

async function read(req: Request) {
  return parseOptions(await req.json().catch(() => null));
}

// POST /api/starter.zip -> zip file
export async function POST(req: Request) {
  const options = await read(req);
  if (!options) return Response.json({ error: "Invalid options" }, { status: 400 });
  const body = await generateZip(options);
  return new Response(body as BodyInit, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${options.name}.zip"`,
    },
  });
}

// PUT /api/starter.zip -> every generated file with its content (JSON), for the preview
export async function PUT(req: Request) {
  const options = await read(req);
  if (!options) return Response.json({ error: "Invalid options" }, { status: 400 });
  return Response.json({ files: generateFiles(options) });
}
