import functions from '@google-cloud/functions-framework';
import { budgetStop } from './handler.mjs';

// Fixed target; the message can never choose which instance is stopped.
const target = { project: 'openwop-dev', zone: 'us-central1-b', instance: 'openwop-ci-gate' };
functions.cloudEvent('budgetStop', async event => { await budgetStop(event.data?.message, target); });
