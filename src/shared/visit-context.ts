import { prisma } from '../config/database';
import { AppError } from './appError';

// Most clinical write paths know one of: visitId (set by doctor consultation),
// admissionId (IPD context), or appointmentId (OPD nurse acting before the
// doctor opens the visit). Resolve to the canonical { visitId, admissionId }
// pair used by Form/IO/Vitals tables.
//
// OPD nurses act on confirmed appointments before the doctor opens the
// consultation, so a Visit row may not exist yet — we create one
// automatically (visitType=op, status=active) so the form has somewhere
// to anchor.
//
// Lifted out of nursing-forms.service.ts so the dynamic forms module can
// reuse the same guarantees instead of duplicating the resolution + tenant
// check logic.
export async function resolveVisitContext(
  tenantId: string,
  patientId: string,
  raw: { visitId?: string; admissionId?: string; appointmentId?: string },
): Promise<{ visitId: string; admissionId?: string; appointmentId?: string }> {
  if (raw.visitId) {
    const visit = await prisma.visit.findFirst({
      where: { id: raw.visitId, tenantId },
      select: { id: true, patientId: true, appointmentId: true },
    });
    if (!visit) throw AppError.notFound('Visit not found');
    if (visit.patientId !== patientId) {
      throw AppError.badRequest('Patient does not match the visit');
    }
    if (raw.admissionId) {
      const adm = await prisma.admission.findFirst({
        where: { id: raw.admissionId, tenantId, visitId: raw.visitId, patientId },
        select: { id: true },
      });
      if (!adm) throw AppError.badRequest('Admission does not match visit/patient');
    }
    return {
      visitId: raw.visitId,
      admissionId: raw.admissionId,
      appointmentId: visit.appointmentId ?? undefined,
    };
  }
  if (raw.admissionId) {
    const adm = await prisma.admission.findFirst({
      where: { id: raw.admissionId, tenantId, patientId },
      select: { id: true, visitId: true },
    });
    if (!adm) throw AppError.notFound('Admission not found');
    return { visitId: adm.visitId, admissionId: adm.id };
  }
  if (raw.appointmentId) {
    const appt = await prisma.appointment.findFirst({
      where: { id: raw.appointmentId, tenantId, patientId },
      select: {
        id: true,
        doctorId: true,
        appointmentDate: true,
        visits: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } },
      },
    });
    if (!appt) throw AppError.notFound('Appointment not found');
    const existingVisitId = appt.visits[0]?.id;
    if (existingVisitId) return { visitId: existingVisitId, appointmentId: appt.id };
    const visit = await prisma.visit.create({
      data: {
        tenantId,
        patientId,
        doctorId: appt.doctorId,
        appointmentId: appt.id,
        visitType: 'op',
        visitDate: appt.appointmentDate,
        status: 'active',
      },
      select: { id: true },
    });
    return { visitId: visit.id, appointmentId: appt.id };
  }
  throw AppError.badRequest('Either visitId, admissionId, or appointmentId is required');
}
