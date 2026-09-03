import { inflateRawSync } from 'node:zlib';

/** Bound ZIP expansion and worksheet indices before ExcelJS allocates its workbook model. */
export function assertCorrectionWorkbookBounds(bytes: Buffer): void {
  const fail = (): never => { throw new Error('WORKBOOK_LIMIT'); };
  if (bytes.length < 22 || bytes.length > 5 * 1024 * 1024) fail();
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65_557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50) break;
  }
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) fail();
  const count = bytes.readUInt16LE(end + 10);
  const directoryEnd = bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8) || count < 3 || count > 128 || directoryEnd !== end) fail();
  let cursor = bytes.readUInt32LE(end + 16);
  let total = 0;
  let sheets = 0;
  let expandedCells = 0;
  const boundRange = (range: string) => {
    const points = range.split(':').map((cell) => {
      const ref = /^\$?([A-Z]{1,2})\$?([1-9]\d{0,2})$/.exec(cell);
      if (!ref) return fail();
      const row = Number(ref[2]);
      const column = [...ref[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
      if (row > 128 || column > 128) return fail();
      return { row, column };
    });
    if (points.length > 2) fail();
    expandedCells += points.length === 1 ? 1 : (Math.abs(points[1].row - points[0].row) + 1) * (Math.abs(points[1].column - points[0].column) + 1);
    if (expandedCells > 32_768) fail();
  };
  const names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail();
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const packed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (next > end || flags & 1 || ![0, 8].includes(method) || packed > bytes.length || size > 8 * 1024 * 1024 || (total += size) > 16 * 1024 * 1024 || local + 30 > cursor) fail();
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!name || names.has(name) || name.includes('..') || name.includes('\\') || name.startsWith('/') || /[:\x00-\x1f]/.test(name) || /(?:externalLinks|vbaProject|\.bin$)/i.test(name)) fail();
    names.add(name);
    if (bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt16LE(local + 6) !== flags) fail();
    const localNameLength = bytes.readUInt16LE(local + 26);
    const start = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    if (start + packed > bytes.readUInt32LE(end + 16) || bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8') !== name || ranges.some(([a, b]) => local < b && start + packed > a)) fail();
    ranges.push([local, start + packed]);
    const input = bytes.subarray(start, start + packed);
    const output = method === 0 ? input : inflateRawSync(input, { maxOutputLength: Math.max(1, size) });
    if (output.length !== size) fail();
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      const xml = output.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail();
      // Excel commonly stores typed web URLs as hyperlink relationships. They are
      // parsed as text, never fetched. External workbooks, files and other relations fail.
      for (const relation of xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
        const mode = /\bTargetMode\s*=\s*["']([^"']*)["']/.exec(relation[0])?.[1];
        if (mode === undefined || mode === 'Internal') continue;
        if (mode !== 'External') fail();
        if (!/\bType\s*=\s*["']http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/hyperlink["']/.test(relation[0]) ||
            !/\bTarget\s*=\s*["']https?:\/\/[^"'\s]+["']/i.test(relation[0])) fail();
      }
      if ((xml.match(/<[^!?/]/g) ?? []).length > 20_000) fail();
      // Bound ranges in comments/tables as well as worksheets. Named ranges are
      // also expanded into cell matrices by ExcelJS and share the same budget.
      for (const match of xml.matchAll(/\b(?:ref|sqref)\s*=\s*["']([^"']+)["']/g)) {
        const ranges = match[1].split(/\s+/);
        if (ranges.length > 128) fail();
        ranges.forEach(boundRange);
      }
      if (name === 'xl/workbook.xml') {
        for (const match of xml.matchAll(/<(?:\w+:)?definedName\b[^>]*>([^<]*)<\//g)) {
          const ranges = match[1].split(',');
          if (ranges.length > 128) fail();
          ranges.forEach((range) => boundRange(range.split('!').at(-1) ?? ''));
        }
      }
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
        if (++sheets > 8) fail();
        if ((xml.match(/<(?:\w+:)?row\b/g) ?? []).length > 128) fail();
        // ExcelJS expands merged cells and validation ranges after reading XML. A tiny
        // archive declaring A1:XFD1048576 must fail before that allocation/iteration.
        for (const col of xml.matchAll(/<(?:\w+:)?col\b[^>]*>/g)) {
          for (const bound of col[0].matchAll(/\b(?:min|max)\s*=\s*["']([^"']+)["']/g)) {
            if (!/^[1-9]\d{0,2}$/.test(bound[1]) || Number(bound[1]) > 128) fail();
          }
        }
        for (const match of xml.matchAll(/<(?:\w+:)?row\b[^>]*\br\s*=\s*["']([^"']+)["']/g)) {
          if (!/^\d{1,3}$/.test(match[1]) || Number(match[1]) > 128) fail();
        }
        for (const match of xml.matchAll(/<(?:\w+:)?c\b[^>]*\br\s*=\s*["']([^"']+)["']/g)) {
          const ref = /^([A-Z]{1,2})([1-9]\d{0,2})$/.exec(match[1]);
          if (!ref || Number(ref[2]) > 128 || [...ref[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) > 128) fail();
        }
      }
    }
    cursor = next;
  }
  if (cursor !== end || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml') || sheets === 0) fail();
}
