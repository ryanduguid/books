import { register } from 'node:module';

register('./mock-modules.mjs', import.meta.url);
