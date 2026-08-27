import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

import {
  ASSISTIVE_LANGUAGE_LIMITS,
  LANGUAGE_PROVIDER_VERSION,
  LANGUAGE_TOOL_ARCHIVE_SHA256,
  LANGUAGE_TOOL_SERVER_JAR_SHA256,
  languageFields,
  languageToolRawMatchSchema,
  maskLanguageText,
  toPersistedLanguageFindings,
} from '../domain/languagePolicy';
import type { PersistedAssistiveFinding } from '../domain/persistenceContract';
import type { DuplicateProjectProse } from '../duplicate-detection/duplicateRanker';

export type AssistiveLanguagePulseResult = 'CONTINUE' | 'CANCEL' | 'CLAIM_LOST';

export interface AssistiveLanguageProviderInput {
  project: DuplicateProjectProse;
  inputHash: string;
  onPulse: () => Promise<AssistiveLanguagePulseResult>;
}

export type AssistiveLanguageProviderResult =
  | { status: 'AVAILABLE'; findings: PersistedAssistiveFinding[] }
  | { status: 'UNAVAILABLE' };

export interface AssistiveLanguageProvider {
  check(input: AssistiveLanguageProviderInput): Promise<AssistiveLanguageProviderResult>;
  health(): Promise<boolean>;
}

export class LanguageProviderControlError extends Error {
  constructor(readonly code: 'CANCELLED' | 'CLAIM_LOST') {
    super(code);
    this.name = 'LanguageProviderControlError';
  }
}

interface LanguageToolProcessOptions {
  archivePath: string;
  jarPath: string;
  javaCommand?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

const languageToolResponseSchema = z.object({
  software: z.object({ version: z.string().max(30) }).passthrough(),
  matches: z.array(z.object({
    offset: z.number().int(),
    length: z.number().int(),
    message: z.string().max(1_000).default(''),
    replacements: z.array(z.object({ value: z.string().max(500) }).passthrough()).max(20),
    rule: z.object({
      id: z.string().min(1).max(100),
      category: z.object({ id: z.string().min(1).max(64) }).passthrough(),
    }).passthrough(),
  }).passthrough()).max(ASSISTIVE_LANGUAGE_LIMITS.providerMatchesPerField),
}).passthrough();

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('LANGUAGE_LOOPBACK_PORT_UNAVAILABLE'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('LANGUAGE_PROVIDER_HTTP_FAILURE');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ASSISTIVE_LANGUAGE_LIMITS.responseBytesPerField) {
    await response.body.cancel();
    throw new Error('LANGUAGE_PROVIDER_RESPONSE_TOO_LARGE');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > ASSISTIVE_LANGUAGE_LIMITS.responseBytesPerField) {
      await reader.cancel();
      throw new Error('LANGUAGE_PROVIDER_RESPONSE_TOO_LARGE');
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(bytes);
  let position = 0;
  for (const chunk of chunks) {
    body.set(chunk, position);
    position += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}

async function postCheck(endpoint: string, text: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await boundedJson(await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ language: 'en-AU', text }),
      signal: controller.signal,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

async function pulse(onPulse: AssistiveLanguageProviderInput['onPulse']): Promise<void> {
  const result = await onPulse();
  if (result === 'CANCEL') throw new LanguageProviderControlError('CANCELLED');
  if (result === 'CLAIM_LOST') throw new LanguageProviderControlError('CLAIM_LOST');
}

export class LocalLanguageToolProcess implements AssistiveLanguageProvider {
  private readonly javaCommand: string;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: LanguageToolProcessOptions) {
    this.javaCommand = options.javaCommand ?? 'java';
    this.startupTimeoutMs = options.startupTimeoutMs ?? 45_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  private async artifactsAreQualified(): Promise<boolean> {
    try {
      const [archiveStat, jarStat, archiveHash, jarHash] = await Promise.all([
        stat(this.options.archivePath), stat(this.options.jarPath),
        sha256(this.options.archivePath), sha256(this.options.jarPath),
      ]);
      return archiveStat.isFile() && jarStat.isFile()
        && basename(this.options.archivePath) === 'LanguageTool-stable.zip'
        && basename(this.options.jarPath) === 'languagetool-server.jar'
        && archiveHash === LANGUAGE_TOOL_ARCHIVE_SHA256
        && jarHash === LANGUAGE_TOOL_SERVER_JAR_SHA256;
    } catch {
      return false;
    }
  }

  private async javaIsSupported(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.javaCommand, ['-version'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let output = '';
      const timeout = setTimeout(() => { child.kill(); resolve(false); }, 5_000);
      child.stderr.on('data', (chunk: Buffer) => {
        if (output.length < 2_000) output += chunk.toString('utf8').slice(0, 2_000 - output.length);
      });
      child.once('error', () => { clearTimeout(timeout); resolve(false); });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        const match = output.match(/version\s+"(\d+)/i);
        resolve(code === 0 && Boolean(match) && Number(match![1]) >= 17);
      });
    });
  }

  async health(): Promise<boolean> {
    return (await this.artifactsAreQualified()) && (await this.javaIsSupported());
  }

  async check(input: AssistiveLanguageProviderInput): Promise<AssistiveLanguageProviderResult> {
    await pulse(input.onPulse);
    if (!(await this.health())) return { status: 'UNAVAILABLE' };

    const temp = await mkdtemp(join(tmpdir(), 'pp1-language-tool-'));
    let child: ChildProcess | null = null;
    try {
      const port = await freeLoopbackPort();
      const config = join(temp, 'server.properties');
      await writeFile(
        config,
        'maxTextLength=25000\nmaxTextHardLength=25000\nmaxCheckTimeMillis=10000\nmaxCheckThreads=1\n',
        { encoding: 'utf8', flag: 'wx' },
      );
      child = spawn(this.javaCommand, [
        '-cp', this.options.jarPath,
        'org.languagetool.server.HTTPServer',
        '--config', config,
        '--port', String(port),
      ], {
        cwd: dirname(this.options.jarPath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrBytes = 0;
      let stderrOverflow = false;
      let processFailed = false;
      child.once('error', () => { processFailed = true; });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > ASSISTIVE_LANGUAGE_LIMITS.stderrBytes) {
          stderrOverflow = true;
          child?.kill();
        }
      });
      child.stdout?.resume();
      const endpoint = `http://127.0.0.1:${port}/v2/check`;

      const started = Date.now();
      let lastPulse = started;
      let ready = false;
      while (!ready) {
        if (stderrOverflow || processFailed || child.exitCode !== null) throw new Error('LANGUAGE_PROVIDER_START_FAILED');
        if (Date.now() - started > this.startupTimeoutMs) throw new Error('LANGUAGE_PROVIDER_START_TIMEOUT');
        if (Date.now() - lastPulse >= 5_000) {
          await pulse(input.onPulse);
          lastPulse = Date.now();
        }
        try {
          const probe = languageToolResponseSchema.parse(await postCheck(endpoint, 'Startup probe.', 2_000));
          if (probe.software.version !== LANGUAGE_PROVIDER_VERSION) {
            throw new Error('LANGUAGE_PROVIDER_VERSION_MISMATCH');
          }
          ready = true;
        } catch (error) {
          if (error instanceof Error && error.message === 'LANGUAGE_PROVIDER_VERSION_MISMATCH') {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      const findings: PersistedAssistiveFinding[] = [];
      for (const { field, source } of languageFields(input.project)) {
        await pulse(input.onPulse);
        if (!source.trim()) continue;
        const response = languageToolResponseSchema.parse(
          await postCheck(endpoint, maskLanguageText(source).text, this.requestTimeoutMs),
        );
        if (response.software.version !== LANGUAGE_PROVIDER_VERSION) {
          throw new Error('LANGUAGE_PROVIDER_VERSION_MISMATCH');
        }
        const matches = response.matches.map((match) => languageToolRawMatchSchema.parse({
          offset: match.offset,
          length: match.length,
          message: match.message,
          ruleId: match.rule.id,
          categoryId: match.rule.category.id,
          replacements: match.replacements.map((replacement) => replacement.value),
        }));
        findings.push(...toPersistedLanguageFindings({ field, source, inputHash: input.inputHash, matches }));
        if (findings.length >= ASSISTIVE_LANGUAGE_LIMITS.findingsPerProject) break;
      }
      return { status: 'AVAILABLE', findings: findings.slice(0, ASSISTIVE_LANGUAGE_LIMITS.findingsPerProject) };
    } catch (error) {
      if (error instanceof LanguageProviderControlError) throw error;
      return { status: 'UNAVAILABLE' };
    } finally {
      if (child) {
        child.kill();
        if (!(await waitForExit(child, 5_000))) {
          child.kill('SIGKILL');
          await waitForExit(child, 2_000);
        }
      }
      await rm(temp, { recursive: true, force: true });
    }
  }
}
