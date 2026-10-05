import { authorize, authenticationMode } from '@/lib/avc/auth';
import { insist, ProtocolError } from '@/lib/avc/core';
import { completeOAuth, consumeState, oauthConfig, provider, sessionBinding } from '@/lib/avc/oauth';

export const dynamic = 'force-dynamic';
export async function GET(req: Request, context: { params: Promise<{ provider: string }> }) {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    let destination: URL | undefined;
    try {
        const p = provider((await context.params).provider), config = oauthConfig(p), url = new URL(req.url);
        insist(url.origin === config.origin, 'origin_denied', 'The callback origin does not match this deployment.', 403);
        const user = await authorize(req); insist(!user.agent, 'forbidden', 'Sign in as the account owner.', 403);
        const state = await consumeState(p, url.searchParams.get('state') ?? '', user.id, await sessionBinding(req, authenticationMode() === 'access'));
        await authorize(req, state.project);
        destination = new URL('/settings', config.origin); destination.searchParams.set('project', state.project);
        insist(!url.searchParams.has('error'), 'oauth_denied', 'Provider authorization was cancelled.', 400);
        await completeOAuth(p, user.id, url.searchParams.get('code') ?? '', state.verifier);
        destination.searchParams.set('oauth', 'connected');
        return new Response(null, { status: 303, headers: { ...headers, Location: destination.href } });
    } catch (error) {
        if (destination) { destination.searchParams.set('oauth', 'failed'); return new Response(null, { status: 303, headers: { ...headers, Location: destination.href } }); }
        return Response.json({ error: error instanceof ProtocolError ? error.message : 'Provider connection failed. Return to repository settings and try again.' }, { status: error instanceof ProtocolError ? error.status : 500, headers });
    }
}
