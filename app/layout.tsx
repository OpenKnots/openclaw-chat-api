import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://claw-api.openknot.ai";

export const metadata: Metadata = {
  title: "OpenClaw | Documentation Assistant",
  description: "RAG-based documentation assistant for OpenClaw",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='none' stroke='white' stroke-width='4'/><path d='M30 50 Q50 30 70 50 Q50 70 30 50' fill='none' stroke='white' stroke-width='3'/></svg>",
  },
  openGraph: {
    images: [`${baseUrl}/og-image.png`],
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenClaw | Documentation Assistant",
    description: "RAG-based documentation assistant for OpenClaw",
    images: [`${baseUrl}/og-image.png`],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
