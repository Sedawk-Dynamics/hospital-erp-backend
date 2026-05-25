-- Drop lab departments entirely. The concept is being removed from the
-- product; lab tests, orders, and templates no longer carry a department
-- reference. This migration is destructive — every existing dept row and
-- every FK pointing at one is removed.

-- DropForeignKey
ALTER TABLE "lab_test_catalog" DROP CONSTRAINT IF EXISTS "lab_test_catalog_lab_department_id_fkey";

-- DropForeignKey
ALTER TABLE "lab_orders" DROP CONSTRAINT IF EXISTS "lab_orders_assigned_dept_id_fkey";

-- DropForeignKey
ALTER TABLE "lab_departments" DROP CONSTRAINT IF EXISTS "lab_departments_tenant_id_fkey";

-- AlterTable
ALTER TABLE "lab_test_catalog" DROP COLUMN IF EXISTS "lab_department_id";

-- AlterTable
ALTER TABLE "lab_orders" DROP COLUMN IF EXISTS "assigned_dept_id";

-- AlterTable
ALTER TABLE "lab_test_templates" DROP COLUMN IF EXISTS "department_name";

-- DropTable
DROP TABLE IF EXISTS "lab_departments";
