CREATE TABLE `oauth_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user` text NOT NULL,
	`provider` text NOT NULL,
	`provider_user` text NOT NULL,
	`username` text NOT NULL,
	`credential` text NOT NULL,
	`updated` integer NOT NULL,
	`refresh_lock` text,
	`refresh_until` integer,
	CONSTRAINT "oauth_connections_provider_check" CHECK("oauth_connections"."provider" in ('github', 'gitlab'))
);

--> statement-breakpoint
CREATE UNIQUE INDEX `idx_oauth_connections_user_provider` ON `oauth_connections` (`user`,`provider`);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`digest` text PRIMARY KEY NOT NULL,
	`user` text NOT NULL,
	`session` text NOT NULL,
	`provider` text NOT NULL,
	`project` text NOT NULL,
	`verifier` text NOT NULL,
	`expires` integer NOT NULL,
	CONSTRAINT "oauth_states_provider_check" CHECK("oauth_states"."provider" in ('github', 'gitlab'))
);

--> statement-breakpoint
CREATE INDEX `idx_oauth_states_expires` ON `oauth_states` (`expires`);
