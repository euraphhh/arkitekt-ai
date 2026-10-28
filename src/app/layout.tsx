import "./globals.css";
import { Inter, JetBrains_Mono } from "next/font/google";

const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");

export const metadata = {
  metadataBase: new URL(siteUrl),
  title: "Arkitekt.ai",
  description: "Pick a language, a framework, a model and a few capabilities. Download a ready-to-run AI agent project.",
  openGraph: {
    title: "Arkitekt.ai",
    description: "Sketch your agent. Download the project.",
    type: "website",
  },
  twitter: { card: "summary_large_image" as const, title: "Arkitekt.ai", description: "Sketch your agent. Download the project." },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
