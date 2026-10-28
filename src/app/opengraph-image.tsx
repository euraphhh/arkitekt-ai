import { ImageResponse } from "next/og";

export const alt = "Arkitekt.ai: generate an AI agent project";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          color: "#fff",
          background: "radial-gradient(ellipse 70% 80% at 50% 0%, #2a2d33 0%, #07080a 70%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 36, fontWeight: 600 }}>
          <svg width="44" height="44" viewBox="0 0 22 22" fill="none" stroke="#fff" strokeWidth="2">
            <rect x="2" y="2" width="18" height="18" />
            <path d="M2 20 20 2" />
          </svg>
          Arkitekt.ai
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 92, fontWeight: 600, lineHeight: 1.02, letterSpacing: -3, textShadow: "0 0 40px rgba(255,255,255,0.4)" }}>
            Sketch your agent. Download the project.
          </div>
          <div style={{ fontSize: 34, color: "#8b9098" }}>Python or TypeScript. Anthropic, OpenAI or Ollama.</div>
        </div>
      </div>
    ),
    size,
  );
}
