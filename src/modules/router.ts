import { Router } from 'express';
import { generalLimiter } from '../middleware/rateLimiter';

// Core modules (created by other agents)
import { authRoutes } from './auth/auth.routes';
import { tenantRoutes } from './tenants/tenants.routes';
import { userRouter, roleRouter } from './users/users.routes';

// Fully implemented modules
import { patientRoutes } from './patients/patients.routes';
import { appointmentRoutes } from './appointments/appointments.routes';
import { billingRoutes } from './billing/billing.routes';

// Fully implemented domain modules
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

const apiRouter = Router();

// Apply general rate limiting to all API routes
apiRouter.use(generalLimiter);

// --- Core modules ---
apiRouter.use('/auth', authRoutes);
apiRouter.use('/tenants', tenantRoutes);
apiRouter.use('/users', userRouter);
apiRouter.use('/roles', roleRouter);

// --- Fully implemented modules ---
apiRouter.use('/patients', patientRoutes);
apiRouter.use('/appointments', appointmentRoutes);
apiRouter.use('/billing', billingRoutes);

// --- Domain modules ---
apiRouter.use('/infrastructure', infrastructureRoutes);
apiRouter.use('/clinical', clinicalRoutes);
apiRouter.use('/progress-notes', progressNotesRoutes);
apiRouter.use('/prescriptions', prescriptionRoutes);
apiRouter.use('/lab', labRoutes);
apiRouter.use('/imaging', imagingRoutes);
apiRouter.use('/pharmacy', pharmacyRoutes);
apiRouter.use('/inventory', inventoryRoutes);
apiRouter.use('/insurance', insuranceRoutes);
apiRouter.use('/blood-bank', bloodBankRoutes);
apiRouter.use('/hr', hrRoutes);
apiRouter.use('/communication', communicationRoutes);
apiRouter.use('/compliance', complianceRoutes);
apiRouter.use('/reports', reportsRoutes);

// --- Dashboard ---
apiRouter.use('/dashboard', dashboardRoutes);

export { apiRouter };
