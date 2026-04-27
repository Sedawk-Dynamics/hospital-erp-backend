-- CreateTable
CREATE TABLE "doctor_schedule_overrides" (
    "id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "is_day_off" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_schedule_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_override_shifts" (
    "id" TEXT NOT NULL,
    "override_id" TEXT NOT NULL,
    "start_time" TIME NOT NULL,
    "end_time" TIME NOT NULL,
    "slot_duration_minutes" INTEGER NOT NULL DEFAULT 15,
    "max_patients" INTEGER,

    CONSTRAINT "doctor_override_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "doctor_schedule_overrides_doctor_id_date_key" ON "doctor_schedule_overrides"("doctor_id", "date");

-- AddForeignKey
ALTER TABLE "doctor_schedule_overrides"
  ADD CONSTRAINT "doctor_schedule_overrides_doctor_id_fkey"
  FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_override_shifts"
  ADD CONSTRAINT "doctor_override_shifts_override_id_fkey"
  FOREIGN KEY ("override_id") REFERENCES "doctor_schedule_overrides"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
