import { checkUsageForTask, findEligibleTask } from './usageService.js';

// Returns { safe: boolean, reason: string, detail: object }
export async function isUsageSafe(task) {
  return checkUsageForTask(task);
}

export { findEligibleTask };
