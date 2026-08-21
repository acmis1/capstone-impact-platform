import { createHash } from 'node:crypto';

import { assistiveInputHashSchema } from './persistenceContract';

export type AssistiveDocumentType = 'PDF' | 'PNG' | 'JPEG';

/**
 * Content identity is deliberately narrow and deterministic: the four authoritative prose fields,
 * detected document type, exact private bytes, and the stable duplicate corpus hash. Operational
 * workflow metadata is intentionally excluded. JSON key order is fixed here rather than delegated
 * to arbitrary caller objects.
 */
export function hashAssistiveInput(params: {
  title: string;
  summary: string;
  background: string;
  solution: string;
  documentType: AssistiveDocumentType;
  content: Buffer;
  duplicateCorpusSha256: string;
}): { inputHash: string; documentHash: string } {
  const documentHash = createHash('sha256').update(params.content).digest('hex');
  const canonical = JSON.stringify({
    title: params.title,
    summary: params.summary,
    background: params.background,
    solution: params.solution,
    documentType: params.documentType,
    documentSha256: documentHash,
    duplicateCorpusSha256: assistiveInputHashSchema.parse(params.duplicateCorpusSha256),
  });
  return {
    inputHash: assistiveInputHashSchema.parse(createHash('sha256').update(canonical, 'utf8').digest('hex')),
    documentHash,
  };
}
