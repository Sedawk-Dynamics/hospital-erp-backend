-- Rename EsiTriagePriority enum values in place (no data loss).
-- red->resuscitation, orange->emergent, yellow->urgent, green->non_urgent
ALTER TYPE "EsiTriagePriority" RENAME VALUE 'red'    TO 'resuscitation';
ALTER TYPE "EsiTriagePriority" RENAME VALUE 'orange' TO 'emergent';
ALTER TYPE "EsiTriagePriority" RENAME VALUE 'yellow' TO 'urgent';
ALTER TYPE "EsiTriagePriority" RENAME VALUE 'green'  TO 'non_urgent';
