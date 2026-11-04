import dotenv from 'dotenv';
dotenv.config();

import { startController } from './controller';
import { loadConfig } from './lib/config';

startController(loadConfig());
