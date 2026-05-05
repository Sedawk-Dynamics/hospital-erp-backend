-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentMethod" AS ENUM ('manual', 'autopay');

-- CreateEnum
CREATE TYPE "LoginStatus" AS ENUM ('success', 'failed');

-- CreateEnum
CREATE TYPE "WardType" AS ENUM ('general', 'semi_private', 'private', 'icu', 'nicu', 'picu', 'emergency');

-- CreateEnum
CREATE TYPE "BedType" AS ENUM ('standard', 'electric', 'icu', 'pediatric', 'bariatric');

-- CreateEnum
CREATE TYPE "BedStatus" AS ENUM ('available', 'occupied', 'maintenance', 'reserved');

-- CreateEnum
CREATE TYPE "OtStatus" AS ENUM ('available', 'in_use', 'maintenance');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('ventilator', 'oxygen_cylinder', 'monitor', 'defibrillator', 'infusion_pump', 'other');

-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('available', 'in_use', 'maintenance', 'decommissioned');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other');

-- CreateEnum
CREATE TYPE "PatientRelationship" AS ENUM ('self', 'spouse', 'child', 'parent', 'sibling', 'guardian', 'other');

-- CreateEnum
CREATE TYPE "SmokingStatus" AS ENUM ('never', 'former', 'current');

-- CreateEnum
CREATE TYPE "AlcoholConsumption" AS ENUM ('none', 'occasional', 'moderate', 'heavy');

-- CreateEnum
CREATE TYPE "RelationSide" AS ENUM ('maternal', 'paternal');

-- CreateEnum
CREATE TYPE "AllergyType" AS ENUM ('drug', 'food', 'environmental', 'other');

-- CreateEnum
CREATE TYPE "AllergySeverity" AS ENUM ('mild', 'moderate', 'severe', 'life_threatening');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('referral_letter', 'external_report', 'id_proof', 'consent_form', 'insurance_card', 'other');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('treatment', 'surgical', 'data_sharing', 'research', 'general');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('pending', 'given', 'revoked');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('push', 'pull');

-- CreateEnum
CREATE TYPE "AbhaSyncRecordType" AS ENUM ('prescription', 'lab_report', 'discharge_summary', 'imaging_report', 'immunization');

-- CreateEnum
CREATE TYPE "AbhaSyncStatus" AS ENUM ('pending', 'in_progress', 'success', 'failed');

-- CreateEnum
CREATE TYPE "PatientType" AS ENUM ('outpatient', 'inpatient');

-- CreateEnum
CREATE TYPE "RegistrationSource" AS ENUM ('self_signup', 'front_desk', 'admin');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('scheduled', 'walk_in');

-- CreateEnum
CREATE TYPE "VisitTypeAppt" AS ENUM ('new', 'revisit');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('pending_payment', 'booked', 'confirmed', 'checked_in', 'waiting', 'in_consultation', 'completed', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('waiting', 'checked_in', 'in_consultation', 'completed', 'skipped');

-- CreateEnum
CREATE TYPE "VisitType" AS ENUM ('op', 'ip');

-- CreateEnum
CREATE TYPE "VisitStatus" AS ENUM ('active', 'completed', 'transferred', 'discharged');

-- CreateEnum
CREATE TYPE "AdmissionStatus" AS ENUM ('admitted', 'discharged', 'transferred', 'absconded');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('reserved', 'confirmed', 'admitted', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "EstimationStatus" AS ENUM ('draft', 'finalized', 'approved', 'cancelled');

-- CreateEnum
CREATE TYPE "TransferType" AS ENUM ('doctor_to_doctor', 'ward_to_ward', 'bed_to_bed');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('requested', 'approved', 'completed', 'rejected');

-- CreateEnum
CREATE TYPE "DiagnosisType" AS ENUM ('primary', 'secondary', 'differential');

-- CreateEnum
CREATE TYPE "ProgressNoteType" AS ENUM ('complaint', 'vitals', 'investigation', 'discussion', 'impression', 'advice', 'general');

-- CreateEnum
CREATE TYPE "ProgressNoteStatus" AS ENUM ('active', 'finalized', 'archived');

-- CreateEnum
CREATE TYPE "DischargeSection" AS ENUM ('diagnosis', 'hospital_course', 'procedure', 'medication', 'follow_up', 'advice', 'general');

-- CreateEnum
CREATE TYPE "PhysicalObservationSystem" AS ENUM ('general', 'cardiovascular', 'respiratory', 'gastrointestinal', 'neurological', 'musculoskeletal', 'skin', 'ent', 'eye', 'genitourinary', 'psychiatric', 'other');

-- CreateEnum
CREATE TYPE "NursingNoteType" AS ENUM ('observation', 'wound_care', 'iv_line', 'intake_output', 'general');

-- CreateEnum
CREATE TYPE "IVLineType" AS ENUM ('peripheral', 'central_picc', 'central_subclavian', 'central_jugular', 'arterial', 'midline');

-- CreateEnum
CREATE TYPE "IVRemovalReason" AS ENUM ('completed', 'infiltration', 'phlebitis', 'dislodged', 'infection', 'scheduled_change');

-- CreateEnum
CREATE TYPE "IVLineStatus" AS ENUM ('active', 'removed', 'replaced');

-- CreateEnum
CREATE TYPE "IOEntryType" AS ENUM ('intake', 'output');

-- CreateEnum
CREATE TYPE "IOCategory" AS ENUM ('oral', 'iv_fluid', 'blood_product', 'tube_feed', 'urine', 'drain', 'vomit', 'stool', 'blood_loss', 'other');

-- CreateEnum
CREATE TYPE "WoundType" AS ENUM ('surgical', 'pressure_ulcer', 'laceration', 'burn', 'diabetic_ulcer', 'other');

-- CreateEnum
CREATE TYPE "WoundStage" AS ENUM ('stage_1', 'stage_2', 'stage_3', 'stage_4', 'unstageable');

-- CreateEnum
CREATE TYPE "ExudateType" AS ENUM ('none', 'serous', 'sanguineous', 'purulent');

-- CreateEnum
CREATE TYPE "ExudateAmount" AS ENUM ('none', 'scant', 'moderate', 'heavy');

-- CreateEnum
CREATE TYPE "WoundStatus" AS ENUM ('active', 'healing', 'healed', 'worsening');

-- CreateEnum
CREATE TYPE "ArrivalMode" AS ENUM ('ambulance', 'walk_in', 'wheelchair', 'stretcher', 'other');

-- CreateEnum
CREATE TYPE "ConsciousnessLevel" AS ENUM ('alert', 'drowsy', 'confused', 'unresponsive');

-- CreateEnum
CREATE TYPE "PainScale" AS ENUM ('numeric', 'faces', 'flacc', 'pqrst');

-- CreateEnum
CREATE TYPE "FallRiskLevel" AS ENUM ('low', 'moderate', 'high');

-- CreateEnum
CREATE TYPE "AvpuLevel" AS ENUM ('alert', 'voice', 'pain', 'unresponsive');

-- CreateEnum
CREATE TYPE "GeneralCondition" AS ENUM ('stable', 'critical', 'improving', 'deteriorating');

-- CreateEnum
CREATE TYPE "MobilityLevel" AS ENUM ('bedridden', 'assisted', 'independent');

-- CreateEnum
CREATE TYPE "ClinicalDeviceType" AS ENUM ('iv_cannula', 'central_line', 'urinary_catheter', 'oxygen_device', 'drain', 'ng_tube', 'other');

-- CreateEnum
CREATE TYPE "ClinicalDeviceStatus" AS ENUM ('active', 'removed', 'replaced');

-- CreateEnum
CREATE TYPE "DevicePatency" AS ENUM ('patent', 'blocked');

-- CreateEnum
CREATE TYPE "DeviceSiteCondition" AS ENUM ('normal', 'redness', 'swelling', 'infection', 'leakage');

-- CreateEnum
CREATE TYPE "DeviceSecurement" AS ENUM ('secure', 'loose');

-- CreateEnum
CREATE TYPE "DeviceFlowStatus" AS ENUM ('running', 'stopped');

-- CreateEnum
CREATE TYPE "UrineFlow" AS ENUM ('adequate', 'reduced', 'none');

-- CreateEnum
CREATE TYPE "UrineColor" AS ENUM ('clear', 'yellow', 'amber', 'dark', 'bloody');

-- CreateEnum
CREATE TYPE "OxygenMode" AS ENUM ('nasal_cannula', 'mask', 'venturi', 'rebreather', 'high_flow', 'none');

-- CreateEnum
CREATE TYPE "ProcedureStatus" AS ENUM ('successful', 'failed', 'partial');

-- CreateEnum
CREATE TYPE "ProcedureSide" AS ENUM ('left', 'right', 'midline');

-- CreateEnum
CREATE TYPE "ProcedureTolerance" AS ENUM ('well_tolerated', 'poorly_tolerated');

-- CreateEnum
CREATE TYPE "ProcedureComplication" AS ENUM ('none', 'bleeding', 'pain', 'infection_risk', 'other');

-- CreateEnum
CREATE TYPE "DischargeSummaryStatus" AS ENUM ('draft', 'finalized', 'published');

-- CreateEnum
CREATE TYPE "PrescriptionType" AS ENUM ('op', 'ip');

-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('active', 'dispensed', 'partially_dispensed', 'cancelled');

-- CreateEnum
CREATE TYPE "MedicationRoute" AS ENUM ('oral', 'iv', 'im', 'topical', 'sublingual', 'inhalation', 'other');

-- CreateEnum
CREATE TYPE "MedAdminStatus" AS ENUM ('given', 'missed', 'refused', 'held');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('routine', 'urgent', 'stat');

-- CreateEnum
CREATE TYPE "LabOrderStatus" AS ENUM ('ordered', 'sample_collected', 'in_transit', 'received', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "LabOrderItemStatus" AS ENUM ('pending', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "LabSampleStatus" AS ENUM ('collected', 'in_transit', 'received', 'processing', 'completed', 'rejected');

-- CreateEnum
CREATE TYPE "LabReportStatus" AS ENUM ('draft', 'review', 'approved', 'published', 'corrected');

-- CreateEnum
CREATE TYPE "LabResultStatus" AS ENUM ('entered', 'review', 'corrected', 'approved');

-- CreateEnum
CREATE TYPE "ImagingType" AS ENUM ('xray', 'mri', 'ct_scan', 'ultrasound', 'ecg', 'echo', 'other');

-- CreateEnum
CREATE TYPE "ImagingRequestStatus" AS ENUM ('requested', 'scheduled', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "ImagingResultStatus" AS ENUM ('draft', 'finalized', 'published');

-- CreateEnum
CREATE TYPE "DosageForm" AS ENUM ('tablet', 'capsule', 'syrup', 'injection', 'cream', 'drops', 'inhaler', 'other');

-- CreateEnum
CREATE TYPE "SupplyType" AS ENUM ('drugs', 'consumables', 'equipment', 'all');

-- CreateEnum
CREATE TYPE "InventoryCategory" AS ENUM ('drug', 'consumable', 'surgical_supply', 'equipment', 'other');

-- CreateEnum
CREATE TYPE "StockTransactionType" AS ENUM ('stock_in', 'stock_out', 'return', 'adjustment', 'expired_removal');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('draft', 'submitted', 'approved', 'delivered', 'partially_delivered', 'cancelled');

-- CreateEnum
CREATE TYPE "SupplyRequestStatus" AS ENUM ('pending', 'approved', 'fulfilled', 'rejected');

-- CreateEnum
CREATE TYPE "SupplyUrgency" AS ENUM ('routine', 'urgent');

-- CreateEnum
CREATE TYPE "ReturnType" AS ENUM ('patient_return', 'vendor_return');

-- CreateEnum
CREATE TYPE "DrugReturnStatus" AS ENUM ('pending', 'processed', 'rejected');

-- CreateEnum
CREATE TYPE "ServiceTariffCategory" AS ENUM ('consultation', 'surgery', 'room', 'lab', 'radiology', 'pharmacy', 'procedure', 'other');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('draft', 'pending', 'partially_paid', 'paid', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "BillItemCategory" AS ENUM ('consultation', 'surgery', 'room', 'lab', 'radiology', 'pharmacy', 'procedure', 'other');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'credit_card', 'debit_card', 'upi', 'net_banking', 'insurance', 'cheque', 'other');

-- CreateEnum
CREATE TYPE "PaymentTypeEnum" AS ENUM ('regular', 'advance', 'refund');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'completed', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "PaymentSource" AS ENUM ('online', 'frontdesk');

-- CreateEnum
CREATE TYPE "PaymentTransferStatus" AS ENUM ('pending', 'processed', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('requested', 'approved', 'processed', 'rejected');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('percentage', 'fixed');

-- CreateEnum
CREATE TYPE "InsurancePolicyStatus" AS ENUM ('active', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('submitted', 'under_review', 'approved', 'partially_approved', 'rejected', 'resubmitted', 'settled');

-- CreateEnum
CREATE TYPE "PreAuthStatus" AS ENUM ('pending', 'approved', 'denied', 'expired');

-- CreateEnum
CREATE TYPE "CommunicationType" AS ENUM ('email', 'phone', 'portal', 'letter');

-- CreateEnum
CREATE TYPE "CommunicationDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "DonationType" AS ENUM ('whole_blood', 'plasma', 'platelets', 'double_red_cells');

-- CreateEnum
CREATE TYPE "ScreeningResult" AS ENUM ('pass', 'fail', 'pending');

-- CreateEnum
CREATE TYPE "BloodComponentType" AS ENUM ('whole_blood', 'packed_rbc', 'plasma', 'platelets', 'cryoprecipitate');

-- CreateEnum
CREATE TYPE "BloodInventoryStatus" AS ENUM ('available', 'reserved', 'issued', 'expired', 'discarded');

-- CreateEnum
CREATE TYPE "CrossMatchResult" AS ENUM ('compatible', 'incompatible', 'pending');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('full_time', 'part_time', 'contract', 'intern');

-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('active', 'on_leave', 'resigned', 'terminated');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('active', 'expired', 'renewal_pending');

-- CreateEnum
CREATE TYPE "ShiftType" AS ENUM ('morning', 'afternoon', 'night', 'general');

-- CreateEnum
CREATE TYPE "DutyRosterStatus" AS ENUM ('scheduled', 'published', 'completed', 'swapped', 'cancelled');

-- CreateEnum
CREATE TYPE "NurseAssignmentStatus" AS ENUM ('active', 'ended', 'handed_over', 'cancelled');

-- CreateEnum
CREATE TYPE "AttendanceSource" AS ENUM ('manual', 'biometric', 'system');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('present', 'absent', 'half_day', 'on_leave', 'holiday');

-- CreateEnum
CREATE TYPE "LeaveType" AS ENUM ('vacation', 'sick', 'casual', 'maternity', 'paternity', 'unpaid', 'other');

-- CreateEnum
CREATE TYPE "LeaveRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('draft', 'processed', 'paid');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('appointment', 'lab_result', 'prescription', 'billing', 'system', 'ticket', 'alert', 'general', 'subscription');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('in_app', 'sms', 'email', 'push');

-- CreateEnum
CREATE TYPE "HandoverShiftType" AS ENUM ('morning', 'afternoon', 'night');

-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('appointment_request', 'op_to_ip', 'complaint', 'service_request', 'equipment_fault', 'general');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('open', 'in_progress', 'pending', 'resolved', 'closed', 'escalated');

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('general', 'doctor', 'service', 'facility', 'complaint');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('submitted', 'reviewed', 'escalated', 'resolved');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('create', 'read', 'update', 'delete');

-- CreateEnum
CREATE TYPE "ComplianceDocumentType" AS ENUM ('license', 'certification', 'accreditation', 'policy', 'legal_hold');

-- CreateEnum
CREATE TYPE "ComplianceDocumentStatus" AS ENUM ('active', 'expired', 'renewal_pending');

-- CreateEnum
CREATE TYPE "OtRequestUrgency" AS ENUM ('elective', 'urgent', 'emergency');

-- CreateEnum
CREATE TYPE "OtRequestStatus" AS ENUM ('requested', 'scheduled', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('patient_fall', 'medication_error', 'equipment_fault', 'adverse_event', 'other');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('minor', 'moderate', 'major', 'critical');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('reported', 'investigating', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('financial', 'operational', 'clinical', 'insurance', 'inventory', 'pharmacy', 'hr', 'custom');

-- CreateEnum
CREATE TYPE "FileFormat" AS ENUM ('pdf', 'csv', 'excel');

-- CreateEnum
CREATE TYPE "ReportSchedule" AS ENUM ('daily', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('open', 'in_progress', 'resolved', 'escalated', 'closed');

-- CreateEnum
CREATE TYPE "DemoRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'trial_active', 'trial_ended', 'converted');

-- CreateEnum
CREATE TYPE "EmarFrequencyType" AS ENUM ('slot', 'interval', 'once', 'prn');

-- CreateEnum
CREATE TYPE "EmarDoseStatus" AS ENUM ('pending', 'due', 'overdue', 'given', 'given_late', 'missed', 'held', 'refused', 'cancelled');

-- CreateEnum
CREATE TYPE "EmarAuditAction" AS ENUM ('generated', 'given', 'late', 'missed', 'held', 'refused', 'amended', 'cancelled', 'prn', 'status');

-- CreateEnum
CREATE TYPE "MrdRequestStatus" AS ENUM ('initiated', 'in_progress', 'completed', 'rejected');

-- CreateEnum
CREATE TYPE "MrdDirection" AS ENUM ('inbound', 'outbound');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "logo_url" TEXT,
    "theme_config" JSONB,
    "address" TEXT,
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "country" VARCHAR(100),
    "phone" VARCHAR(20),
    "email" VARCHAR(255),
    "website" VARCHAR(255),
    "license_number" VARCHAR(100),
    "accreditation_info" TEXT,
    "hospital_code" VARCHAR(6),
    "allow_direct_patient_connection" BOOLEAN NOT NULL DEFAULT false,
    "linked_account_id" VARCHAR(255),
    "bank_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "onboarded_at" TIMESTAMP(3),
    "offboarded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "price_monthly" DECIMAL(12,2),
    "price_yearly" DECIMAL(12,2),
    "max_users" INTEGER,
    "max_hospitals" INTEGER,
    "features" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "razorpay_monthly_plan_id" TEXT,
    "razorpay_yearly_plan_id" TEXT,
    "allow_autopay" BOOLEAN NOT NULL DEFAULT true,
    "allow_manual" BOOLEAN NOT NULL DEFAULT true,
    "trial_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "billing_cycle" "BillingCycle",
    "razorpay_subscription_id" TEXT,
    "subscription_payment_method" "SubscriptionPaymentMethod" NOT NULL DEFAULT 'manual',
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMP(3),
    "last_reminder_days" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" TEXT NOT NULL,
    "user_subscription_id" TEXT,
    "user_id" TEXT NOT NULL,
    "razorpay_order_id" TEXT NOT NULL,
    "razorpay_payment_id" TEXT,
    "razorpay_signature" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "status" VARCHAR(20) NOT NULL DEFAULT 'created',
    "plan_id" TEXT NOT NULL,
    "billing_cycle" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_toggles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "feature_key" VARCHAR(100) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_toggles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20),
    "password_hash" VARCHAR(255) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100),
    "avatar_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_2fa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "two_fa_secret" VARCHAR(255),
    "last_login_at" TIMESTAMP(3),
    "password_reset_token" VARCHAR(255),
    "password_reset_expires" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "is_system_role" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_owners" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "module" VARCHAR(50) NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by" TEXT,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "status" "LoginStatus" NOT NULL,
    "failure_reason" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_requests" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "hospital_name" VARCHAR(255) NOT NULL,
    "designation" VARCHAR(100) NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "message" TEXT,
    "status" "DemoRequestStatus" NOT NULL DEFAULT 'pending',
    "trial_days" INTEGER,
    "trial_ends_at" TIMESTAMP(3),
    "trial_plan_id" TEXT,
    "approved_by_id" TEXT,
    "created_tenant_id" TEXT,
    "created_user_id" TEXT,
    "rejection_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(20),
    "description" TEXT,
    "head_user_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floors" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wards" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "department_id" TEXT,
    "floor_id" TEXT,
    "name" VARCHAR(100) NOT NULL,
    "ward_type" "WardType",
    "total_beds" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "beds" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "ward_id" TEXT NOT NULL,
    "bed_number" VARCHAR(20) NOT NULL,
    "bed_type" "BedType",
    "status" "BedStatus" NOT NULL DEFAULT 'available',
    "current_patient_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "beds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operating_theaters" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "location" VARCHAR(255),
    "status" "OtStatus" NOT NULL DEFAULT 'available',
    "equipment_list" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operating_theaters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hospital_resources" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "resource_type" "ResourceType",
    "serial_number" VARCHAR(100),
    "department_id" TEXT,
    "status" "ResourceStatus" NOT NULL DEFAULT 'available',
    "location" VARCHAR(255),
    "last_maintenance_date" DATE,
    "next_maintenance_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hospital_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT,
    "relationship" "PatientRelationship" NOT NULL DEFAULT 'self',
    "is_self" BOOLEAN NOT NULL DEFAULT false,
    "mrn" VARCHAR(50) NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100),
    "date_of_birth" DATE,
    "gender" "Gender",
    "blood_group" VARCHAR(5),
    "phone" VARCHAR(20),
    "email" VARCHAR(255),
    "address_line1" VARCHAR(255),
    "address_line2" VARCHAR(255),
    "city" VARCHAR(100),
    "state" VARCHAR(100),
    "postal_code" VARCHAR(20),
    "country" VARCHAR(100),
    "photo_url" TEXT,
    "id_proof_type" VARCHAR(50),
    "id_proof_number" VARCHAR(100),
    "id_proof_document_url" TEXT,
    "marital_status" VARCHAR(20),
    "nationality" VARCHAR(100),
    "occupation" VARCHAR(100),
    "religion" VARCHAR(50),
    "preferred_language" VARCHAR(50),
    "referred_by" VARCHAR(200),
    "notes" TEXT,
    "abha_number" VARCHAR(20),
    "abha_address" VARCHAR(100),
    "abha_linked" BOOLEAN NOT NULL DEFAULT false,
    "abha_linked_at" TIMESTAMP(3),
    "kyc_verified" BOOLEAN NOT NULL DEFAULT false,
    "kyc_verified_at" TIMESTAMP(3),
    "patient_type" "PatientType",
    "is_new" BOOLEAN NOT NULL DEFAULT true,
    "registration_source" "RegistrationSource",
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_emergency_contacts" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "relationship" VARCHAR(50) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_personal_history" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "appetite" TEXT,
    "diet" TEXT,
    "sleep_pattern" TEXT,
    "disorders" TEXT,
    "exercise_habits" TEXT,
    "smoking_status" "SmokingStatus",
    "alcohol_consumption" "AlcoholConsumption",
    "notes" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_personal_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_family_history" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "condition_name" VARCHAR(255) NOT NULL,
    "relation_side" "RelationSide" NOT NULL,
    "relationship" VARCHAR(50),
    "notes" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_family_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_allergies" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "allergy_type" "AllergyType" NOT NULL,
    "allergen" VARCHAR(255) NOT NULL,
    "severity" "AllergySeverity",
    "reaction" TEXT,
    "noted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_allergies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_current_medications" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "drug_name" VARCHAR(255) NOT NULL,
    "dosage" VARCHAR(100),
    "frequency" VARCHAR(100),
    "route" VARCHAR(50),
    "started_on" DATE,
    "source" VARCHAR(50),
    "notes" TEXT,
    "added_by" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_current_medications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_documents" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "document_type" "DocumentType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_size_bytes" BIGINT,
    "mime_type" VARCHAR(50),
    "uploaded_by" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_consents" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "consent_type" "ConsentType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" "ConsentStatus" NOT NULL DEFAULT 'pending',
    "given_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "signature_url" TEXT,
    "witness_name" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_privacy_settings" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "data_access_preference" JSONB,
    "notification_preferences" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_privacy_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abha_sync_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "sync_direction" "SyncDirection" NOT NULL,
    "record_type" "AbhaSyncRecordType" NOT NULL,
    "record_id" TEXT NOT NULL,
    "hip_id" VARCHAR(100),
    "hiu_id" VARCHAR(100),
    "transaction_id" VARCHAR(255),
    "consent_artifact_id" VARCHAR(255),
    "fhir_bundle_url" TEXT,
    "status" "AbhaSyncStatus" NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abha_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "specialization" VARCHAR(255),
    "qualifications" TEXT,
    "license_number" VARCHAR(100),
    "experience_years" INTEGER,
    "consultation_fee" DECIMAL(10,2),
    "bio" TEXT,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_schedules" (
    "id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "start_time" TIME NOT NULL,
    "end_time" TIME NOT NULL,
    "slot_duration_minutes" INTEGER NOT NULL DEFAULT 15,
    "max_patients" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_schedules_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "doctor_leaves" (
    "id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "leave_date" DATE NOT NULL,
    "end_date" DATE,
    "start_time" TIME,
    "end_time" TIME,
    "leave_type" "LeaveType" NOT NULL DEFAULT 'casual',
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_leaves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "appointment_date" DATE NOT NULL,
    "start_time" TIME NOT NULL,
    "end_time" TIME,
    "appointment_type" "AppointmentType" NOT NULL DEFAULT 'scheduled',
    "consultation_type" VARCHAR(30),
    "priority" VARCHAR(20),
    "visit_type" "VisitTypeAppt" NOT NULL DEFAULT 'new',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'booked',
    "reason" TEXT,
    "notes" TEXT,
    "booked_by" TEXT,
    "cancelled_by" TEXT,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_tokens" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "appointment_id" TEXT,
    "token_number" VARCHAR(20) NOT NULL,
    "queue_date" DATE NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'waiting',
    "check_in_time" TIMESTAMP(3),
    "consultation_start_time" TIMESTAMP(3),
    "consultation_end_time" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "queue_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visits" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "appointment_id" TEXT,
    "visit_type" "VisitType" NOT NULL,
    "visit_date" TIMESTAMP(3) NOT NULL,
    "chief_complaint" TEXT,
    "status" "VisitStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admissions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "bed_id" TEXT NOT NULL,
    "ward_id" TEXT NOT NULL,
    "admission_date" TIMESTAMP(3) NOT NULL,
    "discharge_date" TIMESTAMP(3),
    "expected_discharge_date" DATE,
    "admission_reason" TEXT,
    "deposit_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'admitted',
    "admitted_by" TEXT,
    "discharged_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_transfers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "transfer_type" "TransferType" NOT NULL,
    "from_doctor_id" TEXT,
    "to_doctor_id" TEXT,
    "from_bed_id" TEXT,
    "to_bed_id" TEXT,
    "from_ward_id" TEXT,
    "to_ward_id" TEXT,
    "reason" TEXT,
    "requested_by" TEXT,
    "approved_by" TEXT,
    "status" "TransferStatus" NOT NULL DEFAULT 'requested',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "ward_id" TEXT NOT NULL,
    "bed_id" TEXT,
    "reserved_date" TIMESTAMP(3) NOT NULL,
    "expected_admission" TIMESTAMP(3),
    "diagnosis" TEXT,
    "speciality" VARCHAR(100),
    "advance_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "status" "ReservationStatus" NOT NULL DEFAULT 'reserved',
    "admission_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "complaints" TEXT,
    "estimation_period_days" INTEGER NOT NULL DEFAULT 1,
    "total_estimate_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "items" JSONB DEFAULT '[]',
    "notes" TEXT,
    "status" "EstimationStatus" NOT NULL DEFAULT 'draft',
    "admission_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estimations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vitals" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "blood_pressure_systolic" INTEGER,
    "blood_pressure_diastolic" INTEGER,
    "pulse_rate" INTEGER,
    "temperature" DECIMAL(4,1),
    "respiratory_rate" INTEGER,
    "oxygen_saturation" DECIMAL(4,1),
    "weight_kg" DECIMAL(5,2),
    "height_cm" DECIMAL(5,1),
    "bmi" DECIMAL(4,1),
    "blood_sugar" DECIMAL(6,2),
    "notes" TEXT,
    "recorded_by" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes_vital_id" TEXT,
    "correction_reason" TEXT,
    "corrected_by_id" TEXT,
    "is_correction" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "vitals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnoses" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "icd_code" VARCHAR(20),
    "diagnosis_name" VARCHAR(500) NOT NULL,
    "diagnosis_type" "DiagnosisType" NOT NULL DEFAULT 'primary',
    "notes" TEXT,
    "diagnosed_by" TEXT,
    "diagnosed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnoses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_notes" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "note_type" "ProgressNoteType",
    "content" TEXT NOT NULL,
    "impressions" TEXT,
    "discussions" TEXT,
    "conclusions" TEXT,
    "subjective" JSONB,
    "objective" JSONB,
    "assessment" JSONB,
    "plan" JSONB,
    "custom_fields" JSONB,
    "weight_kg_at_entry" DECIMAL(5,2),
    "pin_to_discharge_summary" BOOLEAN NOT NULL DEFAULT false,
    "is_auto_filled" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProgressNoteStatus" NOT NULL DEFAULT 'active',
    "archived_at" TIMESTAMP(3),
    "archive_reason" VARCHAR(50),
    "signed_at" TIMESTAMP(3),
    "signed_by_id" TEXT,
    "locked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_note_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "fields" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_note_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_note_amendments" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "editor_id" TEXT NOT NULL,
    "field_name" VARCHAR(80) NOT NULL,
    "previous_value" TEXT,
    "new_value" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_note_amendments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "progress_note_pins" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "discharge_section" "DischargeSection" NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "progress_note_pins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_observation_catalog" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "system" "PhysicalObservationSystem" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "is_global" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "physical_observation_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nursing_notes" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "note_type" "NursingNoteType",
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nursing_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iv_line_records" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "line_type" "IVLineType" NOT NULL,
    "catheter_gauge" VARCHAR(10),
    "insertion_site" VARCHAR(100) NOT NULL,
    "inserted_at" TIMESTAMP(3) NOT NULL,
    "inserted_by" TEXT NOT NULL,
    "removed_at" TIMESTAMP(3),
    "removed_by" TEXT,
    "removal_reason" "IVRemovalReason",
    "dressing_change_frequency_hours" INTEGER NOT NULL DEFAULT 72,
    "last_dressing_change_at" TIMESTAMP(3),
    "last_flushed_at" TIMESTAMP(3),
    "fluid_type" VARCHAR(100),
    "flow_rate_ml_per_hr" INTEGER,
    "status" "IVLineStatus" NOT NULL DEFAULT 'active',
    "complications" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iv_line_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intake_output_records" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "record_datetime" TIMESTAMP(3) NOT NULL,
    "entry_type" "IOEntryType" NOT NULL,
    "category" "IOCategory" NOT NULL,
    "volume_ml" INTEGER NOT NULL,
    "fluid_description" VARCHAR(255),
    "iv_line_id" TEXT,
    "sub_type" VARCHAR(100),
    "color" VARCHAR(50),
    "frequency_count" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intake_output_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wound_care_records" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "wound_location" VARCHAR(100) NOT NULL,
    "wound_type" "WoundType",
    "wound_stage" "WoundStage",
    "length_cm" DECIMAL(5,2),
    "width_cm" DECIMAL(5,2),
    "depth_cm" DECIMAL(5,2),
    "exudate_type" "ExudateType",
    "exudate_amount" "ExudateAmount",
    "dressing_applied" VARCHAR(255),
    "treatment_notes" TEXT,
    "photo_url" TEXT,
    "assessed_at" TIMESTAMP(3) NOT NULL,
    "next_assessment_due" TIMESTAMP(3),
    "status" "WoundStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wound_care_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nursing_admission_assessments" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "arrival_mode" "ArrivalMode",
    "consciousness_level" "ConsciousnessLevel",
    "chief_complaint" TEXT,
    "allergies" TEXT,
    "current_medications" TEXT,
    "skin_condition" TEXT,
    "mobility" TEXT,
    "nutrition_status" TEXT,
    "elimination" TEXT,
    "preferred_language" TEXT,
    "religious_needs" TEXT,
    "next_of_kin" JSONB,
    "notes" TEXT,
    "assessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nursing_admission_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pain_assessments" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "pain_score" INTEGER NOT NULL,
    "pain_scale" "PainScale" NOT NULL DEFAULT 'numeric',
    "pain_location" VARCHAR(255),
    "pain_character" VARCHAR(255),
    "pain_onset_at" TIMESTAMP(3),
    "aggravating_factors" TEXT,
    "relieving_factors" TEXT,
    "intervention" TEXT,
    "reassessment_due_at" TIMESTAMP(3),
    "notes" TEXT,
    "assessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pain_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fall_risk_assessments" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "history_of_falling" INTEGER NOT NULL DEFAULT 0,
    "secondary_diagnosis" INTEGER NOT NULL DEFAULT 0,
    "ambulatory_aid" INTEGER NOT NULL DEFAULT 0,
    "iv_or_saline_lock" INTEGER NOT NULL DEFAULT 0,
    "gait" INTEGER NOT NULL DEFAULT 0,
    "mental_status" INTEGER NOT NULL DEFAULT 0,
    "total_score" INTEGER NOT NULL,
    "risk_level" "FallRiskLevel" NOT NULL,
    "intervention" TEXT,
    "notes" TEXT,
    "assessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fall_risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_observations" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pain_score" INTEGER,
    "pain_location" VARCHAR(255),
    "consciousness_avpu" "AvpuLevel",
    "general_condition" "GeneralCondition",
    "mobility" "MobilityLevel",
    "fluid_intake_ml" INTEGER,
    "food_intake_notes" TEXT,
    "urine_output_ml" INTEGER,
    "stool_passed" BOOLEAN,
    "stool_count" INTEGER,
    "notes" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_devices" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "device_type" "ClinicalDeviceType" NOT NULL,
    "device_subtype" VARCHAR(100),
    "site" VARCHAR(100) NOT NULL,
    "insertion_time" TIMESTAMP(3) NOT NULL,
    "inserted_by" TEXT NOT NULL,
    "removal_time" TIMESTAMP(3),
    "removed_by" TEXT,
    "status" "ClinicalDeviceStatus" NOT NULL DEFAULT 'active',
    "flow_status" "DeviceFlowStatus",
    "fluid_type" VARCHAR(100),
    "flow_rate_ml_per_hr" INTEGER,
    "oxygen_mode" "OxygenMode",
    "oxygen_flow_rate" DECIMAL(5,2),
    "created_by_procedure_id" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_device_checks" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "patency" "DevicePatency",
    "site_condition" "DeviceSiteCondition",
    "pain_present" BOOLEAN,
    "securement" "DeviceSecurement",
    "flow_status" "DeviceFlowStatus",
    "urine_flow" "UrineFlow",
    "urine_color" "UrineColor",
    "infection_suspected" BOOLEAN,
    "dislodged" BOOLEAN,
    "blocked" BOOLEAN,
    "remarks" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_device_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_procedures" (
    "id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "patient_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "procedure_type" VARCHAR(100) NOT NULL,
    "procedure_subtype" VARCHAR(100),
    "performed_at" TIMESTAMP(3) NOT NULL,
    "site" VARCHAR(100),
    "side" "ProcedureSide",
    "status" "ProcedureStatus" NOT NULL DEFAULT 'successful',
    "attempt_count" INTEGER,
    "aseptic_technique" BOOLEAN,
    "equipment_used" VARCHAR(255),
    "complications" "ProcedureComplication",
    "complication_notes" TEXT,
    "tolerance" "ProcedureTolerance",
    "pain_score" INTEGER,
    "device_created" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_procedures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discharge_summaries" (
    "id" TEXT NOT NULL,
    "admission_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "admission_date" TIMESTAMP(3),
    "discharge_date" TIMESTAMP(3),
    "header_summary" TEXT,
    "diagnoses_summary" TEXT,
    "procedures_summary" TEXT,
    "lab_results_summary" TEXT,
    "key_labs_summary" TEXT,
    "medication_reconciliation" TEXT,
    "discharge_instructions" TEXT,
    "follow_up_date" DATE,
    "follow_up_instructions" TEXT,
    "status" "DischargeSummaryStatus" NOT NULL DEFAULT 'draft',
    "signed_by" TEXT,
    "signed_at" TIMESTAMP(3),
    "e_signature_url" TEXT,
    "pdf_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discharge_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "prescription_type" "PrescriptionType" NOT NULL,
    "status" "PrescriptionStatus" NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "follow_up_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_items" (
    "id" TEXT NOT NULL,
    "prescription_id" TEXT NOT NULL,
    "drug_id" TEXT,
    "drug_name" VARCHAR(255) NOT NULL,
    "dosage" VARCHAR(100) NOT NULL,
    "frequency" VARCHAR(100) NOT NULL,
    "duration" VARCHAR(100),
    "route" "MedicationRoute" NOT NULL DEFAULT 'oral',
    "instructions" TEXT,
    "quantity" INTEGER,
    "is_prn" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescription_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medication_administrations" (
    "id" TEXT NOT NULL,
    "prescription_item_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "administered_by" TEXT NOT NULL,
    "administered_at" TIMESTAMP(3) NOT NULL,
    "dose_given" VARCHAR(100),
    "status" "MedAdminStatus" NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medication_administrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emar_time_slots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "time" VARCHAR(5) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emar_time_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emar_frequencies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "type" "EmarFrequencyType" NOT NULL,
    "slot_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "interval_hours" INTEGER,
    "min_prn_interval_minutes" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emar_frequencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emar_settings" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "grace_period_minutes" INTEGER NOT NULL DEFAULT 120,
    "default_prn_min_interval_minutes" INTEGER NOT NULL DEFAULT 240,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emar_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emar_schedules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "prescription_id" TEXT NOT NULL,
    "prescription_item_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "admission_id" TEXT,
    "drug_name" VARCHAR(255) NOT NULL,
    "dosage" VARCHAR(100) NOT NULL,
    "route" "MedicationRoute" NOT NULL DEFAULT 'oral',
    "frequency_code" VARCHAR(40),
    "slot_code" VARCHAR(40),
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "status" "EmarDoseStatus" NOT NULL DEFAULT 'pending',
    "is_prn" BOOLEAN NOT NULL DEFAULT false,
    "actioned_at" TIMESTAMP(3),
    "actual_given_time" TIMESTAMP(3),
    "given_by_id" TEXT,
    "delay_minutes" INTEGER,
    "reason" TEXT,
    "notes" TEXT,
    "amended_at" TIMESTAMP(3),
    "amended_by_id" TEXT,
    "previous_status" "EmarDoseStatus",
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emar_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emar_audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "action" "EmarAuditAction" NOT NULL,
    "from_status" "EmarDoseStatus",
    "to_status" "EmarDoseStatus" NOT NULL,
    "performed_by_id" TEXT,
    "performed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "server_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "notes" TEXT,
    "delay_minutes" INTEGER,
    "metadata" JSONB,

    CONSTRAINT "emar_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_departments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_test_catalog" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "lab_department_id" TEXT NOT NULL,
    "test_name" VARCHAR(255) NOT NULL,
    "test_code" VARCHAR(50),
    "description" TEXT,
    "normal_range" TEXT,
    "unit" VARCHAR(50),
    "price" DECIMAL(10,2),
    "turnaround_hours" INTEGER,
    "sample_type" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_test_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "ordered_by" TEXT NOT NULL,
    "assigned_to_id" TEXT,
    "assigned_dept_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "accepted_by" TEXT,
    "urgency" "Urgency" NOT NULL DEFAULT 'routine',
    "status" "LabOrderStatus" NOT NULL DEFAULT 'ordered',
    "is_third_party" BOOLEAN NOT NULL DEFAULT false,
    "third_party_lab_name" VARCHAR(255),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_order_items" (
    "id" TEXT NOT NULL,
    "lab_order_id" TEXT NOT NULL,
    "test_id" TEXT NOT NULL,
    "status" "LabOrderItemStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_samples" (
    "id" TEXT NOT NULL,
    "lab_order_id" TEXT NOT NULL,
    "sample_type" VARCHAR(50) NOT NULL,
    "barcode" VARCHAR(100),
    "collected_by" TEXT,
    "collected_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3),
    "status" "LabSampleStatus" NOT NULL DEFAULT 'collected',
    "rejection_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_results" (
    "id" TEXT NOT NULL,
    "lab_order_item_id" TEXT NOT NULL,
    "lab_order_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "parameter_name" VARCHAR(255) NOT NULL,
    "value" VARCHAR(255),
    "unit" VARCHAR(50),
    "normal_range" VARCHAR(100),
    "is_abnormal" BOOLEAN NOT NULL DEFAULT false,
    "status" "LabResultStatus" NOT NULL DEFAULT 'entered',
    "entered_by" TEXT,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by" TEXT,
    "verified_at" TIMESTAMP(3),
    "correction_notes" TEXT,

    CONSTRAINT "lab_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_reports" (
    "id" TEXT NOT NULL,
    "lab_order_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "report_content" TEXT,
    "hospital_branding" JSONB,
    "qr_code_url" TEXT,
    "pdf_url" TEXT,
    "status" "LabReportStatus" NOT NULL DEFAULT 'draft',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "signed_by" TEXT,
    "signed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "correction_notes" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imaging_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "ordered_by" TEXT NOT NULL,
    "imaging_type" "ImagingType" NOT NULL,
    "body_part" VARCHAR(100),
    "urgency" "Urgency" NOT NULL DEFAULT 'routine',
    "clinical_indication" TEXT,
    "status" "ImagingRequestStatus" NOT NULL DEFAULT 'requested',
    "scheduled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "assigned_technician_id" TEXT,
    "room" VARCHAR(100),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imaging_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "imaging_results" (
    "id" TEXT NOT NULL,
    "imaging_request_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "findings" TEXT,
    "impression" TEXT,
    "radiologist_id" TEXT,
    "image_urls" JSONB,
    "pacs_reference_id" VARCHAR(255),
    "pdf_report_url" TEXT,
    "status" "ImagingResultStatus" NOT NULL DEFAULT 'draft',
    "signed_by" TEXT,
    "signed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "imaging_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_categories" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drug_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_formulary" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "drug_name" VARCHAR(255) NOT NULL,
    "generic_name" VARCHAR(255),
    "category_id" TEXT,
    "manufacturer" VARCHAR(255),
    "dosage_form" "DosageForm",
    "strength" VARCHAR(100),
    "unit_of_measurement" VARCHAR(20),
    "price" DECIMAL(10,2),
    "indications" TEXT,
    "contraindications" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_recalled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drug_formulary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_batches" (
    "id" TEXT NOT NULL,
    "drug_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "batch_number" VARCHAR(100) NOT NULL,
    "manufacturing_date" DATE,
    "expiry_date" DATE NOT NULL,
    "supplier_id" TEXT,
    "purchase_price" DECIMAL(10,2),
    "selling_price" DECIMAL(10,2),
    "quantity_received" INTEGER NOT NULL,
    "quantity_in_stock" INTEGER NOT NULL,
    "is_expired" BOOLEAN NOT NULL DEFAULT false,
    "is_recalled" BOOLEAN NOT NULL DEFAULT false,
    "recall_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drug_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispensing_records" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "prescription_id" TEXT NOT NULL,
    "prescription_item_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "drug_batch_id" TEXT NOT NULL,
    "quantity_dispensed" INTEGER NOT NULL,
    "dispensed_by" TEXT NOT NULL,
    "dispensed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by" TEXT,
    "notes" TEXT,

    CONSTRAINT "dispensing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_returns" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "return_type" "ReturnType" NOT NULL,
    "drug_batch_id" TEXT NOT NULL,
    "patient_id" TEXT,
    "supplier_id" TEXT,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT,
    "processed_by" TEXT,
    "status" "DrugReturnStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drug_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "contact_person" VARCHAR(100),
    "phone" VARCHAR(20),
    "email" VARCHAR(255),
    "address" TEXT,
    "gst_number" VARCHAR(50),
    "license_number" VARCHAR(100),
    "supply_type" "SupplyType",
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "item_name" VARCHAR(255) NOT NULL,
    "item_code" VARCHAR(50),
    "category" "InventoryCategory" NOT NULL,
    "description" TEXT,
    "unit_of_measurement" VARCHAR(20),
    "minimum_stock_threshold" INTEGER NOT NULL DEFAULT 10,
    "current_stock" INTEGER NOT NULL DEFAULT 0,
    "cost_per_unit" DECIMAL(10,2),
    "selling_price_per_unit" DECIMAL(10,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transactions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "transaction_type" "StockTransactionType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "batch_number" VARCHAR(100),
    "expiry_date" DATE,
    "supplier_id" TEXT,
    "reference_type" VARCHAR(50),
    "reference_id" TEXT,
    "unit_cost" DECIMAL(10,2),
    "total_cost" DECIMAL(12,2),
    "department_id" TEXT,
    "notes" TEXT,
    "performed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "order_number" VARCHAR(50) NOT NULL,
    "order_date" DATE NOT NULL,
    "expected_delivery_date" DATE,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'draft',
    "total_amount" DECIMAL(12,2),
    "approved_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" TEXT NOT NULL,
    "purchase_order_id" TEXT NOT NULL,
    "inventory_item_id" TEXT NOT NULL,
    "quantity_ordered" INTEGER NOT NULL,
    "quantity_received" INTEGER NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(10,2),
    "total_price" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supply_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "ward_id" TEXT,
    "inventory_item_id" TEXT NOT NULL,
    "quantity_requested" INTEGER NOT NULL,
    "quantity_fulfilled" INTEGER NOT NULL DEFAULT 0,
    "status" "SupplyRequestStatus" NOT NULL DEFAULT 'pending',
    "urgency" "SupplyUrgency" NOT NULL DEFAULT 'routine',
    "approved_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_tariffs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "service_name" VARCHAR(255) NOT NULL,
    "service_code" VARCHAR(50),
    "category" "ServiceTariffCategory" NOT NULL,
    "base_price" DECIMAL(12,2) NOT NULL,
    "gst_rate_percent" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT,
    "admission_id" TEXT,
    "bill_number" VARCHAR(50) NOT NULL,
    "bill_date" TIMESTAMP(3) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "insurance_covered_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "patient_payable_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "balance_due" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "BillStatus" NOT NULL DEFAULT 'draft',
    "generated_by" TEXT,
    "approved_by" TEXT,
    "cancelled_by" TEXT,
    "cancellation_reason" TEXT,
    "pdf_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_items" (
    "id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "service_tariff_id" TEXT,
    "description" VARCHAR(500) NOT NULL,
    "category" "BillItemCategory" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "reference_type" VARCHAR(50),
    "reference_id" TEXT,
    "is_auto_pulled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bill_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "payment_date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "payment_source" "PaymentSource",
    "payment_type" "PaymentTypeEnum" NOT NULL DEFAULT 'regular',
    "transaction_id" VARCHAR(100),
    "gateway_reference" VARCHAR(255),
    "idempotency_key" VARCHAR(255),
    "status" "PaymentStatus" NOT NULL DEFAULT 'completed',
    "processed_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "receipt_number" VARCHAR(50) NOT NULL,
    "receipt_date" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "pdf_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'requested',
    "requested_by" TEXT,
    "approved_by" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discounts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "discount_type" "DiscountType" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "contact_person" VARCHAR(100),
    "phone" VARCHAR(20),
    "email" VARCHAR(255),
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tpa_providers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "contact_person" VARCHAR(100),
    "phone" VARCHAR(20),
    "email" VARCHAR(255),
    "address" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tpa_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_policies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "insurer_id" TEXT NOT NULL,
    "tpa_id" TEXT,
    "policy_number" VARCHAR(100) NOT NULL,
    "group_number" VARCHAR(100),
    "plan_name" VARCHAR(255),
    "coverage_amount" DECIMAL(12,2),
    "co_pay_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "deductible_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "exclusions" TEXT,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,
    "status" "InsurancePolicyStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_claims" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "claim_number" VARCHAR(100),
    "claim_amount" DECIMAL(12,2) NOT NULL,
    "approved_amount" DECIMAL(12,2),
    "patient_share" DECIMAL(12,2),
    "status" "ClaimStatus" NOT NULL DEFAULT 'submitted',
    "submission_date" TIMESTAMP(3) NOT NULL,
    "approval_date" TIMESTAMP(3),
    "settlement_date" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "documents_url" JSONB,
    "submitted_by" TEXT,
    "reviewed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_authorization_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "procedure_description" TEXT NOT NULL,
    "estimated_cost" DECIMAL(12,2),
    "status" "PreAuthStatus" NOT NULL DEFAULT 'pending',
    "approval_number" VARCHAR(100),
    "valid_from" DATE,
    "valid_to" DATE,
    "notes" TEXT,
    "submitted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_authorization_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tpa_communication_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "claim_id" TEXT,
    "tpa_id" TEXT NOT NULL,
    "communication_type" "CommunicationType",
    "subject" VARCHAR(255),
    "content" TEXT,
    "direction" "CommunicationDirection",
    "communicated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tpa_communication_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blood_donors" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100),
    "date_of_birth" DATE,
    "gender" "Gender",
    "blood_group" VARCHAR(5) NOT NULL,
    "phone" VARCHAR(20),
    "email" VARCHAR(255),
    "address" TEXT,
    "health_status" TEXT,
    "is_eligible" BOOLEAN NOT NULL DEFAULT true,
    "last_donation_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blood_donors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blood_donations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "donation_date" TIMESTAMP(3) NOT NULL,
    "donation_type" "DonationType" NOT NULL,
    "volume_ml" INTEGER NOT NULL,
    "bag_number" VARCHAR(50),
    "screening_result" "ScreeningResult" NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "collected_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blood_donations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blood_inventory" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "donation_id" TEXT,
    "component_type" "BloodComponentType" NOT NULL,
    "blood_group" VARCHAR(5) NOT NULL,
    "bag_number" VARCHAR(50),
    "volume_ml" INTEGER NOT NULL,
    "collection_date" DATE NOT NULL,
    "expiry_date" DATE NOT NULL,
    "status" "BloodInventoryStatus" NOT NULL DEFAULT 'available',
    "storage_location" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blood_inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cross_match_tests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "blood_inventory_id" TEXT NOT NULL,
    "result" "CrossMatchResult" NOT NULL DEFAULT 'pending',
    "tested_by" TEXT,
    "tested_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cross_match_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfusions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "blood_inventory_id" TEXT NOT NULL,
    "cross_match_id" TEXT NOT NULL,
    "transfusion_date" TIMESTAMP(3) NOT NULL,
    "volume_ml" INTEGER NOT NULL,
    "administered_by" TEXT NOT NULL,
    "ordered_by" TEXT NOT NULL,
    "adverse_reaction" BOOLEAN NOT NULL DEFAULT false,
    "reaction_details" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfusions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "employee_id" VARCHAR(50),
    "position" VARCHAR(100),
    "date_of_joining" DATE,
    "date_of_birth" DATE,
    "gender" "Gender",
    "address" TEXT,
    "emergency_contact_name" VARCHAR(100),
    "emergency_contact_phone" VARCHAR(20),
    "salary" DECIMAL(12,2),
    "employment_type" "EmploymentType",
    "status" "StaffStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_licenses" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "license_type" VARCHAR(100) NOT NULL,
    "license_number" VARCHAR(100) NOT NULL,
    "issuing_authority" VARCHAR(255),
    "issued_date" DATE,
    "expiry_date" DATE,
    "document_url" TEXT,
    "status" "LicenseStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duty_rosters" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "ward_id" TEXT,
    "role" VARCHAR(50),
    "shift_date" DATE NOT NULL,
    "shift_type" "ShiftType" NOT NULL,
    "start_time" TIME NOT NULL,
    "end_time" TIME NOT NULL,
    "status" "DutyRosterStatus" NOT NULL DEFAULT 'scheduled',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "duty_rosters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nurse_assignments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "admission_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "ward_id" TEXT NOT NULL,
    "bed_id" TEXT,
    "shift_date" DATE NOT NULL,
    "shift_type" "ShiftType" NOT NULL,
    "assigned_by_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "NurseAssignmentStatus" NOT NULL DEFAULT 'active',
    "handed_over_to_id" TEXT,
    "handed_over_at" TIMESTAMP(3),
    "handover_note_id" TEXT,
    "ended_at" TIMESTAMP(3),
    "ended_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nurse_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nurse_doctor_assignments" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "nurse_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "assigned_by_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "ended_at" TIMESTAMP(3),
    "ended_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nurse_doctor_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "check_in" TIMESTAMP(3),
    "check_out" TIMESTAMP(3),
    "source" "AttendanceSource" NOT NULL DEFAULT 'manual',
    "status" "AttendanceStatus" NOT NULL DEFAULT 'present',
    "overtime_hours" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "leave_type" "LeaveType" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "reason" TEXT,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'pending',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "pay_period_start" DATE NOT NULL,
    "pay_period_end" DATE NOT NULL,
    "basic_salary" DECIMAL(12,2),
    "allowances" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "overtime_pay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "gross_salary" DECIMAL(12,2),
    "tax_deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net_salary" DECIMAL(12,2),
    "status" "PayrollStatus" NOT NULL DEFAULT 'draft',
    "processed_by" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_slips" (
    "id" TEXT NOT NULL,
    "payroll_id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "slip_number" VARCHAR(50),
    "pdf_url" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "salary_slips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" TEXT NOT NULL,
    "notification_type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'in_app',
    "reference_type" VARCHAR(50),
    "reference_id" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "receiver_id" TEXT NOT NULL,
    "subject" VARCHAR(255),
    "content" TEXT NOT NULL,
    "is_encrypted" BOOLEAN NOT NULL DEFAULT true,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "parent_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_handover_notes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "from_nurse_id" TEXT NOT NULL,
    "to_nurse_id" TEXT,
    "ward_id" TEXT NOT NULL,
    "shift_date" DATE NOT NULL,
    "shift_type" "HandoverShiftType" NOT NULL,
    "content" TEXT NOT NULL,
    "patient_statuses" JSONB,
    "outstanding_tasks" JSONB,
    "is_acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shift_handover_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "ticket_number" VARCHAR(50) NOT NULL,
    "raised_by" TEXT NOT NULL,
    "assigned_to" TEXT,
    "ticket_type" "TicketType" NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'medium',
    "status" "TicketStatus" NOT NULL DEFAULT 'open',
    "patient_id" TEXT,
    "department_id" TEXT,
    "resolution_notes" TEXT,
    "resolved_at" TIMESTAMP(3),
    "escalated_to" TEXT,
    "attachments" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "submitted_by" TEXT NOT NULL,
    "patient_id" TEXT,
    "feedback_type" "FeedbackType" NOT NULL,
    "subject" VARCHAR(255),
    "content" TEXT NOT NULL,
    "rating" SMALLINT,
    "doctor_id" TEXT,
    "department_id" TEXT,
    "status" "FeedbackStatus" NOT NULL DEFAULT 'submitted',
    "admin_response" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "entity_type" VARCHAR(100) NOT NULL,
    "entity_id" TEXT NOT NULL,
    "old_values" JSONB,
    "new_values" JSONB,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_documents" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "document_type" "ComplianceDocumentType" NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "file_url" TEXT,
    "issued_date" DATE,
    "expiry_date" DATE,
    "status" "ComplianceDocumentStatus" NOT NULL DEFAULT 'active',
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ot_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "ot_id" TEXT,
    "procedure_name" VARCHAR(255) NOT NULL,
    "procedure_details" TEXT,
    "urgency" "OtRequestUrgency" NOT NULL DEFAULT 'elective',
    "preferred_date" DATE,
    "preferred_time" TIME,
    "scheduled_date" DATE,
    "scheduled_time" TIME,
    "duration_minutes" INTEGER,
    "required_equipment" JSONB,
    "pre_op_checklist" JSONB,
    "status" "OtRequestStatus" NOT NULL DEFAULT 'requested',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ot_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_reports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "reported_by" TEXT NOT NULL,
    "patient_id" TEXT,
    "incident_type" "IncidentType" NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "IncidentSeverity",
    "location" VARCHAR(255),
    "occurred_at" TIMESTAMP(3),
    "status" "IncidentStatus" NOT NULL DEFAULT 'reported',
    "resolution_notes" TEXT,
    "resolved_at" TIMESTAMP(3),
    "escalated_to" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_reports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "report_name" VARCHAR(255) NOT NULL,
    "report_type" "ReportType" NOT NULL,
    "parameters" JSONB,
    "generated_by" TEXT NOT NULL,
    "file_url" TEXT,
    "file_format" "FileFormat",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_reports" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "report_name" VARCHAR(255) NOT NULL,
    "report_type" VARCHAR(50) NOT NULL,
    "parameters" JSONB,
    "schedule" "ReportSchedule" NOT NULL,
    "delivery_email" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_generated_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "raised_by" TEXT NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "priority" "Priority" NOT NULL DEFAULT 'medium',
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'open',
    "resolution_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_hospital_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'pending',
    "patient_id" TEXT,
    "request_message" VARCHAR(500),
    "rejection_reason" VARCHAR(500),
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_hospital_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mrd_requests" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "requested_to" VARCHAR(255) NOT NULL,
    "requested_by" TEXT,
    "location_from" VARCHAR(255),
    "ward_room" VARCHAR(100),
    "status" "MrdRequestStatus" NOT NULL DEFAULT 'initiated',
    "direction" "MrdDirection" NOT NULL DEFAULT 'outbound',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mrd_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transfers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "razorpay_order_id" VARCHAR(100) NOT NULL,
    "razorpay_payment_id" VARCHAR(100),
    "razorpay_transfer_id" VARCHAR(100),
    "total_amount" DECIMAL(12,2) NOT NULL,
    "commission_amount" DECIMAL(12,2) NOT NULL,
    "hospital_amount" DECIMAL(12,2) NOT NULL,
    "commission_percent" DECIMAL(5,2) NOT NULL,
    "transfer_status" "PaymentTransferStatus" NOT NULL DEFAULT 'pending',
    "webhook_payload" JSONB,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_settings" (
    "id" TEXT NOT NULL,
    "default_percent" DECIMAL(5,2) NOT NULL,
    "min_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "max_percent" DECIMAL(5,2) NOT NULL DEFAULT 50,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hospital_commissions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "commission_percent" DECIMAL(5,2) NOT NULL,
    "notes" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hospital_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_hospital_code_key" ON "tenants"("hospital_code");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_razorpay_monthly_plan_id_key" ON "subscription_plans"("razorpay_monthly_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_razorpay_yearly_plan_id_key" ON "subscription_plans"("razorpay_yearly_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_name_key" ON "subscription_plans"("name");

-- CreateIndex
CREATE UNIQUE INDEX "user_subscriptions_razorpay_subscription_id_key" ON "user_subscriptions"("razorpay_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_razorpay_order_id_key" ON "subscription_payments"("razorpay_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "feature_toggles_tenant_id_feature_key_key" ON "feature_toggles"("tenant_id", "feature_key");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_owners_user_id_tenant_id_key" ON "tenant_owners"("user_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_module_action_key" ON "permissions"("module", "action");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_id_key" ON "user_roles"("user_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "floors_tenant_id_name_key" ON "floors"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "floors_tenant_id_level_key" ON "floors"("tenant_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "patients_abha_number_key" ON "patients"("abha_number");

-- CreateIndex
CREATE UNIQUE INDEX "patients_tenant_id_mrn_key" ON "patients"("tenant_id", "mrn");

-- CreateIndex
CREATE UNIQUE INDEX "patient_personal_history_patient_id_key" ON "patient_personal_history"("patient_id");

-- CreateIndex
CREATE INDEX "patient_current_medications_patient_id_is_active_idx" ON "patient_current_medications"("patient_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "patient_privacy_settings_patient_id_key" ON "patient_privacy_settings"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_user_id_key" ON "doctor_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_schedule_overrides_doctor_id_date_key" ON "doctor_schedule_overrides"("doctor_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "admissions_visit_id_key" ON "admissions"("visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_admission_id_key" ON "reservations"("admission_id");

-- CreateIndex
CREATE INDEX "vitals_visit_id_recorded_at_idx" ON "vitals"("visit_id", "recorded_at");

-- CreateIndex
CREATE INDEX "vitals_supersedes_vital_id_idx" ON "vitals"("supersedes_vital_id");

-- CreateIndex
CREATE INDEX "progress_notes_status_created_at_idx" ON "progress_notes"("status", "created_at");

-- CreateIndex
CREATE INDEX "progress_notes_admission_id_created_at_idx" ON "progress_notes"("admission_id", "created_at");

-- CreateIndex
CREATE INDEX "progress_note_templates_doctor_id_is_default_idx" ON "progress_note_templates"("doctor_id", "is_default");

-- CreateIndex
CREATE INDEX "progress_note_amendments_note_id_created_at_idx" ON "progress_note_amendments"("note_id", "created_at");

-- CreateIndex
CREATE INDEX "progress_note_pins_note_id_idx" ON "progress_note_pins"("note_id");

-- CreateIndex
CREATE INDEX "physical_observation_catalog_tenant_id_system_is_active_idx" ON "physical_observation_catalog"("tenant_id", "system", "is_active");

-- CreateIndex
CREATE INDEX "nursing_admission_assessments_patient_id_assessed_at_idx" ON "nursing_admission_assessments"("patient_id", "assessed_at");

-- CreateIndex
CREATE INDEX "nursing_admission_assessments_admission_id_idx" ON "nursing_admission_assessments"("admission_id");

-- CreateIndex
CREATE INDEX "pain_assessments_patient_id_assessed_at_idx" ON "pain_assessments"("patient_id", "assessed_at");

-- CreateIndex
CREATE INDEX "pain_assessments_admission_id_idx" ON "pain_assessments"("admission_id");

-- CreateIndex
CREATE INDEX "fall_risk_assessments_patient_id_assessed_at_idx" ON "fall_risk_assessments"("patient_id", "assessed_at");

-- CreateIndex
CREATE INDEX "fall_risk_assessments_admission_id_idx" ON "fall_risk_assessments"("admission_id");

-- CreateIndex
CREATE INDEX "clinical_observations_patient_id_observed_at_idx" ON "clinical_observations"("patient_id", "observed_at");

-- CreateIndex
CREATE INDEX "clinical_observations_admission_id_idx" ON "clinical_observations"("admission_id");

-- CreateIndex
CREATE INDEX "clinical_devices_patient_id_status_idx" ON "clinical_devices"("patient_id", "status");

-- CreateIndex
CREATE INDEX "clinical_devices_visit_id_status_idx" ON "clinical_devices"("visit_id", "status");

-- CreateIndex
CREATE INDEX "clinical_devices_admission_id_idx" ON "clinical_devices"("admission_id");

-- CreateIndex
CREATE INDEX "clinical_device_checks_device_id_checked_at_idx" ON "clinical_device_checks"("device_id", "checked_at");

-- CreateIndex
CREATE INDEX "clinical_device_checks_patient_id_checked_at_idx" ON "clinical_device_checks"("patient_id", "checked_at");

-- CreateIndex
CREATE INDEX "clinical_procedures_patient_id_performed_at_idx" ON "clinical_procedures"("patient_id", "performed_at");

-- CreateIndex
CREATE INDEX "clinical_procedures_admission_id_idx" ON "clinical_procedures"("admission_id");

-- CreateIndex
CREATE UNIQUE INDEX "discharge_summaries_admission_id_key" ON "discharge_summaries"("admission_id");

-- CreateIndex
CREATE UNIQUE INDEX "emar_time_slots_tenant_id_code_key" ON "emar_time_slots"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "emar_frequencies_tenant_id_code_key" ON "emar_frequencies"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "emar_settings_tenant_id_key" ON "emar_settings"("tenant_id");

-- CreateIndex
CREATE INDEX "emar_schedules_tenant_id_scheduled_at_idx" ON "emar_schedules"("tenant_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "emar_schedules_tenant_id_patient_id_scheduled_at_idx" ON "emar_schedules"("tenant_id", "patient_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "emar_schedules_tenant_id_admission_id_scheduled_at_idx" ON "emar_schedules"("tenant_id", "admission_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "emar_schedules_tenant_id_status_idx" ON "emar_schedules"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "emar_audit_logs_tenant_id_schedule_id_idx" ON "emar_audit_logs"("tenant_id", "schedule_id");

-- CreateIndex
CREATE INDEX "emar_audit_logs_tenant_id_performed_at_idx" ON "emar_audit_logs"("tenant_id", "performed_at");

-- CreateIndex
CREATE UNIQUE INDEX "lab_samples_barcode_key" ON "lab_samples"("barcode");

-- CreateIndex
CREATE UNIQUE INDEX "lab_reports_lab_order_id_key" ON "lab_reports"("lab_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "imaging_results_imaging_request_id_key" ON "imaging_results"("imaging_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_order_number_key" ON "purchase_orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "bills_bill_number_key" ON "bills"("bill_number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_payment_id_key" ON "receipts"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_receipt_number_key" ON "receipts"("receipt_number");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_claims_claim_number_key" ON "insurance_claims"("claim_number");

-- CreateIndex
CREATE UNIQUE INDEX "blood_donations_bag_number_key" ON "blood_donations"("bag_number");

-- CreateIndex
CREATE UNIQUE INDEX "blood_inventory_bag_number_key" ON "blood_inventory"("bag_number");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_user_id_key" ON "staff_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_profiles_employee_id_key" ON "staff_profiles"("employee_id");

-- CreateIndex
CREATE INDEX "duty_rosters_ward_id_shift_date_shift_type_idx" ON "duty_rosters"("ward_id", "shift_date", "shift_type");

-- CreateIndex
CREATE INDEX "duty_rosters_staff_id_shift_date_idx" ON "duty_rosters"("staff_id", "shift_date");

-- CreateIndex
CREATE INDEX "nurse_assignments_admission_id_status_idx" ON "nurse_assignments"("admission_id", "status");

-- CreateIndex
CREATE INDEX "nurse_assignments_nurse_id_shift_date_idx" ON "nurse_assignments"("nurse_id", "shift_date");

-- CreateIndex
CREATE INDEX "nurse_assignments_ward_id_shift_date_shift_type_idx" ON "nurse_assignments"("ward_id", "shift_date", "shift_type");

-- CreateIndex
CREATE INDEX "nurse_doctor_assignments_tenant_id_nurse_id_is_active_idx" ON "nurse_doctor_assignments"("tenant_id", "nurse_id", "is_active");

-- CreateIndex
CREATE INDEX "nurse_doctor_assignments_tenant_id_doctor_id_is_active_idx" ON "nurse_doctor_assignments"("tenant_id", "doctor_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_staff_id_date_key" ON "attendance"("staff_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "salary_slips_payroll_id_key" ON "salary_slips"("payroll_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_slips_slip_number_key" ON "salary_slips"("slip_number");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_ticket_number_key" ON "tickets"("ticket_number");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_user_id_created_at_idx" ON "audit_logs"("tenant_id", "user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "patient_hospital_connections_patient_id_key" ON "patient_hospital_connections"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "patient_hospital_connections_user_id_tenant_id_key" ON "patient_hospital_connections"("user_id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transfers_razorpay_order_id_key" ON "payment_transfers"("razorpay_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "hospital_commissions_tenant_id_key" ON "hospital_commissions"("tenant_id");

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_user_subscription_id_fkey" FOREIGN KEY ("user_subscription_id") REFERENCES "user_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_toggles" ADD CONSTRAINT "feature_toggles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_owners" ADD CONSTRAINT "tenant_owners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_owners" ADD CONSTRAINT "tenant_owners_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_audit_logs" ADD CONSTRAINT "login_audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_audit_logs" ADD CONSTRAINT "login_audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_trial_plan_id_fkey" FOREIGN KEY ("trial_plan_id") REFERENCES "subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_created_tenant_id_fkey" FOREIGN KEY ("created_tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_requests" ADD CONSTRAINT "demo_requests_created_user_id_fkey" FOREIGN KEY ("created_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_head_user_id_fkey" FOREIGN KEY ("head_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floors" ADD CONSTRAINT "floors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wards" ADD CONSTRAINT "wards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wards" ADD CONSTRAINT "wards_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wards" ADD CONSTRAINT "wards_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beds" ADD CONSTRAINT "beds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beds" ADD CONSTRAINT "beds_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "beds" ADD CONSTRAINT "beds_current_patient_id_fkey" FOREIGN KEY ("current_patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operating_theaters" ADD CONSTRAINT "operating_theaters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_resources" ADD CONSTRAINT "hospital_resources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_resources" ADD CONSTRAINT "hospital_resources_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_emergency_contacts" ADD CONSTRAINT "patient_emergency_contacts_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_personal_history" ADD CONSTRAINT "patient_personal_history_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_personal_history" ADD CONSTRAINT "patient_personal_history_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_family_history" ADD CONSTRAINT "patient_family_history_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_allergies" ADD CONSTRAINT "patient_allergies_noted_by_fkey" FOREIGN KEY ("noted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_current_medications" ADD CONSTRAINT "patient_current_medications_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_current_medications" ADD CONSTRAINT "patient_current_medications_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_privacy_settings" ADD CONSTRAINT "patient_privacy_settings_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abha_sync_logs" ADD CONSTRAINT "abha_sync_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abha_sync_logs" ADD CONSTRAINT "abha_sync_logs_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedules" ADD CONSTRAINT "doctor_schedules_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_schedule_overrides" ADD CONSTRAINT "doctor_schedule_overrides_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_override_shifts" ADD CONSTRAINT "doctor_override_shifts_override_id_fkey" FOREIGN KEY ("override_id") REFERENCES "doctor_schedule_overrides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_leaves" ADD CONSTRAINT "doctor_leaves_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_by_fkey" FOREIGN KEY ("booked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_tokens" ADD CONSTRAINT "queue_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_tokens" ADD CONSTRAINT "queue_tokens_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_tokens" ADD CONSTRAINT "queue_tokens_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_tokens" ADD CONSTRAINT "queue_tokens_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visits" ADD CONSTRAINT "visits_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "beds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_admitted_by_fkey" FOREIGN KEY ("admitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_discharged_by_fkey" FOREIGN KEY ("discharged_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_from_doctor_id_fkey" FOREIGN KEY ("from_doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_to_doctor_id_fkey" FOREIGN KEY ("to_doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_from_bed_id_fkey" FOREIGN KEY ("from_bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_to_bed_id_fkey" FOREIGN KEY ("to_bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_from_ward_id_fkey" FOREIGN KEY ("from_ward_id") REFERENCES "wards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_to_ward_id_fkey" FOREIGN KEY ("to_ward_id") REFERENCES "wards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_transfers" ADD CONSTRAINT "patient_transfers_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimations" ADD CONSTRAINT "estimations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimations" ADD CONSTRAINT "estimations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimations" ADD CONSTRAINT "estimations_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimations" ADD CONSTRAINT "estimations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_supersedes_vital_id_fkey" FOREIGN KEY ("supersedes_vital_id") REFERENCES "vitals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_corrected_by_id_fkey" FOREIGN KEY ("corrected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_diagnosed_by_fkey" FOREIGN KEY ("diagnosed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_notes" ADD CONSTRAINT "progress_notes_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_notes" ADD CONSTRAINT "progress_notes_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_notes" ADD CONSTRAINT "progress_notes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_notes" ADD CONSTRAINT "progress_notes_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_notes" ADD CONSTRAINT "progress_notes_signed_by_id_fkey" FOREIGN KEY ("signed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_note_templates" ADD CONSTRAINT "progress_note_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_note_templates" ADD CONSTRAINT "progress_note_templates_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_note_amendments" ADD CONSTRAINT "progress_note_amendments_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "progress_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_note_amendments" ADD CONSTRAINT "progress_note_amendments_editor_id_fkey" FOREIGN KEY ("editor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "progress_note_pins" ADD CONSTRAINT "progress_note_pins_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "progress_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "physical_observation_catalog" ADD CONSTRAINT "physical_observation_catalog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursing_notes" ADD CONSTRAINT "nursing_notes_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursing_notes" ADD CONSTRAINT "nursing_notes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursing_notes" ADD CONSTRAINT "nursing_notes_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursing_notes" ADD CONSTRAINT "nursing_notes_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iv_line_records" ADD CONSTRAINT "iv_line_records_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iv_line_records" ADD CONSTRAINT "iv_line_records_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iv_line_records" ADD CONSTRAINT "iv_line_records_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iv_line_records" ADD CONSTRAINT "iv_line_records_inserted_by_fkey" FOREIGN KEY ("inserted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iv_line_records" ADD CONSTRAINT "iv_line_records_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_output_records" ADD CONSTRAINT "intake_output_records_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_output_records" ADD CONSTRAINT "intake_output_records_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_output_records" ADD CONSTRAINT "intake_output_records_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intake_output_records" ADD CONSTRAINT "intake_output_records_iv_line_id_fkey" FOREIGN KEY ("iv_line_id") REFERENCES "iv_line_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wound_care_records" ADD CONSTRAINT "wound_care_records_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wound_care_records" ADD CONSTRAINT "wound_care_records_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wound_care_records" ADD CONSTRAINT "wound_care_records_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursing_admission_assessments" ADD CONSTRAINT "nursing_admission_assessments_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursing_admission_assessments" ADD CONSTRAINT "nursing_admission_assessments_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursing_admission_assessments" ADD CONSTRAINT "nursing_admission_assessments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nursing_admission_assessments" ADD CONSTRAINT "nursing_admission_assessments_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pain_assessments" ADD CONSTRAINT "pain_assessments_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pain_assessments" ADD CONSTRAINT "pain_assessments_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pain_assessments" ADD CONSTRAINT "pain_assessments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pain_assessments" ADD CONSTRAINT "pain_assessments_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fall_risk_assessments" ADD CONSTRAINT "fall_risk_assessments_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fall_risk_assessments" ADD CONSTRAINT "fall_risk_assessments_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fall_risk_assessments" ADD CONSTRAINT "fall_risk_assessments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fall_risk_assessments" ADD CONSTRAINT "fall_risk_assessments_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_observations" ADD CONSTRAINT "clinical_observations_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_observations" ADD CONSTRAINT "clinical_observations_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_observations" ADD CONSTRAINT "clinical_observations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_observations" ADD CONSTRAINT "clinical_observations_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_devices" ADD CONSTRAINT "clinical_devices_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_devices" ADD CONSTRAINT "clinical_devices_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_devices" ADD CONSTRAINT "clinical_devices_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_devices" ADD CONSTRAINT "clinical_devices_inserted_by_fkey" FOREIGN KEY ("inserted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_devices" ADD CONSTRAINT "clinical_devices_removed_by_fkey" FOREIGN KEY ("removed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_devices" ADD CONSTRAINT "clinical_devices_created_by_procedure_id_fkey" FOREIGN KEY ("created_by_procedure_id") REFERENCES "clinical_procedures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_device_checks" ADD CONSTRAINT "clinical_device_checks_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "clinical_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_device_checks" ADD CONSTRAINT "clinical_device_checks_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_device_checks" ADD CONSTRAINT "clinical_device_checks_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_device_checks" ADD CONSTRAINT "clinical_device_checks_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_procedures" ADD CONSTRAINT "clinical_procedures_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_procedures" ADD CONSTRAINT "clinical_procedures_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_procedures" ADD CONSTRAINT "clinical_procedures_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_procedures" ADD CONSTRAINT "clinical_procedures_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discharge_summaries" ADD CONSTRAINT "discharge_summaries_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discharge_summaries" ADD CONSTRAINT "discharge_summaries_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discharge_summaries" ADD CONSTRAINT "discharge_summaries_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discharge_summaries" ADD CONSTRAINT "discharge_summaries_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discharge_summaries" ADD CONSTRAINT "discharge_summaries_signed_by_fkey" FOREIGN KEY ("signed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_drug_id_fkey" FOREIGN KEY ("drug_id") REFERENCES "drug_formulary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_prescription_item_id_fkey" FOREIGN KEY ("prescription_item_id") REFERENCES "prescription_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_administered_by_fkey" FOREIGN KEY ("administered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_time_slots" ADD CONSTRAINT "emar_time_slots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_frequencies" ADD CONSTRAINT "emar_frequencies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_settings" ADD CONSTRAINT "emar_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_schedules" ADD CONSTRAINT "emar_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_schedules" ADD CONSTRAINT "emar_schedules_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_schedules" ADD CONSTRAINT "emar_schedules_prescription_item_id_fkey" FOREIGN KEY ("prescription_item_id") REFERENCES "prescription_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_schedules" ADD CONSTRAINT "emar_schedules_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_schedules" ADD CONSTRAINT "emar_schedules_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_schedules" ADD CONSTRAINT "emar_schedules_given_by_id_fkey" FOREIGN KEY ("given_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_schedules" ADD CONSTRAINT "emar_schedules_amended_by_id_fkey" FOREIGN KEY ("amended_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_audit_logs" ADD CONSTRAINT "emar_audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_audit_logs" ADD CONSTRAINT "emar_audit_logs_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "emar_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emar_audit_logs" ADD CONSTRAINT "emar_audit_logs_performed_by_id_fkey" FOREIGN KEY ("performed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_departments" ADD CONSTRAINT "lab_departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_test_catalog" ADD CONSTRAINT "lab_test_catalog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_test_catalog" ADD CONSTRAINT "lab_test_catalog_lab_department_id_fkey" FOREIGN KEY ("lab_department_id") REFERENCES "lab_departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_ordered_by_fkey" FOREIGN KEY ("ordered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_assigned_dept_id_fkey" FOREIGN KEY ("assigned_dept_id") REFERENCES "lab_departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_lab_order_id_fkey" FOREIGN KEY ("lab_order_id") REFERENCES "lab_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "lab_test_catalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_samples" ADD CONSTRAINT "lab_samples_lab_order_id_fkey" FOREIGN KEY ("lab_order_id") REFERENCES "lab_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_samples" ADD CONSTRAINT "lab_samples_collected_by_fkey" FOREIGN KEY ("collected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_lab_order_item_id_fkey" FOREIGN KEY ("lab_order_item_id") REFERENCES "lab_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_lab_order_id_fkey" FOREIGN KEY ("lab_order_id") REFERENCES "lab_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_entered_by_fkey" FOREIGN KEY ("entered_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_lab_order_id_fkey" FOREIGN KEY ("lab_order_id") REFERENCES "lab_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_reports" ADD CONSTRAINT "lab_reports_signed_by_fkey" FOREIGN KEY ("signed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_requests" ADD CONSTRAINT "imaging_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_requests" ADD CONSTRAINT "imaging_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_requests" ADD CONSTRAINT "imaging_requests_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_requests" ADD CONSTRAINT "imaging_requests_ordered_by_fkey" FOREIGN KEY ("ordered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_requests" ADD CONSTRAINT "imaging_requests_assigned_technician_id_fkey" FOREIGN KEY ("assigned_technician_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_results" ADD CONSTRAINT "imaging_results_imaging_request_id_fkey" FOREIGN KEY ("imaging_request_id") REFERENCES "imaging_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_results" ADD CONSTRAINT "imaging_results_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_results" ADD CONSTRAINT "imaging_results_radiologist_id_fkey" FOREIGN KEY ("radiologist_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "imaging_results" ADD CONSTRAINT "imaging_results_signed_by_fkey" FOREIGN KEY ("signed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_categories" ADD CONSTRAINT "drug_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_formulary" ADD CONSTRAINT "drug_formulary_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_formulary" ADD CONSTRAINT "drug_formulary_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "drug_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_batches" ADD CONSTRAINT "drug_batches_drug_id_fkey" FOREIGN KEY ("drug_id") REFERENCES "drug_formulary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_batches" ADD CONSTRAINT "drug_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_batches" ADD CONSTRAINT "drug_batches_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_records" ADD CONSTRAINT "dispensing_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_records" ADD CONSTRAINT "dispensing_records_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_records" ADD CONSTRAINT "dispensing_records_prescription_item_id_fkey" FOREIGN KEY ("prescription_item_id") REFERENCES "prescription_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_records" ADD CONSTRAINT "dispensing_records_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_records" ADD CONSTRAINT "dispensing_records_drug_batch_id_fkey" FOREIGN KEY ("drug_batch_id") REFERENCES "drug_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_records" ADD CONSTRAINT "dispensing_records_dispensed_by_fkey" FOREIGN KEY ("dispensed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispensing_records" ADD CONSTRAINT "dispensing_records_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_returns" ADD CONSTRAINT "drug_returns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_returns" ADD CONSTRAINT "drug_returns_drug_batch_id_fkey" FOREIGN KEY ("drug_batch_id") REFERENCES "drug_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_returns" ADD CONSTRAINT "drug_returns_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_returns" ADD CONSTRAINT "drug_returns_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_returns" ADD CONSTRAINT "drug_returns_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transactions" ADD CONSTRAINT "stock_transactions_performed_by_fkey" FOREIGN KEY ("performed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supply_requests" ADD CONSTRAINT "supply_requests_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tariffs" ADD CONSTRAINT "service_tariffs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_service_tariff_id_fkey" FOREIGN KEY ("service_tariff_id") REFERENCES "service_tariffs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discounts" ADD CONSTRAINT "discounts_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurers" ADD CONSTRAINT "insurers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tpa_providers" ADD CONSTRAINT "tpa_providers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_insurer_id_fkey" FOREIGN KEY ("insurer_id") REFERENCES "insurers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_policies" ADD CONSTRAINT "insurance_policies_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpa_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_claims" ADD CONSTRAINT "insurance_claims_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_authorization_requests" ADD CONSTRAINT "pre_authorization_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_authorization_requests" ADD CONSTRAINT "pre_authorization_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_authorization_requests" ADD CONSTRAINT "pre_authorization_requests_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "insurance_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_authorization_requests" ADD CONSTRAINT "pre_authorization_requests_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tpa_communication_logs" ADD CONSTRAINT "tpa_communication_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tpa_communication_logs" ADD CONSTRAINT "tpa_communication_logs_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "insurance_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tpa_communication_logs" ADD CONSTRAINT "tpa_communication_logs_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpa_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tpa_communication_logs" ADD CONSTRAINT "tpa_communication_logs_communicated_by_fkey" FOREIGN KEY ("communicated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blood_donors" ADD CONSTRAINT "blood_donors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blood_donations" ADD CONSTRAINT "blood_donations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blood_donations" ADD CONSTRAINT "blood_donations_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "blood_donors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blood_donations" ADD CONSTRAINT "blood_donations_collected_by_fkey" FOREIGN KEY ("collected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blood_inventory" ADD CONSTRAINT "blood_inventory_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blood_inventory" ADD CONSTRAINT "blood_inventory_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "blood_donations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cross_match_tests" ADD CONSTRAINT "cross_match_tests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cross_match_tests" ADD CONSTRAINT "cross_match_tests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cross_match_tests" ADD CONSTRAINT "cross_match_tests_blood_inventory_id_fkey" FOREIGN KEY ("blood_inventory_id") REFERENCES "blood_inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cross_match_tests" ADD CONSTRAINT "cross_match_tests_tested_by_fkey" FOREIGN KEY ("tested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_blood_inventory_id_fkey" FOREIGN KEY ("blood_inventory_id") REFERENCES "blood_inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_cross_match_id_fkey" FOREIGN KEY ("cross_match_id") REFERENCES "cross_match_tests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_administered_by_fkey" FOREIGN KEY ("administered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_ordered_by_fkey" FOREIGN KEY ("ordered_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_licenses" ADD CONSTRAINT "staff_licenses_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duty_rosters" ADD CONSTRAINT "duty_rosters_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_assignments" ADD CONSTRAINT "nurse_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_assignments" ADD CONSTRAINT "nurse_assignments_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_assignments" ADD CONSTRAINT "nurse_assignments_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_assignments" ADD CONSTRAINT "nurse_assignments_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_assignments" ADD CONSTRAINT "nurse_assignments_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "beds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_assignments" ADD CONSTRAINT "nurse_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_assignments" ADD CONSTRAINT "nurse_assignments_handed_over_to_id_fkey" FOREIGN KEY ("handed_over_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_assignments" ADD CONSTRAINT "nurse_assignments_handover_note_id_fkey" FOREIGN KEY ("handover_note_id") REFERENCES "shift_handover_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_doctor_assignments" ADD CONSTRAINT "nurse_doctor_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_doctor_assignments" ADD CONSTRAINT "nurse_doctor_assignments_nurse_id_fkey" FOREIGN KEY ("nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_doctor_assignments" ADD CONSTRAINT "nurse_doctor_assignments_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurse_doctor_assignments" ADD CONSTRAINT "nurse_doctor_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll" ADD CONSTRAINT "payroll_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll" ADD CONSTRAINT "payroll_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll" ADD CONSTRAINT "payroll_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_slips" ADD CONSTRAINT "salary_slips_payroll_id_fkey" FOREIGN KEY ("payroll_id") REFERENCES "payroll"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_slips" ADD CONSTRAINT "salary_slips_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_receiver_id_fkey" FOREIGN KEY ("receiver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_fkey" FOREIGN KEY ("parent_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_handover_notes" ADD CONSTRAINT "shift_handover_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_handover_notes" ADD CONSTRAINT "shift_handover_notes_from_nurse_id_fkey" FOREIGN KEY ("from_nurse_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_handover_notes" ADD CONSTRAINT "shift_handover_notes_to_nurse_id_fkey" FOREIGN KEY ("to_nurse_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_handover_notes" ADD CONSTRAINT "shift_handover_notes_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_raised_by_fkey" FOREIGN KEY ("raised_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_escalated_to_fkey" FOREIGN KEY ("escalated_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_documents" ADD CONSTRAINT "compliance_documents_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ot_requests" ADD CONSTRAINT "ot_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ot_requests" ADD CONSTRAINT "ot_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ot_requests" ADD CONSTRAINT "ot_requests_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ot_requests" ADD CONSTRAINT "ot_requests_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctor_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ot_requests" ADD CONSTRAINT "ot_requests_ot_id_fkey" FOREIGN KEY ("ot_id") REFERENCES "operating_theaters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_escalated_to_fkey" FOREIGN KEY ("escalated_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_reports" ADD CONSTRAINT "saved_reports_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_reports" ADD CONSTRAINT "scheduled_reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_raised_by_fkey" FOREIGN KEY ("raised_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_hospital_connections" ADD CONSTRAINT "patient_hospital_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_hospital_connections" ADD CONSTRAINT "patient_hospital_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_hospital_connections" ADD CONSTRAINT "patient_hospital_connections_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_hospital_connections" ADD CONSTRAINT "patient_hospital_connections_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mrd_requests" ADD CONSTRAINT "mrd_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mrd_requests" ADD CONSTRAINT "mrd_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mrd_requests" ADD CONSTRAINT "mrd_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transfers" ADD CONSTRAINT "payment_transfers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transfers" ADD CONSTRAINT "payment_transfers_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_settings" ADD CONSTRAINT "commission_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_commissions" ADD CONSTRAINT "hospital_commissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hospital_commissions" ADD CONSTRAINT "hospital_commissions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
