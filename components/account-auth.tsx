'use client';
import { useState, type FormEvent } from 'react';
import { GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function AccountAuth({ onAuthenticated, initialError = '' }: { onAuthenticated: () => void | Promise<void>; initialError?: string }) {
    const [register, setRegister] = useState(false), [username, setUsername] = useState(''), [email, setEmail] = useState(''), [identifier, setIdentifier] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(initialError);
    async function authenticate(event: FormEvent<HTMLFormElement>) {
        event.preventDefault(); setBusy(true); setError('');
        try {
            const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(register ? { action: 'register', username, email, password } : { action: 'login', identifier, password }) });
            const result = await response.json() as { error?: string };
            if (!response.ok) throw new Error(result.error ?? 'Unable to sign in. Try again.');
            setPassword('');
            await onAuthenticated();
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to sign in. Try again.'); }
        finally { setBusy(false); }
    }
    return <main className="auth"><div className="auth-card">
        <div className="wordmark"><span className="brand-icon"><GitBranch /></span>Journey<span className="version">EARLY ACCESS</span></div>
        <h1>{register ? 'Create your account.' : 'Open your workspace.'}</h1><p>Coordinate changes. Preserve the journey.</p>
        <form onSubmit={authenticate}>
            {register ? <><label>Username<input required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{2,31}" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} /></label><p className="small">3–32 letters, numbers, underscores or hyphens.</p><label>Email<input type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" /></label></> : <label>Username or email<input required maxLength={254} value={identifier} onChange={event => setIdentifier(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} /></label>}
            <label>Password<input type="password" required minLength={12} maxLength={256} value={password} onChange={event => setPassword(event.target.value)} autoComplete={register ? 'new-password' : 'current-password'} /></label>
            {register && <p className="small">Use 12–256 characters. Each account owns its own repositories.</p>}
            {error && <p className="error" role="alert">{error}</p>}
            <Button type="submit" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}</Button>
        </form>
        <button className="text-button" disabled={busy} onClick={() => { setRegister(!register); setError(''); setPassword(''); }}>{register ? 'Already have an account? Sign in' : 'Create an account'}</button>
    </div></main>;
}
