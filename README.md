# Hospital ERP Backend

A production-ready, multi-tenant Hospital ERP SaaS backend built with **Node.js**, **Express**, **TypeScript**, **PostgreSQL** (Prisma ORM), and **Redis**.

---

## Tech Stack

| Technology | Purpose |
|-----------|---------|
| Node.js 20+ | Runtime |
| Express 4.x | HTTP framework |
| TypeScript 5.x | Type safety |
| PostgreSQL 16 | Primary database |
| Prisma 6.x | ORM & migrations |
| Redis 7 | Caching, sessions, rate limiting |
| JWT | Authentication (access + refresh tokens) |
| Zod | Request validation |
| Pino | Structured JSON logging |
| Bull | Background job queues |
| Multer | File uploads |
| Nodemailer | Email notifications |
| PDFKit | PDF generation |
| Docker | Containerization |

---

## Architecture

```
backend/
├── prisma/
│   ├── schema.prisma          # 101 models, 117 enums
│   └── seed.ts                # Database seeding (roles, permissions, demo data)
├── src/
│   ├── config/                # Environment, database, Redis, logger, CORS
│   │   ├── env.ts             # Zod-validated environment variables
│   │   ├── database.ts        # Prisma client singleton
│   │   ├── redis.ts           # Redis client with retry strategy
│   │   ├── logger.ts          # Pino structured logging
│   │   └── cors.ts            # CORS configuration
│   ├── middleware/            # Auth, RBAC, validation, rate limiting, errors
│   │   ├── authenticate.ts    # JWT Bearer token verification
│   │   ├── authorize.ts       # Role & permission checks (RBAC)
│   │   ├── validate.ts        # Zod schema validation
│   │   ├── rateLimiter.ts     # Redis-backed rate limiting
│   │   └── errorHandler.ts    # Global error handler (Zod, Prisma, AppError)
│   ├── modules/               # 22 feature modules (see below)
│   │   └── router.ts          # Main API router mounting all modules
│   ├── services/              # Cross-cutting: email, upload, PDF generation
│   │   ├── email.service.ts   # Nodemailer SMTP integration
│   │   ├── pdf.service.ts     # PDFKit document generation
│   │   └── upload.service.ts  # Multer file uploads
│   ├── shared/                # AppError, API response helpers, constants, types
│   │   ├── apiResponse.ts     # Standardized success response helper
│   │   ├── appError.ts        # Custom error class with HTTP codes
│   │   ├── constants.ts       # Application constants
│   │   ├── pagination.ts      # Pagination utilities
│   │   ├── role-permissions.ts # RBAC: 18 roles, 192 permissions
│   │   └── types.ts           # Global TypeScript types
│   ├── jobs/                  # Bull background job queues
│   ├── app.ts                 # Express app setup (middleware stack)
│   └── server.ts              # HTTP server with graceful shutdown
├── tests/                     # Vitest test files
├── uploads/                   # Local file storage
├── Dockerfile                 # Multi-stage production build
├── docker-compose.yml         # Production: PostgreSQL + Redis + API
├── docker-compose.dev.yml     # Development: PostgreSQL + Redis only
├── vitest.config.ts           # Test framework configuration
└── package.json
```

### Module Structure Pattern

Each module follows a consistent 4-file pattern:

```
modules/patients/
├── patients.controller.ts     # HTTP request handlers
├── patients.routes.ts         # Express Router with middleware
├── patients.service.ts        # Business logic & database queries
└── patients.validation.ts     # Zod request/response schemas
```

---

## Modules (22)

| Module | Endpoints | Description |
|--------|-----------|-------------|
| **auth** | 9 | JWT login, register, refresh, logout, password reset, 2FA (TOTP) |
| **tenants** | 7 | Multi-tenant hospital management, subscriptions, feature toggles |
| **users** | 10 | User CRUD, role assignment, permission management |
| **roles** | 5 | Role management, permission assignment |
| **patients** | 10 | Registration with auto-MRN, allergies, family history, documents |
| **appointments** | 12 | Doctor schedules, slot availability, booking, queue tokens |
| **billing** | 14 | Tariffs, bills, payments, receipts, refunds, discounts |
| **clinical** | 15 | Visits, admissions, transfers, vitals, diagnoses |
| **progress-notes** | 8 | SOAP progress notes, nursing notes |
| **prescriptions** | 9 | Prescriptions, items, medication administration |
| **lab** | 17 | Lab departments, test catalog, orders, samples, results, reports |
| **imaging** | 10 | Imaging requests, results, reports, verification |
| **pharmacy** | 14 | Drug formulary, batches, dispensing, returns |
| **inventory** | 18 | Suppliers, stock management, purchase orders, supply requests |
| **insurance** | 18 | Insurers, TPA, policies, claims, pre-authorization |
| **blood-bank** | 16 | Donors, donations, blood inventory, cross-match, transfusions |
| **hr** | 17 | Staff profiles, licenses, rosters, attendance, leave, payroll |
| **communication** | 12 | Notifications, messaging, shift handover notes |
| **compliance** | 17 | Tickets, feedback, audit logs, compliance docs, OT requests, incidents |
| **reports** | 13 | Saved reports, scheduled reports, support tickets |
| **infrastructure** | 13 | Departments, wards, rooms, beds, availability |
| **dashboard** | 1 | Aggregated statistics (patients, appointments, billing, beds, staff) |

**Total: ~240+ API endpoints**

---

## RBAC System

### 18 System Roles

| Role | Frontend Module(s) | Description |
|------|-------------------|-------------|
| `super_admin` | All 9 modules (incl. Doctor) | SaaS platform owner (tenant owner). Bypasses all permission checks. Platform-level role, not created per-tenant. |
| `admin` | All 8 admin modules | Hospital administrator who purchased a subscription. Manages their hospital's operations. Created per-tenant. |
| `doctor` | Doctor module | All doctor specializations (17 slugs) |
| `nurse` | Hospital, Ward | Ward & patient care |
| `front_desk` | Hospital | Reception, OP/IP, appointments |
| `lab_technician` | Laboratory | Lab sample processing |
| `lab_supervisor` | Laboratory | Lab oversight & approvals |
| `radiologist` | Radiology | Imaging operations |
| `pharmacist` | Pharmacy | Drug dispensing |
| `pharmacy_technician` | Pharmacy | Pharmacy support |
| `pharmacy_admin` | Pharmacy | Pharmacy management |
| `billing_admin` | Hospital | Billing oversight |
| `cashier` | Hospital | Payment collection |
| `insurance_staff` | Hospital | Claims processing |
| `inventory_manager` | Pharmacy, Laboratory, OT | Cross-module stock management |
| `blood_bank_staff` | Hospital | Blood bank operations |
| `hr_staff` | Hospital | HR & payroll |
| `patient` | Patient Portal (future) | Patient self-service |

### Doctor Specialization Slugs

All map to a single "Doctor" module on the frontend:

`doctor`, `general_physician`, `ent`, `diabetologist`, `obstetrics_gynaecologist`, `cardiologist`, `dermatologist`, `neurologist`, `ophthalmologist`, `orthopedic`, `pediatrician`, `psychiatrist`, `pulmonologist`, `surgeon`, `urologist`, `opt`, `physiotherapist`

### 33 Modules x 6 Actions = 192 Permissions

Actions: `create`, `read`, `update`, `delete`, `export`, `approve`

---

## Getting Started

### Prerequisites

- Node.js >= 20.0.0
- PostgreSQL 16+
- Redis 7+
- npm or yarn

### Option 1: Docker (Recommended)

```bash
# Start all services (PostgreSQL, Redis, API)
docker-compose up -d

# Or development mode (DB + Redis only, run API locally)
docker-compose -f docker-compose.dev.yml up -d
npm run dev
```

### Option 2: Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your database and Redis credentials

# 3. Setup database
npm run db:push        # Push schema to database
npm run db:generate    # Generate Prisma client
npm run db:seed        # Seed initial data (roles, permissions, demo tenant)

# 4. Start development server
npm run dev            # Runs on http://localhost:4000
```

---

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://hospital_admin:hospital_pass@localhost:5432/hospital_erp

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_ACCESS_SECRET=your-access-secret-change-in-production
JWT_REFRESH_SECRET=your-refresh-secret-change-in-production
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# Server
PORT=4000
NODE_ENV=development
FRONTEND_URL=http://localhost:3000

# Security
BCRYPT_SALT_ROUNDS=12

# SMTP (Email Notifications)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password
SMTP_FROM=noreply@hospital-erp.com
```

---

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start dev server with hot reload (tsx watch) |
| `npm run build` | Compile TypeScript to dist/ |
| `npm run start` | Run production build |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:migrate` | Run database migrations |
| `npm run db:push` | Push schema to database (dev) |
| `npm run db:seed` | Seed database with initial data |
| `npm run db:studio` | Open Prisma Studio GUI |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | Run ESLint |
| `npm run clean` | Remove dist/ folder |
| `npm run test` | Run Vitest tests |
| `npm run test:watch` | Watch mode testing |
| `npm run test:coverage` | Generate coverage report |

---

## API Documentation

### Base URL

```
http://localhost:4000/api/v1
```

### Health Check

```
GET /health
```

### Authentication

All protected endpoints require a Bearer token:

```
Authorization: Bearer <access_token>
```

Multi-tenant endpoints require:

```
X-Tenant-Id: <tenant_uuid>
```

### Response Format

```json
{
  "success": true,
  "message": "Operation successful",
  "data": { ... }
}
```

### Paginated Response

```json
{
  "success": true,
  "message": "Items retrieved",
  "data": [ ... ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### Key Endpoints

#### Authentication

```
POST   /auth/register          Register a new user
POST   /auth/login             Login with credentials
POST   /auth/refresh           Refresh access token
POST   /auth/logout            Logout (invalidate tokens)
POST   /auth/forgot-password   Request password reset email
POST   /auth/reset-password    Reset password with token
POST   /auth/2fa/setup         Setup TOTP 2FA
POST   /auth/2fa/verify        Verify 2FA code
GET    /auth/me                Get current user profile
```

#### Dashboard

```
GET    /dashboard/stats        Aggregated tenant statistics
```

#### Patients

```
POST   /patients               Create patient (auto-MRN)
GET    /patients               List patients (paginated)
GET    /patients/search        Quick search
GET    /patients/:id           Get patient details
PUT    /patients/:id           Update patient
POST   /patients/:id/allergies           Add allergy
POST   /patients/:id/emergency-contacts  Add emergency contact
POST   /patients/:id/family-history      Add family history
POST   /patients/:id/documents           Add document
GET    /patients/:id/visits              Get visit history
```

#### Appointments

```
POST   /appointments                      Book appointment
GET    /appointments                      List appointments
GET    /appointments/:id                  Get appointment
PATCH  /appointments/:id/status           Update status
PATCH  /appointments/:id/cancel           Cancel
POST   /appointments/:id/queue            Generate queue token
GET    /appointments/doctors              List doctors
GET    /appointments/doctors/:id/slots    Get available slots
GET    /appointments/queue/doctor/:id     Get doctor's queue
```

#### Billing

```
POST   /billing                      Create bill
GET    /billing                      List bills
GET    /billing/:id                  Get bill details
POST   /billing/:id/items            Add bill item
PATCH  /billing/:id/finalize         Finalize bill
POST   /billing/:id/discounts        Apply discount
POST   /billing/payments             Process payment
POST   /billing/refunds              Request refund
PATCH  /billing/refunds/:id/approve  Approve refund
GET    /billing/patient/:patientId   Get patient bills
```

---

## Database

### Schema Statistics

- **101 models** covering all hospital operations
- **117 enums** for type-safe status/category fields
- **Row-level multi-tenancy** (tenantId on every table)
- **Snake_case SQL mapping** with PascalCase TypeScript models
- **Comprehensive relations** with cascade deletes where appropriate

### Seeded Data

Running `npm run db:seed` creates:

- 192 permissions (33 modules x 6 actions)
- 18 system roles with curated permission sets
- Demo tenant "Demo Hospital"
- Super admin user (`admin@hospital.com` / `Admin@123`)
- 9 departments (Cardiology, Orthopedics, Neurology, etc.)
- 10 feature toggles
- Enterprise subscription plan

---

## Infrastructure Services

### File Upload

- Local disk storage in `uploads/` directory
- Supports images (jpg, png, gif, webp) and documents (pdf, doc, docx)
- 10MB max file size
- Accessible via `GET /uploads/<filename>`

### Email Notifications

- SMTP-based via Nodemailer
- Templates: welcome, password reset, appointment reminder, lab report, bill notification
- Gracefully degrades if SMTP is not configured

### PDF Generation

- Invoice/receipt PDFs with itemized breakdowns
- Lab report PDFs with test results and reference ranges
- Discharge summary PDFs
- Prescription PDFs with medication tables

---

## Security

- **Helmet** security headers
- **CORS** with configurable origin (single origin in production, multiple in dev)
- **Rate limiting** (Redis-backed): 200 req/15min general, 20 req/15min auth
- **JWT** with short-lived access tokens (15min) and refresh rotation
- **bcrypt** password hashing (12 rounds)
- **TOTP 2FA** via authenticator apps
- **Input validation** on all endpoints (Zod)
- **SQL injection protection** via Prisma parameterized queries
- **Graceful shutdown** with 30-second timeout (SIGTERM, SIGINT)
- **Non-root Docker user** (`expressjs:1001`)

---

## Testing

```bash
npm run test              # Run all tests
npm run test:watch        # Watch mode
npm run test:coverage     # Coverage report
```

- **Framework**: Vitest 4.x
- **HTTP testing**: Supertest
- **Mocking**: vitest-mock-extended
- **Timeout**: 10 seconds per test

---

## Production Deployment

```bash
# Build
npm run build

# Start
NODE_ENV=production npm run start

# Or with Docker
docker-compose up -d --build
```

The Dockerfile uses a multi-stage build:

1. **base** - Node 20 Alpine
2. **deps** - Install production dependencies
3. **build** - Compile TypeScript + generate Prisma client
4. **runner** - Minimal image with non-root user (`expressjs:1001`)

Exposes port **4000**.
