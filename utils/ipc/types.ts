export type ExportFormat = 'csv' | 'json' | 'template.html' | 'pdf';

export type ExportSelection =
  | { canceled: true; filePath?: undefined; grantId?: undefined }
  | { canceled: false; filePath: string; grantId: string };

export interface BackendResponse {
  data?: unknown;
  error?: {
    message: string;
    name: string;
    stack?: string;
    code?: string;
    cleanupErrors?: string[];
  };
}
