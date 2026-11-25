import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../shared/types';
import { sendResponse } from '../../shared/apiResponse';
import * as icuService from './icu.service';

export const fluidBalance = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.balanceFluids(admissionId, tenantId, req.body);
        sendResponse({ res, message: 'Fluid Balance data saved', data: result });
    } catch (error) {
        next(error);
    }
};

export const abgVent = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.ventAbg(admissionId, tenantId, req.body);
        sendResponse({ res, message: 'Abg Vent data saved', data: result });
    } catch (error) {
        next(error);
    }
}

export const fastHug = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.HugFast(admissionId, tenantId, req.body);
        sendResponse({ res, message: 'HugFast data saved', data: result });
    } catch (error) {
        next(error);
    }
}

export const invasiveLine = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.lineInvasive(admissionId, tenantId, req.body);
        sendResponse({ res, message: 'lineInvasive data saved', data: result });
    } catch (error) {
        next(error);
    }
}

export const infusionPump = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.pumpInfusion(admissionId, tenantId, req.body);
        sendResponse({ res, message: 'pumpInfusion data saved', data: result });
    } catch (error) {
        next(error);
    }
}

export const severityScore = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.scoreSeverity(admissionId, tenantId, req.body);
        sendResponse({ res, message: 'scoreSeverity data saved', data: result });
    } catch (error) {
        next(error);
    }
}

export const getfluidBalance = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.listFluidBalance(admissionId, tenantId);
        sendResponse({ res, message: 'Fluid Balance entries', data: result });
    } catch (error) {
        next(error);
    }
}

export const getabgVent = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.listAbgVent(admissionId, tenantId);
        sendResponse({ res, message: 'ABG + Vent entries', data: result });
    } catch (error) {
        next(error);
    }
}

export const getfastHug = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.listFastHug(admissionId, tenantId);
        sendResponse({ res, message: 'FAST-HUG + Sepsis entries', data: result });
    } catch (error) {
        next(error);
    }
}

export const getinvasiveLine = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.listInvasiveLine(admissionId, tenantId);
        sendResponse({ res, message: 'Invasive Line entries', data: result });
    } catch (error) {
        next(error);
    }
}

export const getinfusionPump = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.listInfusionPump(admissionId, tenantId);
        sendResponse({ res, message: 'Infusion Pump entries', data: result });
    } catch (error) {
        next(error);
    }
}

export const getseverityScore = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const admissionId = req.params.admissionId as string;
        const tenantId = req.user?.tenantId as string;
        const result = await icuService.listSeverityScore(admissionId, tenantId);
        sendResponse({ res, message: 'Severity Score entries', data: result });
    } catch (error) {
        next(error);
    }
}
