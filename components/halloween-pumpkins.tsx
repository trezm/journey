'use client';

import { useState, useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import styles from './halloween-pumpkins.module.css';

const STORAGE_KEY = 'journey-pumpkins';
const preferenceEvent = 'journey-pumpkins-change';
const subscribe = (listener: () => void) => {
    window.addEventListener('storage', listener);
    window.addEventListener(preferenceEvent, listener);
    return () => {
        window.removeEventListener('storage', listener);
        window.removeEventListener(preferenceEvent, listener);
    };
};
const readPreference = () => {
    try {
        const value = window.localStorage.getItem(STORAGE_KEY);
        return value === 'on' || value === 'off' ? value : 'auto';
    } catch { return 'auto'; }
};

function Pumpkin({ small = false }: { small?: boolean }) {
    return <svg viewBox="0 0 100 94" className={small ? styles.smallPumpkin : styles.pumpkin} aria-hidden="true" focusable="false">
        <path d="M47 22 Q42 11 49 5 L57 7 Q49 14 55 24" fill="#658448" />
        <path d="M54 23 Q65 10 76 18 Q69 29 54 23" fill="#7d9b53" />
        <ellipse cx="50" cy="86" rx="38" ry="4" fill="currentColor" opacity=".08" />
        <ellipse cx="29" cy="53" rx="23" ry="31" fill="#da651b" />
        <ellipse cx="71" cy="53" rx="23" ry="31" fill="#df6c1d" />
        <ellipse cx="39" cy="53" rx="22" ry="33" fill="#f08a28" />
        <ellipse cx="62" cy="53" rx="22" ry="33" fill="#f18c29" />
        <ellipse cx="50" cy="53" rx="19" ry="34" fill="#ffa43c" />
        <path d="M27 48 L40 35 L43 49 Z M57 49 L61 35 L75 48 Z" fill="#41272b" />
        <path d="M46 57 L51 49 L56 57 Z" fill="#41272b" />
        <path d={small ? 'M27 62 Q50 84 74 61 Q53 72 27 62' : 'M25 61 L37 67 L42 62 L48 71 L56 64 L62 68 L76 60 Q69 82 49 81 Q33 81 25 61'} fill="#41272b" />
        <path d="M31 46 L38 40 L39 47 Z M61 47 L63 40 L70 46 Z" fill="#ffdf83" />
    </svg>;
}

export function HalloweenPumpkins() {
    const { resolvedTheme } = useTheme();
    const [sessionPreference, setSessionPreference] = useState<'on' | 'off' | null>(null);
    const preference = useSyncExternalStore(subscribe, readPreference, () => 'auto');
    const mounted = useSyncExternalStore(subscribe, () => true, () => false);
    const choice = sessionPreference ?? preference;
    const visible = mounted && (choice === 'on' || (choice === 'auto' && resolvedTheme === 'halloween'));

    function toggle() {
        setSessionPreference(visible ? 'off' : 'on');
        try {
            window.localStorage.setItem(STORAGE_KEY, visible ? 'off' : 'on');
            window.dispatchEvent(new Event(preferenceEvent));
        } catch {
            // The current session still works when browser storage is unavailable.
        }
    }

    if (!mounted) return null;
    return <section className={styles.decorations} aria-label="Halloween decorations">
        <button type="button" className={styles.toggle} aria-pressed={visible} onClick={toggle}>
            <span aria-hidden="true">✦</span><span>Pumpkins</span><span className={styles.toggleState}>{visible ? 'On' : 'Off'}</span>
        </button>
        {visible && <div className={styles.pair} aria-hidden="true"><Pumpkin /><Pumpkin small /></div>}
    </section>;
}
