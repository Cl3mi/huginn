// JSON report validation — ensures required fields and types

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateReport(json: unknown): ValidationResult {
  const errors: string[] = [];

  if (!json || typeof json !== 'object') {
    errors.push('Report must be a JSON object');
    return { valid: false, errors };
  }

  const report = json as Record<string, unknown>;

  // Check required top-level fields
  const requiredFields = ['scanId', 'summary', 'parsed', 'versionPairs', 'references', 'requirements', 'consistencyChecks'];
  for (const field of requiredFields) {
    if (!(field in report)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Validate summary object
  if (report.summary && typeof report.summary === 'object') {
    const summary = report.summary as Record<string, unknown>;
    const summaryFields = { totalFiles: 'number', parsedFiles: 'number', versionPairs: 'number', references: 'number', requirements: 'number' };
    for (const [field, expectedType] of Object.entries(summaryFields)) {
      if (field in summary && typeof summary[field] !== expectedType) {
        errors.push(`summary.${field} must be ${expectedType}, got ${typeof summary[field]}`);
      }
    }
  }

  // Validate arrays
  const arrayFields = ['parsed', 'versionPairs', 'references', 'requirements'];
  for (const field of arrayFields) {
    if (field in report && !Array.isArray(report[field])) {
      errors.push(`${field} must be an array, got ${typeof report[field]}`);
    }
  }

  // Validate consistency checks
  if (report.consistencyChecks && typeof report.consistencyChecks === 'object') {
    const checks = report.consistencyChecks as Record<string, unknown>;
    for (const [key, value] of Object.entries(checks)) {
      if (value !== null && typeof value === 'object' && 'value' in value) {
        const check = value as Record<string, unknown>;
        if (typeof check.value !== 'number') {
          errors.push(`consistencyChecks.${key}.value must be a number`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
