import { Router } from 'express';
import { userTierLimiter } from '../middleware/rateLimiter';
import { authenticate } from '../middleware/authenticate';
import { requireFeature, requireActiveSubscription } from '../middleware/authorize';

// Core modules
import { authRoutes } from './auth/auth.routes';
import { tenantRoutes } from './tenants/tenants.routes';
import { userRouter, roleRouter } from './users/users.routes';

// Fully implemented modules
import { patientRoutes } from './patients/patients.routes';
import { emergencyRoutes } from './emergency/emergency.routes';
import { appointmentRoutes } from './appointments/appointments.routes';
import { billingRoutes } from './billing/billing.routes';

// Domain modules
import { infrastructureRoutes } from './infrastructure/infrastructure.routes';
import { clinicalRoutes } from './clinical/clinical.routes';
import { progressNotesRoutes } from './progress-notes/progress-notes.routes';
import { nursingFormsRoutes } from './nursing-forms/nursing-forms.routes';
import { formsRoutes } from './forms/forms.routes';
import { prescriptionRoutes } from './prescriptions/prescriptions.routes';
import { emarRoutes } from './emar/emar.routes';
import { labRoutes } from './lab/lab.routes';
import { cdssRoutes } from './cdss/cdss.routes';
import { imagingRoutes } from './imaging/imaging.routes';
import { buildPacsRouter } from './imaging/pacs';
import { pharmacyRoutes } from './pharmacy/pharmacy.routes';
import { ndpsRoutes } from './ndps/ndps.routes';
import { otKitRoutes } from './ot-kit/ot-kit.routes';
import { indentRoutes } from './indents/indents.routes';
import { inventoryRoutes } from './inventory/inventory.routes';
import { insuranceRoutes } from './insurance/insurance.routes';
import { bloodBankRoutes } from './blood-bank/blood-bank.routes';
import { hrRoutes } from './hr/hr.routes';
import { communicationRoutes } from './communication/communication.routes';
import { complianceRoutes } from './compliance/compliance.routes';
import { reportsRoutes } from './reports/reports.routes';
import { dashboardRoutes } from './dashboard/dashboard.routes';
import { subscriptionPlanRoutes } from './subscriptions/subscriptions.routes';
import { hospitalsRoutes } from './hospitals/hospitals.routes';
import { patientPortalRoutes } from './patient-portal/patient-portal.routes';
import { connectionAdminRoutes } from './patient-portal/connection-admin.routes';
import { mrdRoutes } from './mrd/mrd.routes';
import { medicalHistoryRoutes } from './medical-history/medical-history.routes';
import { commissionRoutes } from './commission/commission.routes';
import { bankLinkingRoutes } from './bank-linking/bank-linking.routes';
import { onlinePaymentsRoutes } from './online-payments/online-payments.routes';
import { demoRequestRoutes } from './demo-requests/demo-requests.routes';
import { drugMasterRoutes } from './drug-master/drug-master.routes';
import { discountPolicyRoutes } from './discount-policy/discount-policy.routes';
import { aiRoutes } from './ai/ai.routes';
import { icdRoutes } from './icd/icd.routes';
import { platformBrandingRoutes } from './platform-branding/platform-branding.routes';
import { hospitalBrandingRoutes } from './hospital-branding/hospital-branding.routes';

const apiRouter = Router();

// NOTE on rate limiting:
//   - Global per-IP limiting happens at the app level (see app.ts).
//   - Per-user, role-tiered limiting is mounted per route group below,
//     AFTER `authenticate` so the limiter has `req.user` and can apply the
//     right tier (doctors/nurses/front-desk get the HIGH budget).
//   - Auth endpoints get their own stricter IP-keyed limiter inside
//     `auth.routes.ts` (login/register/reset).

// --- Core modules (no feature gate — always available) ---
apiRouter.use('/auth', authRoutes);
apiRouter.use('/tenants', authenticate, userTierLimiter, tenantRoutes);
apiRouter.use('/users', authenticate, userTierLimiter, userRouter);
apiRouter.use('/roles', authenticate, userTierLimiter, roleRouter);
apiRouter.use('/patients', authenticate, userTierLimiter, patientRoutes);
// Front-desk Emergency / Casualty flow (temp patient → OP/IP → register-or-connect).
// Core, un-feature-gated: a casualty must never be blocked, and it spans both the
// appointments (OP) and ip_management (IP) features. Per-route permission checks
// (patients create/read/update) still apply.
apiRouter.use('/emergency', authenticate, userTierLimiter, emergencyRoutes);
apiRouter.use('/dashboard', authenticate, userTierLimiter, dashboardRoutes);
apiRouter.use('/infrastructure', authenticate, userTierLimiter, infrastructureRoutes);
apiRouter.use('/communication', authenticate, userTierLimiter, communicationRoutes);
// Platform-wide Indian drug catalog (reference data, like ICD codes). No
// feature gate: super-admin manages it; any clinical/pharmacy user searches it
// to pick a drug or import it into the hospital formulary.
apiRouter.use('/drug-master', authenticate, userTierLimiter, drugMasterRoutes);
// Platform + per-tenant ICD-10 diagnosis code catalog (reference data). No
// feature gate: super-admin manages the shared set; any clinical user searches
// it for diagnosis autocomplete.
apiRouter.use('/icd', authenticate, userTierLimiter, icdRoutes);
// AI / LLM use cases (patient chatbot, platform support chatbot, discharge
// generation) + super-admin LLM provider config. Cross-cutting, so mounted as
// a core module with per-route permission checks (no single feature gate).
apiRouter.use('/ai', authenticate, userTierLimiter, aiRoutes);
// Platform branding (the two super-admin logo variants). GET is PUBLIC so the
// pre-auth login screen / website can render the logo; upload/delete are
// super-admin only (guarded inside the router).
apiRouter.use('/platform-branding', platformBrandingRoutes);
apiRouter.use('/hospital-branding', hospitalBrandingRoutes);

// PACS auth gateway. Mounted WITHOUT the global `authenticate` because its
// /o/* proxy authenticates via the pacs_session cookie (the OHIF iframe can't
// send a Bearer token); /session itself is Bearer-authed internally.
apiRouter.use('/pacs', buildPacsRouter());

// --- Feature-gated modules ---
// authenticate → user-tier limiter → subscription check → feature check → route handlers
const subCheck = requireActiveSubscription();
apiRouter.use('/appointments', authenticate, userTierLimiter, subCheck, requireFeature('appointments'), appointmentRoutes);
apiRouter.use('/billing', authenticate, userTierLimiter, subCheck, requireFeature('billing'), billingRoutes);
apiRouter.use('/clinical', authenticate, userTierLimiter, subCheck, requireFeature('ip_management'), clinicalRoutes);
apiRouter.use('/progress-notes', authenticate, userTierLimiter, subCheck, requireFeature('ip_management'), progressNotesRoutes);
apiRouter.use('/nursing-forms', authenticate, userTierLimiter, subCheck, requireFeature('ip_management'), nursingFormsRoutes);
apiRouter.use('/forms', authenticate, userTierLimiter, subCheck, requireFeature('ip_management'), formsRoutes);
apiRouter.use('/prescriptions', authenticate, userTierLimiter, subCheck, requireFeature('appointments'), prescriptionRoutes);
apiRouter.use('/emar', authenticate, userTierLimiter, subCheck, requireFeature('ip_management'), emarRoutes);
apiRouter.use('/lab', authenticate, userTierLimiter, subCheck, requireFeature('lab'), labRoutes);
// CDSS is cross-module (prescriptions + lab + diagnoses), so we mount it
// against the prescriptions feature flag since the primary surface is the
// doctor's prescription pad.
apiRouter.use('/cdss', authenticate, userTierLimiter, subCheck, requireFeature('appointments'), cdssRoutes);
apiRouter.use('/imaging', authenticate, userTierLimiter, subCheck, requireFeature('imaging'), imagingRoutes);
apiRouter.use('/pharmacy', authenticate, userTierLimiter, subCheck, requireFeature('pharmacy'), pharmacyRoutes);
apiRouter.use('/ndps', authenticate, userTierLimiter, subCheck, requireFeature('pharmacy'), ndpsRoutes);
// OT "Kit" — surgical preference-card templates + issue-bulk / reconcile-net
// virtual OT ledger (design doc III). Pharmacy-feature-gated (pharmacy issues,
// bills and reverses the stock); the OT nurse's pre-op request is permission-open.
apiRouter.use('/ot-kit', authenticate, userTierLimiter, subCheck, requireFeature('pharmacy'), otKitRoutes);
// IP medication indents — ward→pharmacy request → approve → dispense → deliver →
// acknowledge lifecycle (design doc I). Pharmacy-feature-gated; nurse-facing
// raise/acknowledge are permission-open, pharmacist approve/dispense are gated.
apiRouter.use('/indents', authenticate, userTierLimiter, subCheck, requireFeature('pharmacy'), indentRoutes);
apiRouter.use('/inventory', authenticate, userTierLimiter, subCheck, requireFeature('inventory'), inventoryRoutes);
// Margin-based system-wide discount — separate module, gated on the pharmacy feature.
apiRouter.use('/discount-policy', authenticate, userTierLimiter, subCheck, requireFeature('pharmacy'), discountPolicyRoutes);
apiRouter.use('/insurance', authenticate, userTierLimiter, subCheck, requireFeature('insurance'), insuranceRoutes);
apiRouter.use('/blood-bank', authenticate, userTierLimiter, subCheck, requireFeature('blood_bank'), bloodBankRoutes);
apiRouter.use('/hr', authenticate, userTierLimiter, subCheck, requireFeature('hr'), hrRoutes);
apiRouter.use('/compliance', authenticate, userTierLimiter, subCheck, requireFeature('compliance'), complianceRoutes);
apiRouter.use('/reports', authenticate, userTierLimiter, subCheck, requireFeature('reports'), reportsRoutes);
apiRouter.use('/mrd', authenticate, userTierLimiter, subCheck, requireFeature('ip_management'), mrdRoutes);
apiRouter.use('/medical-history', authenticate, userTierLimiter, subCheck, medicalHistoryRoutes);

// --- Subscription Plans (public + super_admin) ---
// Mixed public/private endpoints (webhook + listing are public). We rely on
// the global IP limiter at the app level here; per-user limiting is not
// applied because we can't safely force-authenticate the public paths.
apiRouter.use('/subscription-plans', subscriptionPlanRoutes);

// --- Patient Portal (every endpoint authenticates internally) ---
apiRouter.use('/patient-portal', authenticate, userTierLimiter, patientPortalRoutes);

// --- Patient Connection Management (hospital staff) ---
apiRouter.use('/patient-connections', authenticate, userTierLimiter, connectionAdminRoutes);

// --- Razorpay Route: Split Payments ---
// Webhook lives under this prefix → cannot force-authenticate at router level.
apiRouter.use('/online-payments', onlinePaymentsRoutes);
apiRouter.use('/bank-linking', authenticate, userTierLimiter, bankLinkingRoutes);
apiRouter.use('/commission', authenticate, userTierLimiter, commissionRoutes);

// --- Hospitals (authenticated staff / super_admin) ---
apiRouter.use('/hospitals', authenticate, userTierLimiter, hospitalsRoutes);

// --- Demo Requests (public submit + super_admin management) ---
apiRouter.use('/demo-requests', demoRequestRoutes);

export { apiRouter };
