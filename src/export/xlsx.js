'use strict';

const zlib = require('node:zlib');

/**
 * A small, dependency-free .xlsx writer.
 *
 * An .xlsx file is a ZIP container of XML parts. Writing it here keeps the
 * deployment free of a spreadsheet library — the alternatives are either large
 * or unmaintained, and this app only needs plain tabular sheets with a header
 * row, column widths and a few number formats.
 *
 * Supported cell values: string, number, boolean, Date, null/undefined (blank).
 * Dates are written as real Excel serial numbers so Excel sorts and filters them
 * as dates rather than as text.
 */

// ---------------------------------------------------------------- ZIP writer

const ZIP_VERSION = 20;

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/** DOS date/time, as the ZIP local header expects. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/**
 * Builds a ZIP archive from { name, data } entries. Everything is deflated,
 * which every spreadsheet application reads.
 */
function zip(entries, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(0, 6);              // no flags
    local.writeUInt16LE(8, 8);              // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38);           // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ----------------------------------------------------------------- XML parts

const xmlEscape = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Control characters are illegal in XML 1.0 and would corrupt the file.
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** A1-style reference for a zero-based column index. */
function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - rem) / 26);
  }
  return name;
}

/**
 * Excel's serial date: days since 1899-12-30.
 *
 * A spreadsheet cell has no timezone — it holds a wall-clock reading. The caller
 * therefore says which wall clock to use (`tzOffsetMinutes`), rather than this
 * picking up whatever zone the server happens to run in: otherwise the same
 * export would read 15:30 on a machine in Vietnam and 08:30 on one in UTC.
 */
function excelSerial(date, tzOffsetMinutes = 0) {
  const ms = date.getTime() + tzOffsetMinutes * 60000;
  return ms / 86400000 + 25569;
}

/**
 * A calendar day with no time of day — a visit date, say.
 *
 * It must not be shifted by a timezone: 05/10/2026 is that day everywhere, and
 * nudging it seven hours would leave 05/10/2026 07:00 in the cell and, read back
 * in another zone, the day before. A `Date` in a cell is an instant and is
 * converted into the report's zone; this wrapper is a reading that is already
 * final, so it is written through untouched.
 */
class PlainDate {
  constructor(serial) { this.serial = serial; }
}

/** @param {string|Date} value an ISO date (YYYY-MM-DD) or a Date to take the day of. */
function plainDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const iso = value instanceof Date
    ? (Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10))
    : String(value).slice(0, 10);
  if (!iso) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new PlainDate(ms / 86400000 + 25569);
}

const STYLE = { DEFAULT: 0, HEADER: 1, DATE: 2, DATETIME: 3, PERCENT: 4, INTEGER: 5 };

function cellXml(ref, value, styleIndex, tzOffsetMinutes = 0) {
  const s = styleIndex ? ` s="${styleIndex}"` : '';
  if (value === null || value === undefined || value === '') return `<c r="${ref}"${s}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (value instanceof PlainDate) {
    return `<c r="${ref}"${s}><v>${value.serial}</v></c>`;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return `<c r="${ref}"${s}/>`;
    return `<c r="${ref}"${s}><v>${excelSerial(value, tzOffsetMinutes)}</v></c>`;
  }
  // Inline strings avoid a shared-string table without losing any fidelity.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

/**
 * @param {{name: string, columns: {header: string, key?: string, width?: number,
 *          style?: number}[], rows: Array<object|Array>}} sheet
 */
function sheetXml(sheet, tzOffsetMinutes = 0) {
  const cols = sheet.columns.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join('');

  const header = `<row r="1">${
    sheet.columns.map((c, i) => cellXml(`${columnName(i)}1`, c.header, STYLE.HEADER)).join('')}</row>`;

  const body = sheet.rows.map((row, r) => {
    const values = Array.isArray(row)
      ? row
      : sheet.columns.map((c) => (c.key ? row[c.key] : undefined));
    return `<row r="${r + 2}">${
      values.map((v, i) => cellXml(
        `${columnName(i)}${r + 2}`, v, (sheet.columns[i] && sheet.columns[i].style) || 0, tzOffsetMinutes,
      )).join('')
    }</row>`;
  }).join('');

  const lastCol = columnName(Math.max(0, sheet.columns.length - 1));
  const lastRow = sheet.rows.length + 1;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${header}${body}</sheetData>
<autoFilter ref="A1:${lastCol}${lastRow}"/>
</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
  <numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>
  <numFmt numFmtId="165" formatCode="dd/mm/yyyy\\ hh:mm"/>
  <numFmt numFmtId="166" formatCode="0.0%"/>
</numFmts>
<fonts count="2">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF0F5EA8"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

/**
 * Builds a workbook.
 * @param {{name: string, columns: object[], rows: Array}[]} sheets
 * @returns {Buffer} the .xlsx file
 */
function buildWorkbook(sheets, { created = new Date(), tzOffsetMinutes = 0 } = {}) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('A workbook needs at least one sheet.');
  }

  // Excel rejects duplicate or over-long sheet names, and these characters.
  const used = new Set();
  const named = sheets.map((sheet, i) => {
    let name = String(sheet.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim()
      || `Sheet${i + 1}`;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = ` (${n})`;
      name = `${name.slice(0, 31 - suffix.length)}${suffix}`;
      n += 1;
    }
    used.add(name.toLowerCase());
    return { ...sheet, name };
  });

  const entries = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...named.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(sheet, tzOffsetMinutes),
    })),
  ];

  return zip(entries, created);
}

module.exports = { buildWorkbook, STYLE, columnName, excelSerial, plainDate, PlainDate, xmlEscape };
