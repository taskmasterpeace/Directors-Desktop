export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  missingAssets?: string[];
}

export interface ProjectFileWithMetadata {
  version: string;
  project: any;
  metadata?: {
    exportedAt: number;
    description?: string;
  };
}
