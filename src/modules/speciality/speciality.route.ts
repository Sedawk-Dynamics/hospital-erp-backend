import { authenticate } from "../../middleware/authenticate";
import { Router } from "express";
import * as specialityController from './speciality.controller';
import { addSpecialityDataSchema } from "./speciality.validation";
import { validate } from "../../middleware/validate";

export const specialityRoute=Router();

specialityRoute.post('/visit/:visitId',authenticate,validate(addSpecialityDataSchema),specialityController.addSpecialityData);
specialityRoute.get('/visit/:visitId',authenticate,specialityController.getSpecialityData);


