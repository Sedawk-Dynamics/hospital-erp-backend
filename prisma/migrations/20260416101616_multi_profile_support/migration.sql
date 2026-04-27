/*
  Warnings:

  - You are about to drop the column `is_follow_up` on the `appointments` table. All the data in the column will be lost.
  - You are about to drop the column `parent_appointment_id` on the `appointments` table. All the data in the column will be lost.
  - You are about to drop the column `icd_code_id` on the `diagnoses` table. All the data in the column will be lost.
  - You are about to drop the column `verification_token` on the `patient_family_history` table. All the data in the column will be lost.
  - You are about to drop the column `verification_token_expires_at` on the `patient_family_history` table. All the data in the column will be lost.
  - You are about to drop the column `verified` on the `patient_family_history` table. All the data in the column will be lost.
  - You are about to drop the column `verified_at` on the `patient_family_history` table. All the data in the column will be lost.
  - You are about to drop the column `meal_relation` on the `prescription_items` table. All the data in the column will be lost.
  - You are about to drop the column `follow_up_duration` on the `prescriptions` table. All the data in the column will be lost.
  - You are about to drop the column `follow_up_duration_unit` on the `prescriptions` table. All the data in the column will be lost.
  - You are about to drop the column `follow_up_notes` on the `prescriptions` table. All the data in the column will be lost.
  - You are about to drop the column `hide_from_patient` on the `progress_notes` table. All the data in the column will be lost.
  - You are about to drop the column `additional_notes` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the column `advice` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the column `general_examination` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the column `referral_notes` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the column `systemic_examination` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the `icd_codes` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "PatientRelationship" AS ENUM ('self', 'spouse', 'child', 'parent', 'sibling', 'guardian', 'other');

-- DropForeignKey
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_parent_appointment_id_fkey";

-- DropForeignKey
ALTER TABLE "diagnoses" DROP CONSTRAINT "diagnoses_icd_code_id_fkey";

-- DropIndex
DROP INDEX "appointments_parent_appointment_id_idx";

-- DropIndex
DROP INDEX "patient_family_history_verification_token_key";

-- DropIndex
DROP INDEX "patients_user_id_key";

-- AlterTable
ALTER TABLE "appointments" DROP COLUMN "is_follow_up",
DROP COLUMN "parent_appointment_id";

-- AlterTable
ALTER TABLE "diagnoses" DROP COLUMN "icd_code_id";

-- AlterTable
ALTER TABLE "patient_family_history" DROP COLUMN "verification_token",
DROP COLUMN "verification_token_expires_at",
DROP COLUMN "verified",
DROP COLUMN "verified_at";

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "is_self" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "relationship" "PatientRelationship" NOT NULL DEFAULT 'self';

-- AlterTable
ALTER TABLE "prescription_items" DROP COLUMN "meal_relation";

-- AlterTable
ALTER TABLE "prescriptions" DROP COLUMN "follow_up_duration",
DROP COLUMN "follow_up_duration_unit",
DROP COLUMN "follow_up_notes";

-- AlterTable
ALTER TABLE "progress_notes" DROP COLUMN "hide_from_patient";

-- AlterTable
ALTER TABLE "visits" DROP COLUMN "additional_notes",
DROP COLUMN "advice",
DROP COLUMN "general_examination",
DROP COLUMN "referral_notes",
DROP COLUMN "systemic_examination";

-- DropTable
DROP TABLE "icd_codes";

-- DropEnum
DROP TYPE "MealRelation";
