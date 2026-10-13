'use client';

import { ThemeProvider as NextThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

export function ThemeProvider({ children }: { children: ReactNode }) {
    return <NextThemeProvider attribute="class" themes={['light', 'dark', 'halloween']} defaultTheme="system" enableSystem disableTransitionOnChange>{children}</NextThemeProvider>;
}
