import {Router} from 'express'
import * as fastTrackController from './fast-track.controller';
import { validate } from '../../middleware/validate';
import { addFastTrackCodeSchema, listFastTrackCodesSchema } from './fast-track.validation';

const fastTrackRoute=Router();

fastTrackRoute.post('/',validate(addFastTrackCodeSchema),fastTrackController.addCodes);
fastTrackRoute.get('/',validate(listFastTrackCodesSchema),fastTrackController.getCodes);

export default fastTrackRoute;