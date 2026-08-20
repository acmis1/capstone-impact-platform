import { createHash } from 'node:crypto';

import { assistiveInputHashSchema } from './persistenceContract';

export type AssistiveDocumentType = 'PDF' | 'PNG' | 'JPEG';

/**
 * Content identity is deliberately narrow and deterministic: authoritative title text, detected
 * document type, and the SHA-256 of the exact private bytes. JSON key order is fixed here rather
 * than delegated to arbitrary caller objects.
 */
export function hashAssistiveInput(params: {
  title: string;
  documentType: AssistiveDocumentType;
  content: Buffer;
}): { inputHash: string; documentHash: string } {
  const documentHash = createHash('sha256').update(params.content).digest('hex');
  const canonical = JSON.stringify({
    documentType: params.documentType,
    documentSha256: documentHash,
    title: params.title,
  });
  return {
    inputHash: assistiveInputHashSchema.parse(createHash('sha256').update(canonical, 'utf8').digest('hex')),
    documentHash,
  };
}
