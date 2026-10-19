import { Router } from "express";
import * as medicoLegalController from './medico-legal.controller';
import { validate } from "../../middleware/validate";
import { addMedicoLegalSchema, listMedicoLegalSchema } from "./medico-legal.validation";

const medicoLegalRoute=Router();

medicoLegalRoute.post('/',validate(addMedicoLegalSchema),medicoLegalController.addMedical);
medicoLegalRoute.get('/',validate(listMedicoLegalSchema),medicoLegalController.getMedical);

export default medicoLegalRoute;