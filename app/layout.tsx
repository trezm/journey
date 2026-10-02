import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Journey — Agentic Version Control",
  description: "Journey-based version control with recorded patches, renewable range locks, human review and durable agent inboxes.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
