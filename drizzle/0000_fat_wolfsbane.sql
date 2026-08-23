CREATE TABLE `manganafer_interests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`phone` text NOT NULL,
	`municipality` text NOT NULL,
	`postal_code` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`participant_profile` text DEFAULT '' NOT NULL,
	`roof_surface_range` text DEFAULT '' NOT NULL,
	`roof_relationship` text DEFAULT '' NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`consent_version` text DEFAULT '2026-07-31' NOT NULL,
	`source` text DEFAULT 'manganafer-landing' NOT NULL,
	`status` text DEFAULT 'nuevo' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `manganafer_interests_email_kind_unique` ON `manganafer_interests` (`email`,`kind`);--> statement-breakpoint
CREATE INDEX `manganafer_interests_created_at_idx` ON `manganafer_interests` (`created_at`);--> statement-breakpoint
CREATE INDEX `manganafer_interests_kind_idx` ON `manganafer_interests` (`kind`);
