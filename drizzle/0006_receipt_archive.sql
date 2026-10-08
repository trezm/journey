CREATE TABLE `receipt_archive` (
	`project` text NOT NULL,
	`receipt_key` text NOT NULL,
	`part` integer NOT NULL,
	`parts` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`project`, `receipt_key`, `part`)
);
