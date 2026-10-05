ALTER TABLE `projects` ADD `visibility` text DEFAULT 'private' NOT NULL CONSTRAINT `projects_visibility_check` CHECK (`visibility` IN ('private', 'public'));
--> statement-breakpoint
CREATE INDEX `idx_projects_visibility` ON `projects` (`visibility`);
