import { Router } from "express";
import * as intoxicationExamController from './intoxication.controller';
import { validate } from "../../middleware/validate";
import { addIntoxicationExamSchema, listIntoxicationExamSchema } from "./intoxication.validation";

const intoxicationExamRoute=Router();

intoxicationExamRoute.post('/',validate(addIntoxicationExamSchema),intoxicationExamController.addExamination);
intoxicationExamRoute.get('/',validate(listIntoxicationExamSchema),intoxicationExamController.fetchExaminations);

export default intoxicationExamRoute;