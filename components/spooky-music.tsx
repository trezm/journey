'use client';

import { useEffect, useRef, useState } from 'react';
import { Music2 } from 'lucide-react';
import styles from './spooky-music.module.css';

type Ambience = { context: AudioContext; master: GainNode; timer: ReturnType<typeof setInterval> };

// An original minor-key music box and soft, wavering drone. No downloaded audio.
function createAmbience(context: AudioContext, volume: number): Ambience {
    const master = context.createGain();
    master.gain.setValueAtTime(volume, context.currentTime);
    master.connect(context.destination);

    const drone = context.createOscillator();
    const droneGain = context.createGain();
    const tremolo = context.createOscillator();
    const tremoloDepth = context.createGain();
    drone.type = 'sine';
    drone.frequency.value = 110;
    droneGain.gain.value = 0.035;
    tremolo.frequency.value = 0.18;
    tremoloDepth.gain.value = 0.012;
    tremolo.connect(tremoloDepth).connect(droneGain.gain);
    drone.connect(droneGain).connect(master);
    drone.start();
    tremolo.start();

    const notes = [440, 523.25, 622.25, 587.33, 523.25, 415.3, 493.88, 440];
    let step = 0;
    let nextNote = context.currentTime + 0.1;
    const schedule = () => {
        while (nextNote < context.currentTime + 0.4) {
            const bell = context.createOscillator();
            const envelope = context.createGain();
            bell.type = 'sine';
            bell.frequency.value = notes[step % notes.length];
            envelope.gain.setValueAtTime(0, nextNote);
            envelope.gain.linearRampToValueAtTime(0.08, nextNote + 0.015);
            envelope.gain.exponentialRampToValueAtTime(0.0001, nextNote + 1.6);
            bell.connect(envelope).connect(master);
            bell.start(nextNote);
            bell.stop(nextNote + 1.7);
            bell.onended = () => { bell.disconnect(); envelope.disconnect(); };
            nextNote += 0.85;
            step += 1;
        }
    };
    schedule();
    return { context, master, timer: setInterval(schedule, 100) };
}

export function SpookyMusic() {
    const audio = useRef<Ambience | null>(null);
    const pending = useRef<AudioContext | null>(null);
    const volumeRef = useRef(0.35);
    const [volume, setVolume] = useState(35);
    const [playing, setPlaying] = useState(false);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState('');

    const dispose = () => {
        if (audio.current) {
            clearInterval(audio.current.timer);
            void audio.current.context.close().catch(() => {});
            audio.current = null;
        }
        if (pending.current) {
            void pending.current.close().catch(() => {});
            pending.current = null;
        }
    };

    useEffect(() => {
        const stopWhenAway = () => {
            if (document.hidden) {
                dispose();
                setPlaying(false);
                setStarting(false);
            }
        };
        const stopOnExit = () => { dispose(); setPlaying(false); setStarting(false); };
        document.addEventListener('visibilitychange', stopWhenAway);
        window.addEventListener('pagehide', stopOnExit);
        return () => {
            document.removeEventListener('visibilitychange', stopWhenAway);
            window.removeEventListener('pagehide', stopOnExit);
            dispose();
        };
    }, []);

    const toggle = async () => {
        if (audio.current) {
            dispose();
            setPlaying(false);
            return;
        }
        if (pending.current) return;
        setError('');
        const Audio = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Audio) {
            setError('Spooky music is unavailable in this browser.');
            return;
        }
        setStarting(true);
        try {
            const context = new Audio();
            pending.current = context;
            await context.resume();
            // A tab hide or unmount can cancel an in-flight start.
            if (pending.current !== context) return;
            if (context.state !== 'running') throw new Error('Audio did not start');
            audio.current = createAmbience(context, volumeRef.current);
            pending.current = null;
            setPlaying(true);
        } catch {
            dispose();
            setError('Could not start music. Try Play again.');
        } finally {
            setStarting(false);
        }
    };

    const changeVolume = (value: number) => {
        setVolume(value);
        volumeRef.current = value / 100;
        if (audio.current) {
            audio.current.master.gain.setTargetAtTime(value / 100, audio.current.context.currentTime, 0.05);
        }
    };

    return <aside className={styles.player} aria-label="Halloween music">
        <div className={styles.heading}><Music2 size={15} aria-hidden="true" /><span>Spooky music</span></div>
        <div className={styles.controls}>
            <button type="button" onClick={() => void toggle()} disabled={starting} aria-pressed={playing}>
                {starting ? 'Starting…' : playing ? 'Stop' : 'Play'}
            </button>
            <label className={styles.volume}>Volume
                <input type="range" min="0" max="100" value={volume} onChange={event => changeVolume(Number(event.target.value))} aria-label="Spooky music volume" aria-valuetext={`${volume}%`} />
            </label>
        </div>
        <span className={styles.status} role="status">{error || (playing ? (volume === 0 ? 'Playing · muted' : 'Playing · original ambience') : 'Off · play to set the mood')}</span>
    </aside>;
}
