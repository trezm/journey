import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeSwitch } from "@/components/theme-switch";

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
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          {children}
          <ThemeSwitch />
        </ThemeProvider>
      </body>
    </html>
  );
}
