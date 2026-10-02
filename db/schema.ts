import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const projects = sqliteTable('projects', { id: text('id').primaryKey(), owner: text('owner').notNull(), name: text('name').notNull(), version: integer('version').notNull().default(0), state: text('state').notNull() }, t => [index('idx_projects_owner').on(t.owner)]);
export const users = sqliteTable('users', { id: text('id').primaryKey(), email: text('email').notNull().unique(), password: text('password').notNull() });
export const sessions = sqliteTable('sessions', { digest: text('digest').primaryKey(), user: text('user').notNull(), expires: integer('expires').notNull() });
export const agents = sqliteTable('agents', { digest: text('digest').primaryKey(), project: text('project').notNull(), name: text('name').notNull(), role: text('role').notNull().default('worker'), created: integer('created').notNull() });
export const attempts = sqliteTable('auth_attempts', { key: text('key').primaryKey(), count: integer('count').notNull(), reset: integer('reset').notNull() });
