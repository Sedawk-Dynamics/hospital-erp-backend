import { Router } from 'express';
import { generalLimiter } from '../middleware/rateLimiter';
import { authenticate } from '../middleware/authenticate';
import { requireFeature, requireActiveSubscription } from '../middleware/authorize';

// Core modules
import { authRoutes } from './auth/auth.routes';
import { tenantRoutes } from './tenants/tenants.routes';
import { userRouter, roleRouter } from './users/users.routes';

// Fully implemented modules
import { patientRoutes } from './patients/patients.routes';
import { appointmentRoutes } from './appointments/appointments.routes';
import { billingRoutes } from './billing/billing.routes';

// Domain modules
import { infrastructureRoutes } from './infrastructure/infrastructure.routes';
import { clinicalRoutes } from './clinical/clinical.routes';
import { progressNotesRoutes } from './progress-notes/progress-notes.routes';
import { prescriptionRoutes } from './prescriptions/prescriptions.routes';
import { labRoutes } from './lab/lab.routes';
import { imagingRoutes } from './imaging/imaging.routes';
import { pharmacyRoutes } from './pharmacy/pharmacy.routes';
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
import { commissionRoutes } from './commission/commission.routes';
import { bankLinkingRoutes } from './bank-linking/bank-linking.routes';
import { onlinePaymentsRoutes } from './online-payments/online-payments.routes';
import { demoRequestRoutes } from './demo-requests/demo-requests.routes';
import { formsRoutes } from './forms/forms.routes';

const apiRouter = Router();

// Apply general rate limiting to all API routes
apiRouter.use(generalLimiter);

// --- Core modules (no feature gate — always available) ---
apiRouter.use('/auth', authRoutes);
apiRouter.use('/tenants', tenantRoutes);
apiRouter.use('/users', userRouter);
apiRouter.use('/roles', roleRouter);
apiRouter.use('/patients', patientRoutes);
apiRouter.use('/dashboard', dashboardRoutes);
apiRouter.use('/infrastructure', infrastructureRoutes);
apiRouter.use('/communication', communicationRoutes);

// --- Feature-gated modules ---
// authenticate → subscription check → feature check → route handlers
const subCheck = requireActiveSubscription();
apiRouter.use('/appointments', authenticate, subCheck, requireFeature('appointments'), appointmentRoutes);
apiRouter.use('/billing', authenticate, subCheck, requireFeature('billing'), billingRoutes);
apiRouter.use('/clinical', authenticate, subCheck, requireFeature('ip_management'), clinicalRoutes);
apiRouter.use('/progress-notes', authenticate, subCheck, requireFeature('ip_management'), progressNotesRoutes);
apiRouter.use('/prescriptions', authenticate, subCheck, requireFeature('appointments'), prescriptionRoutes);
apiRouter.use('/lab', authenticate, subCheck, requireFeature('lab'), labRoutes);
apiRouter.use('/imaging', authenticate, subCheck, requireFeature('imaging'), imagingRoutes);
apiRouter.use('/pharmacy', authenticate, subCheck, requireFeature('pharmacy'), pharmacyRoutes);
apiRouter.use('/inventory', authenticate, subCheck, requireFeature('inventory'), inventoryRoutes);
apiRouter.use('/insurance', authenticate, subCheck, requireFeature('insurance'), insuranceRoutes);
apiRouter.use('/blood-bank', authenticate, subCheck, requireFeature('blood_bank'), bloodBankRoutes);
apiRouter.use('/hr', authenticate, subCheck, requireFeature('hr'), hrRoutes);
apiRouter.use('/compliance', authenticate, subCheck, requireFeature('compliance'), complianceRoutes);
apiRouter.use('/reports', authenticate, subCheck, requireFeature('reports'), reportsRoutes);
apiRouter.use('/mrd', authenticate, subCheck, requireFeature('ip_management'), mrdRoutes);

// --- Subscription Plans (public + super_admin) ---
apiRouter.use('/subscription-plans', subscriptionPlanRoutes);

// --- Patient Portal (authenticated patients) ---
apiRouter.use('/patient-portal', patientPortalRoutes);

// --- Patient Connection Management (hospital staff) ---
apiRouter.use('/patient-connections', connectionAdminRoutes);

// --- Razorpay Route: Split Payments ---
apiRouter.use('/online-payments', onlinePaymentsRoutes);
apiRouter.use('/bank-linking', bankLinkingRoutes);
apiRouter.use('/commission', commissionRoutes);

// --- Hospitals (super_admin) ---
apiRouter.use('/hospitals', hospitalsRoutes);

// --- Demo Requests (public submit + super_admin management) ---
apiRouter.use('/demo-requests', demoRequestRoutes);

// --- Form Template System (super_admin authoring + hospital usage) ---
apiRouter.use('/forms', formsRoutes);

export { apiRouter };
