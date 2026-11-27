import { Router } from 'express';
import * as calculatorController from './calculator.controller';
import { validate } from '../../middleware/validate';
import {
  createCalculatorSchema,
  updateCalculatorSchema,
  listCalculatorsSchema,
} from './calculator.validation';

export const calculatorRoute = Router();

calculatorRoute.post('/', validate(createCalculatorSchema), calculatorController.addCalculator);
calculatorRoute.get('/', validate(listCalculatorsSchema), calculatorController.fetchCalculators);
calculatorRoute.put('/:id', validate(updateCalculatorSchema), calculatorController.updateCalculator);
