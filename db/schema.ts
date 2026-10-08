import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex, check, primaryKey } from 'drizzle-orm/sqlite-core';
export const projects = sqliteTable('projects', { id: text('id').primaryKey(), owner: text('owner').notNull(), name: text('name').notNull(), visibility: text('visibility', { enum: ['private', 'public'] }).notNull().default('private'), version: integer('version').notNull().default(0), state: text('state').notNull() }, t => [index('idx_projects_owner').on(t.owner), index('idx_projects_visibility').on(t.visibility), check('projects_visibility_check', sql`${t.visibility} in ('private', 'public')`)]);
export const users = sqliteTable('users', { id: text('id').primaryKey(), username: text('username').notNull().unique(), email: text('email').notNull().unique(), password: text('password').notNull() });
export const sessions = sqliteTable('sessions', { digest: text('digest').primaryKey(), user: text('user').notNull(), expires: integer('expires').notNull() }, t => [index('idx_sessions_user_expires').on(t.user, t.expires)]);
export const agents = sqliteTable('agents', { digest: text('digest').primaryKey(), project: text('project').notNull(), name: text('name').notNull(), role: text('role').notNull().default('worker'), created: integer('created').notNull() });
export const attempts = sqliteTable('auth_attempts', { key: text('key').primaryKey(), count: integer('count').notNull(), reset: integer('reset').notNull() });

export const oauthStates = sqliteTable('oauth_states', {
    digest: text('digest').primaryKey(), user: text('user').notNull(), session: text('session').notNull(),
    provider: text('provider', { enum: ['github', 'gitlab'] }).notNull(), project: text('project').notNull(),
    verifier: text('verifier').notNull(), expires: integer('expires').notNull(),
}, t => [index('idx_oauth_states_expires').on(t.expires), check('oauth_states_provider_check', sql`${t.provider} in ('github', 'gitlab')`)]);
export const oauthConnections = sqliteTable('oauth_connections', {
    id: text('id').primaryKey(), user: text('user').notNull(), provider: text('provider', { enum: ['github', 'gitlab'] }).notNull(),
    providerUser: text('provider_user').notNull(), username: text('username').notNull(), credential: text('credential').notNull(),
    updated: integer('updated').notNull(), refreshLock: text('refresh_lock'), refreshUntil: integer('refresh_until'),
}, t => [uniqueIndex('idx_oauth_connections_user_provider').on(t.user, t.provider), check('oauth_connections_provider_check', sql`${t.provider} in ('github', 'gitlab')`)]);

// Retry receipts are immutable, split into bounded rows, and read only on retry.
export const receiptArchive = sqliteTable('receipt_archive', {
    project: text('project').notNull(), receiptKey: text('receipt_key').notNull(),
    part: integer('part').notNull(), parts: integer('parts').notNull(), payload: text('payload').notNull(),
}, t => [primaryKey({ columns: [t.project, t.receiptKey, t.part] })]);
