'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Ghost, Monitor, Moon, Sun } from 'lucide-react';
import styles from './theme-switch.module.css';

const subscribe = () => () => {};

export function ThemeSwitch() {
    const { theme, setTheme } = useTheme();
    const mounted = useSyncExternalStore(subscribe, () => true, () => false);

    if (!mounted) return null;
    const selected = theme === 'light' || theme === 'dark' || theme === 'halloween' ? theme : 'system';
    const Icon = selected === 'halloween' ? Ghost : selected === 'system' ? Monitor : selected === 'dark' ? Moon : Sun;

    return <label className={styles.switch}>
        <Icon size={16} aria-hidden="true" />
        <span className={styles.label}>Theme</span>
        <select aria-label="Color theme" value={selected} onChange={event => setTheme(event.target.value)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="halloween">Halloween</option>
        </select>
    </label>;
}
