import { deflateSync, inflateSync } from 'node:zlib';
import { insist, ProtocolError, type State } from './core.ts';

export const MAX_STATE_BYTES = 12_000_000;
export const MAX_STORED_STATE_BYTES = 1_500_000;
const encoding = 'deflate-base64-v1';

export function encodeState(state: State): string {
    const json = JSON.stringify(state), bytes = Buffer.from(json, 'utf8');
    insist(bytes.length < MAX_STATE_BYTES, 'project_capacity', 'Repository metadata capacity reached. Export the repository.', 413);
    if (bytes.length < MAX_STORED_STATE_BYTES) return json;
    // Keep all history and idempotency receipts. Repeated lease snapshots are
    // highly compressible and should not prevent approval or integration.
    const stored = JSON.stringify({ journeyStateEncoding: encoding, data: deflateSync(bytes).toString('base64') });
    insist(Buffer.byteLength(stored, 'utf8') < MAX_STORED_STATE_BYTES, 'project_capacity', 'Repository metadata capacity reached. Export the repository.', 413);
    return stored;
}

export function decodeState(stored: string): State {
    let value;
    try { value = JSON.parse(stored); }
    catch { throw new ProtocolError('invalid_state', 'Stored repository metadata is malformed.', 500); }
    if (value?.journeyStateEncoding !== undefined) {
        insist(value.journeyStateEncoding === encoding && typeof value.data === 'string' && value.data.length > 0 && value.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data), 'invalid_state', 'Stored repository metadata uses an invalid encoding.', 500);
        const compressed = Buffer.from(value.data, 'base64');
        insist(compressed.toString('base64') === value.data, 'invalid_state', 'Stored repository metadata uses an invalid encoding.', 500);
        let bytes;
        try { bytes = inflateSync(compressed, { maxOutputLength: MAX_STATE_BYTES }); }
        catch (error) {
            if (error instanceof RangeError) throw new ProtocolError('project_capacity', 'Repository metadata capacity reached. Export the repository.', 413);
            throw new ProtocolError('invalid_state', 'Stored repository metadata could not be decoded.', 500);
        }
        insist(bytes.length < MAX_STATE_BYTES, 'project_capacity', 'Repository metadata capacity reached. Export the repository.', 413);
        try { value = JSON.parse(bytes.toString('utf8')); }
        catch { throw new ProtocolError('invalid_state', 'Decoded repository metadata is malformed.', 500); }
    } else {
        insist(Buffer.byteLength(stored, 'utf8') < MAX_STATE_BYTES, 'project_capacity', 'Repository metadata capacity reached. Export the repository.', 413);
    }
    insist(value && typeof value === 'object' && typeof value.id === 'string' && Array.isArray(value.leases) && Array.isArray(value.journeys) && value.receipts && typeof value.receipts === 'object', 'invalid_state', 'Stored repository metadata is malformed.', 500);
    return value as State;
}
