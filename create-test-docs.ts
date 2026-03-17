/**
 * Generates synthetic test documents for validating the scanner.
 *
 * Fictional companies:
 *   OEM:      Helios Automotive AG   (vehicle manufacturer)
 *   Supplier: Vertex Systems GmbH    (electronics / BMS)
 *   Supplier: Apex Components GmbH   (structural / chassis)
 *
 * Corpus is designed to exercise specific RAG-strategy signals:
 *   - Version pair detection  (SRS v1 vs v2)
 *   - Safety-critical flagging (ASIL markers)
 *   - Requirement ID extraction (HAG-REQ-xxx, VX-IRS-xxx, AC-REQ-xxx)
 *   - Cross-document references
 *   - Table-heavy content  (FMEA, deviation list, XLSX)
 *   - Narrative-heavy content (audit report, meeting minutes)
 *   - German-language document (language detection)
 *   - Scanned / low-text PDF  (OCR-needed detection)
 *
 * Run: bun run create-test-docs.ts
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const BASE = join(import.meta.dir, "_test-docs");

mkdirSync(join(BASE, "Helios-Automotive-AG/Project-NOVA/Requirements"), { recursive: true });
mkdirSync(join(BASE, "Helios-Automotive-AG/Project-NOVA/Testing"),      { recursive: true });
mkdirSync(join(BASE, "Helios-Automotive-AG/Project-NOVA/Quality"),      { recursive: true });
mkdirSync(join(BASE, "Helios-Automotive-AG/Project-NOVA/Planning"),     { recursive: true });
mkdirSync(join(BASE, "Helios-Automotive-AG/Project-TITAN"),             { recursive: true });
mkdirSync(join(BASE, "InternalDocs"),                                    { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ZIP builder
// ─────────────────────────────────────────────────────────────────────────────
interface ZipEntry { name: string; data: string | Uint8Array; }

function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const dataBytes = typeof entry.data === "string" ? enc.encode(entry.data) : entry.data;
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, size, true); dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true); dv.setUint16(28, 0, true);
    local.set(nameBytes, 30); local.set(dataBytes, 30 + nameBytes.length);
    parts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
    for (const off of [8,10,12,14]) cdv.setUint16(off, 0, true);
    cdv.setUint32(16, crc, true); cdv.setUint32(20, size, true); cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    for (const off of [30,32,34,36]) cdv.setUint16(off, 0, true);
    cdv.setUint32(38, 0, true); cdv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralDir.push(central);
    offset += local.length;
  }

  const cdSize = centralDir.reduce((s, e) => s + e.length, 0);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); edv.setUint16(4, 0, true); edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true); edv.setUint16(10, entries.length, true);
  edv.setUint32(12, cdSize, true); edv.setUint32(16, offset, true); edv.setUint16(20, 0, true);

  const result = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const p of [...parts, ...centralDir, eocd]) { result.set(p, pos); pos += p.length; }
  return result;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// XLSX builder (multi-sheet)
// ─────────────────────────────────────────────────────────────────────────────
function buildXlsx(sheets: Array<{ name: string; rows: string[][] }>): Uint8Array {
  const sheetEntries = sheets.map((sheet, i) => {
    const sheetRows = sheet.rows.map((row, r) =>
      `<row r="${r + 1}">${row.map((cell, c) =>
        `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`
      ).join("")}</row>`
    ).join("\n");
    return {
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRows}</sheetData>
</worksheet>`,
    };
  });

  const sheetOverrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("\n  ");

  const sheetRelEntries = sheets.map((_, i) =>
    `<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`
  ).join("\n  ");

  const sheetDefs = sheets.map((s, i) =>
    `<sheet name="${escapeXml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`
  ).join("\n    ");

  return buildZip([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheetOverrides}
</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRelEntries}
</Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    ${sheetDefs}
  </sheets>
</workbook>` },
    ...sheetEntries,
  ]);
}

function colName(n: number): string {
  let s = ""; n++;
  while (n > 0) { s = String.fromCharCode(((n - 1) % 26) + 65) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF builder
// ─────────────────────────────────────────────────────────────────────────────
function buildPdf(text: string, pages = 3): Uint8Array {
  const encoder = new TextEncoder();
  const lines = text.split("\n");
  const linesPerPage = Math.ceil(lines.length / pages);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  const objects: string[] = [];

  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const pageRefs = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageRefs}] /Count ${pages} >>\nendobj\n`);

  for (let p = 0; p < pages; p++) {
    const pageObjId = 3 + p * 2;
    const contentObjId = pageObjId + 1;
    const pageLines = lines.slice(p * linesPerPage, (p + 1) * linesPerPage);

    objects.push(`${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjId} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>\nendobj\n`);

    let stream = "BT\n/F1 11 Tf\n";
    let y = 750;
    for (const line of pageLines) {
      const safe = line.replace(/[()\\]/g, "\\$&").slice(0, 98);
      stream += `72 ${y} Td\n(${safe}) Tj\n`;
      y -= 14;
      if (y < 50) break;
    }
    stream += "ET\n";
    objects.push(`${contentObjId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  }

  let pos = pdf.length;
  for (const obj of objects) { offsets.push(pos); pdf += obj; pos += obj.length; }

  const xrefOffset = pos;
  const n = objects.length;
  pdf += `xref\n0 ${n + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += String(off).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${n + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(pdf);
}

function buildScannedPdf(): Uint8Array {
  return buildPdf("                    [scanned image - no text layer]                    \n\n\n", 2);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Document content
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. NOVA-SRS-001 v1 — System Requirements Specification ──────────────────
const SRS_001_V1 = `
System Requirements Specification
Document ID: NOVA-SRS-001  Revision: 1.0  Date: 2024-01-15
Project: NOVA - Battery Management System (BMS) Module
Supplier: Vertex Systems GmbH   Customer: Helios Automotive AG
Classification: Confidential

1. Scope
This document defines system-level requirements for the Battery Management System (BMS)
developed by Vertex Systems GmbH for integration into the Helios Automotive AG NOVA platform.
The BMS monitors and controls a 400 V lithium-ion battery pack for electric vehicles.
Applicable standards: ISO 26262:2018, IEC 61851-1:2017, AUTOSAR R22-11, ISO 9001:2015.
This specification is the baseline for FMEA document NOVA-FMEA-004.
Interface definitions are provided separately in NOVA-IRS-002.

2. System Overview
Nominal pack voltage: 400 VDC. Max charge voltage: 450 VDC.
Operating temperature range: -40 degrees C to +85 degrees C.
Target ASIL integrity level: ASIL-B (ISO 26262).
The BMS communicates via CAN 2.0B at 500 kbps. See NOVA-IRS-002 for signal definitions.
Connector standard: 48-pin automotive-grade sealed connector.

3. Functional Requirements
HAG-REQ-F001: The BMS shall monitor individual cell voltages in range 2.5 V to 4.2 V.
  Safety-critical. See FMEA entry F-001 in NOVA-FMEA-004.
HAG-REQ-F002: Cell voltage measurement accuracy shall be within plus or minus 5 mV.
HAG-REQ-F003: The BMS shall monitor pack temperature at a minimum of 8 sensor points.
  Safety-critical. Temperature sensor type: NTC 10k.
HAG-REQ-F004: The BMS shall transmit State-of-Charge (SOC) via CAN.
  CAN message ID: 0x1A0. Update rate: 100 ms. Signal definition: see NOVA-IRS-002.
HAG-REQ-F005: The BMS shall detect inter-cell balancing deviation exceeding 50 mV.
  Passive balancing shall activate automatically.
HAG-REQ-F006: Overtemperature protection shall activate at 60 degrees C.
  Safety-critical. Thermal runaway prevention per ISO 26262 clause 5.
HAG-REQ-F007: The BMS shall support ISO 15118 communication for smart charging.
HAG-REQ-F008: State estimation accuracy: SOC plus or minus 3%, State-of-Health plus or minus 5%.
HAG-REQ-F009: The BMS shall log all fault events to non-volatile memory (min 1000 events).
HAG-REQ-F010: Wake-up time from sleep mode shall not exceed 500 ms.

4. Performance Requirements
HAG-REQ-P001: Cell measurement cycle time shall not exceed 10 ms.
HAG-REQ-P002: Supply voltage operating range: 9 V to 16 V.
HAG-REQ-P003: Quiescent current in sleep mode shall not exceed 500 microamp.
HAG-REQ-P004: MTBF shall be >= 50,000 operating hours.
HAG-REQ-P005: BMS PCB shall meet IP54 protection class.

5. Safety Requirements (ASIL-B)
HAG-REQ-S001: BMS functional safety shall achieve ASIL-B per ISO 26262. Safety-critical.
HAG-REQ-S002: Safe state shall be entered within 10 ms upon fault detection. Safety-critical.
HAG-REQ-S003: Redundant voltage measurement hardware required for ASIL decomposition.
  Safety-critical. Two independent measurement channels required.
HAG-REQ-S004: Hardware watchdog shall reset BMS within 50 ms on software fault. Safety-critical.
HAG-REQ-S005: Over-voltage disconnect shall be implemented in hardware (not software).
  Safety-critical. Disconnect threshold: 4.25 V per cell.

6. Interface Requirements
Refer to NOVA-IRS-002 for complete electrical and software interface specifications.
CAN bus: 500 kbps, CAN 2.0B. Extended frame format supported.
LIN bus (optional): version 2.1, 19.2 kbps for diagnostic sub-functions.
Power supply: 12 V nominal from vehicle LV network.

7. Quality and Compliance
Applicable standards: ISO 9001:2015, IATF 16949:2016, VDA 6.3.
PPAP documentation required - Level 3 submission to Helios Automotive AG.
Design FMEA shall reference this document. See NOVA-FMEA-004.
All requirements shall be verified per test plan NOVA-TR-003.

8. Document History
Rev 1.0 | 2024-01-15 | Initial release | Author: T. Weber, Vertex Systems GmbH
`;

// ── 2. NOVA-SRS-001 v2 — same structure, updated requirements ───────────────
const SRS_001_V2 = `
System Requirements Specification
Document ID: NOVA-SRS-001  Revision: 2.0  Date: 2024-06-20
Project: NOVA - Battery Management System (BMS) Module
Supplier: Vertex Systems GmbH   Customer: Helios Automotive AG
Classification: Confidential
Change summary: Cybersecurity added, accuracy improved, IP class upgraded, safe state tightened.

1. Scope
This document defines system-level requirements for the Battery Management System (BMS)
developed by Vertex Systems GmbH for integration into the Helios Automotive AG NOVA platform.
The BMS monitors and controls a 400 V lithium-ion battery pack for electric vehicles.
Applicable standards: ISO 26262:2018, IEC 61851-1:2017, AUTOSAR R22-11, ISO 9001:2015,
ISO 21434:2021 (cybersecurity - added Rev 2.0).
This specification is the baseline for FMEA document NOVA-FMEA-004.
Interface definitions are provided separately in NOVA-IRS-002.

2. System Overview
Nominal pack voltage: 400 VDC. Max charge voltage: 450 VDC.
Operating temperature range: -40 degrees C to +85 degrees C.
Target ASIL integrity level: ASIL-B (ISO 26262).
The BMS communicates via CAN 2.0B at 500 kbps and CAN-FD at 2 Mbps (new Rev 2.0).
Connector standard: 48-pin automotive-grade sealed connector.

3. Functional Requirements
HAG-REQ-F001: The BMS shall monitor individual cell voltages in range 2.5 V to 4.2 V.
  Safety-critical. See FMEA entry F-001 in NOVA-FMEA-004.
HAG-REQ-F002: Cell voltage measurement accuracy shall be within plus or minus 5 mV.
HAG-REQ-F003: The BMS shall monitor pack temperature at a minimum of 8 sensor points.
  Safety-critical. Temperature sensor type: NTC 10k.
HAG-REQ-F004: The BMS shall transmit State-of-Charge (SOC) via CAN.
  CAN message ID: 0x1A0. Update rate: 100 ms. Signal definition: see NOVA-IRS-002.
HAG-REQ-F005: The BMS shall detect inter-cell balancing deviation exceeding 50 mV.
  Passive balancing shall activate automatically.
HAG-REQ-F006: Overtemperature protection shall activate at 60 degrees C.
  Safety-critical. Thermal runaway prevention per ISO 26262 clause 5.
HAG-REQ-F007: The BMS shall support ISO 15118 communication for smart charging.
HAG-REQ-F008: State estimation accuracy: SOC plus or minus 2%, SOH plus or minus 4%.
  CHANGED from Rev 1.0: accuracy improved from 3%/5% to 2%/4%.
HAG-REQ-F009: The BMS shall log all fault events to non-volatile memory (min 2000 events).
  CHANGED from Rev 1.0: capacity doubled from 1000 to 2000 events.
HAG-REQ-F010: Wake-up time from sleep mode shall not exceed 500 ms.
HAG-REQ-F011: The BMS firmware shall implement cybersecurity measures per ISO 21434.
  NEW in Rev 2.0. Secure boot, authenticated firmware updates, encrypted diagnostics.

4. Performance Requirements
HAG-REQ-P001: Cell measurement cycle time shall not exceed 10 ms.
HAG-REQ-P002: Supply voltage operating range: 9 V to 16 V.
HAG-REQ-P003: Quiescent current in sleep mode shall not exceed 500 microamp.
HAG-REQ-P004: MTBF shall be >= 50,000 operating hours.
HAG-REQ-P005: BMS PCB shall meet IP67 protection class.
  CHANGED from Rev 1.0: IP54 upgraded to IP67 per field feedback from Helios.

5. Safety Requirements (ASIL-B)
HAG-REQ-S001: BMS functional safety shall achieve ASIL-B per ISO 26262. Safety-critical.
HAG-REQ-S002: Safe state shall be entered within 5 ms upon fault detection. Safety-critical.
  CHANGED from Rev 1.0: response time tightened from 10 ms to 5 ms.
HAG-REQ-S003: Redundant voltage measurement hardware required for ASIL decomposition.
  Safety-critical. Two independent measurement channels required.
HAG-REQ-S004: Hardware watchdog shall reset BMS within 50 ms on software fault. Safety-critical.
HAG-REQ-S005: Over-voltage disconnect shall be implemented in hardware (not software).
  Safety-critical. Disconnect threshold: 4.25 V per cell.

6. Interface Requirements
Refer to NOVA-IRS-002 for complete electrical and software interface specifications.
CAN bus: 500 kbps, CAN 2.0B. CAN-FD: 2 Mbps data phase (added Rev 2.0).
LIN bus (optional): version 2.1, 19.2 kbps.
Power supply: 12 V nominal from vehicle LV network.

7. Quality and Compliance
Applicable standards: ISO 9001:2015, IATF 16949:2016, VDA 6.3, ISO 21434:2021.
PPAP documentation required - Level 3 submission to Helios Automotive AG.
All requirements shall be verified per updated test plan NOVA-TR-003 Rev 2.

8. Document History
Rev 1.0 | 2024-01-15 | Initial release | T. Weber, Vertex Systems GmbH
Rev 2.0 | 2024-06-20 | Cybersecurity, accuracy, IP67, safe-state | T. Weber / S. Klaas
`;

// ── 3. NOVA-IRS-002 — Interface Requirements ────────────────────────────────
const IRS_002 = `
Interface Requirements Specification
Document ID: NOVA-IRS-002  Revision: 1.1  Date: 2024-02-28
Project: NOVA - Battery Management System (BMS) Module
Supplier: Vertex Systems GmbH   Customer: Helios Automotive AG
Classification: Confidential
Parent document: NOVA-SRS-001 (System Requirements Specification)

1. Scope
This document specifies all electrical, mechanical, and software interfaces of the NOVA BMS.
All interface requirements are derived from and traceable to NOVA-SRS-001.

2. CAN Bus Interface
VX-IRS-C001: BMS shall connect to vehicle CAN-H/CAN-L via 120-ohm termination resistor.
VX-IRS-C002: CAN baud rate: 500 kbps (nominal), switchable to 250 kbps for diagnostics.
VX-IRS-C003: CAN message 0x1A0 - SOC Broadcast.
  Byte 0-1: SOC value (0-1000, resolution 0.1%).
  Byte 2-3: Pack voltage (0-65535, resolution 0.01 V).
  Byte 4: Pack temperature (0-255, offset -40, resolution 1 degree C).
  Byte 5: Status flags (bit 0: charging, bit 1: fault, bit 2: balancing).
  Cycle time: 100 ms. See HAG-REQ-F004 in NOVA-SRS-001.
VX-IRS-C004: CAN message 0x1A1 - Cell Voltage Detailed.
  Bytes 0-7: Cell voltages 1-4 (16-bit each, resolution 1 mV).
  Cycle time: 500 ms.
VX-IRS-C005: CAN message 0x1B0 - Fault Code.
  Byte 0: Fault category (0=none, 1=voltage, 2=thermal, 3=comm, 4=hardware).
  Byte 1-2: Fault code (see DTC table in section 5).
  Byte 3: Severity (0=info, 1=warning, 2=critical).

3. LIN Bus Interface (Optional Diagnostic Extension)
VX-IRS-L001: LIN version 2.1. Baud rate: 19.2 kbps.
VX-IRS-L002: BMS acts as LIN slave. Diagnostic master: vehicle gateway ECU.
VX-IRS-L003: LIN frame 0x20: read individual cell voltages (cells 1-8 per frame).

4. Power Supply Interface
VX-IRS-P001: Supply voltage: 12 V nominal, range 9 V to 16 V. See HAG-REQ-P002.
VX-IRS-P002: Inrush current shall not exceed 2 A for more than 10 ms at power-up.
VX-IRS-P003: Reverse polarity protection required. Clamp diode minimum 40 V / 5 A.
VX-IRS-P004: BMS KL15 wake-up input: active high, 12 V logic, hysteresis 0.5 V.

5. Mechanical Interface
VX-IRS-M001: Connector: 48-pin sealed automotive connector. Mating half specified by OEM.
VX-IRS-M002: Mounting: 4x M6 screws, torque 8 Nm plus or minus 1 Nm.
VX-IRS-M003: Enclosure dimensions: 180 mm x 120 mm x 45 mm. Weight < 850 g.
VX-IRS-M004: IP protection class: IP54 (Rev 1.0) / IP67 (Rev 2.0 per HAG-REQ-P005).

6. Diagnostic Trouble Codes (DTC)
DTC 0x0101: Cell over-voltage. Threshold: > 4.25 V. Safety-critical.
DTC 0x0102: Cell under-voltage. Threshold: < 2.5 V. Safety-critical.
DTC 0x0201: Pack over-temperature. Threshold: > 60 degrees C. Safety-critical.
DTC 0x0202: Pack under-temperature. Threshold: < -40 degrees C.
DTC 0x0301: CAN bus communication loss. Timeout: > 200 ms.
DTC 0x0401: Watchdog reset occurred. Logged with timestamp.

7. Traceability
VX-IRS-C003 traces to HAG-REQ-F004 (NOVA-SRS-001).
VX-IRS-P001 traces to HAG-REQ-P002 (NOVA-SRS-001).
VX-IRS-M004 traces to HAG-REQ-P005 (NOVA-SRS-001).
All DTC definitions are inputs to NOVA-FMEA-004.

8. Document History
Rev 1.0 | 2024-01-30 | Initial release
Rev 1.1 | 2024-02-28 | Added DTC table, LIN details | S. Klaas
`;

// ── 4. NOVA-TR-003 — Test Report ─────────────────────────────────────────────
const TR_003 = `
Test Report - Battery Management System Module
Document ID: NOVA-TR-003  Revision: 1.0  Date: 2024-09-10
Project: NOVA  Product: BMS Module  Sample: Pre-production batch PP-001
Supplier: Vertex Systems GmbH   Customer: Helios Automotive AG
Test facility: Vertex Systems Test Lab, Building 3
Test engineer: M. Hartmann   Approved by: P. Reiter

1. Purpose
This report documents validation test results for the NOVA BMS module against
requirements defined in NOVA-SRS-001 Rev 2.0.

2. Test Configuration
Hardware revision: BMS-HW-Rev-C. Firmware: v2.1.4-rc3.
Test bench: BMS-TB-002 with programmable cell emulator (32 channels).
CAN analyzer: Protocol Analyzer Pro, calibrated 2024-08-01.
Temperature chamber: range -55 to +125 degrees C, calibration certificate TC-2024-083.

3. Functional Test Results
REQ-ID       | Test Case        | Result | Notes
HAG-REQ-F001 | Cell voltage mon | PASS   | Range 2.5-4.2 V verified, 32 cells
HAG-REQ-F002 | Voltage accuracy | PASS   | Max error: 3.2 mV (limit 5 mV)
HAG-REQ-F003 | Temp monitoring  | PASS   | 8 NTC sensors, all within spec
HAG-REQ-F004 | CAN SOC message  | PASS   | 0x1A0 verified, cycle time 98 ms avg
HAG-REQ-F005 | Balancing detect | PASS   | Threshold 50 mV confirmed
HAG-REQ-F006 | OT protection    | PASS   | Cutoff at 60.2 degrees C
HAG-REQ-F007 | ISO 15118        | PASS   | Basic communication verified
HAG-REQ-F008 | SOC accuracy     | PASS   | Max SOC error: 1.8% (limit 2%)
HAG-REQ-F009 | Fault logging    | PASS   | 2000 events stored, NVM verified
HAG-REQ-F010 | Wake-up time     | PASS   | 320 ms measured (limit 500 ms)
HAG-REQ-F011 | Cybersecurity    | PASS   | Secure boot, FW auth verified

4. Performance Test Results
REQ-ID       | Test Case        | Result | Notes
HAG-REQ-P001 | Cycle time       | PASS   | 7.3 ms (limit 10 ms)
HAG-REQ-P002 | Supply range     | PASS   | 8.5 V to 16.5 V tested
HAG-REQ-P003 | Quiescent curr   | PASS   | 380 microamp (limit 500 microamp)
HAG-REQ-P004 | MTBF analysis    | PASS   | Predicted 62,000 h per MIL-HDBK-217
HAG-REQ-P005 | IP67             | PASS   | Immersion test 1 m / 30 min passed

5. Safety Test Results
REQ-ID       | Test Case        | Result | Notes
HAG-REQ-S001 | ASIL-B assess    | PASS   | Third-party assessment by certification body
HAG-REQ-S002 | Safe state time  | PASS   | 3.8 ms measured (limit 5 ms)
HAG-REQ-S003 | Redundant meas   | PASS   | Channel separation confirmed
HAG-REQ-S004 | Watchdog test    | PASS   | Reset at 48 ms (limit 50 ms)
HAG-REQ-S005 | HW OV disconnect | PASS   | Disconnect at 4.23 V (limit 4.25 V)

6. Failed / Open Items
No failures in this test run.
Open item: EMC pre-compliance test scheduled 2024-10-15 (not yet complete).
Open item: Full software FMEA review against updated HAG-REQ-F011 pending.

7. Conclusion
All tested requirements PASS. BMS module approved for integration phase.
Sample PP-001 released for vehicle integration testing at Helios Automotive AG.
Full test report archived in document management system under NOVA-TR-003.
`;

// ── 5. NOVA-FMEA-004 — Failure Mode and Effects Analysis ────────────────────
const FMEA_004 = `
Failure Mode and Effects Analysis (FMEA)
Document ID: NOVA-FMEA-004  Revision: 1.2  Date: 2024-04-05
Project: NOVA - Battery Management System
Supplier: Vertex Systems GmbH   Customer: Helios Automotive AG
FMEA type: Design FMEA (D-FMEA). Reference: AIAG-VDA FMEA Handbook 1st Edition.
Parent requirement document: NOVA-SRS-001 Rev 2.0.
Classification: Confidential - Safety-critical document.

1. Scope
This FMEA covers all hardware and firmware failure modes of the NOVA BMS that could
result in hazardous events as defined by HARA (Hazard Analysis and Risk Assessment).
Safety goal SG-001: Prevent thermal runaway due to BMS failure.
Safety goal SG-002: Prevent vehicle loss of control due to unexpected power cutoff.

2. Failure Mode Table
FM-ID  | Component        | Failure Mode         | Effect            | Severity | RPN
F-001  | Cell voltage mon | Measurement drift    | Undetected OV     | 9        | 216
         Cause: ADC reference drift. Detection: Cross-check channel B.
         Current control: dual-channel measurement (HAG-REQ-S003).
         Recommended action: periodic self-calibration cycle.
F-002  | Temperature sens | NTC open circuit     | No OT protection  | 10       | 300
         Cause: connector vibration, corrosion. Detection: out-of-range check.
         Current control: HAG-REQ-S002 safe state on sensor fault.
         Recommended action: REDUCE - add redundant NTC per sensor point.
F-003  | Balancing circut | FET short circuit    | Cell overcharge   | 9        | 189
         Cause: ESD, overcurrent. Detection: continuous cell voltage monitoring.
         Current control: hardware OV disconnect (HAG-REQ-S005).
         Recommended action: ACCEPT with current controls.
F-004  | CAN transceiver  | Stuck dominant       | Bus lockup        | 7        | 168
         Cause: overvoltage, latch-up. Detection: CAN error counter.
         Current control: bus-off recovery procedure in firmware.
         Recommended action: add transceiver protection diode.
F-005  | Watchdog timer   | Watchdog disable     | Firmware hang     | 8        | 192
         Cause: software bug clears watchdog in ISR. Detection: HW watchdog.
         Current control: HAG-REQ-S004 hardware watchdog.
         Recommended action: code review and static analysis required.
F-006  | Power supply     | Undervoltage lockout | Unexpected reset  | 6        | 144
         Cause: load dump, cable resistance. Detection: supply voltage monitor.
         Current control: HAG-REQ-P002 range specification.
         Recommended action: ACCEPT.
F-007  | NV memory        | Write failure        | Lost fault log    | 4        | 48
         Cause: end-of-life write cycles. Detection: write verify.
         Current control: HAG-REQ-F009 minimum 2000 events spec.
         Recommended action: ACCEPT.

3. RPN Summary
High RPN (> 200): F-001 (216), F-002 (300). Safety-critical. Actions required.
Medium RPN (100-200): F-003 (189), F-004 (168), F-005 (192).
Low RPN (< 100): F-007 (48).
All items with Severity >= 9 require engineering review before SOP.

4. Action Items
AI-001: Implement self-calibration for ADC reference (F-001). Owner: HW team. Due: 2024-05-01.
AI-002: Add redundant NTC sensor per temperature measurement point (F-002).
  Owner: HW team. Due: 2024-05-15. Safety-critical. Escalation if delayed.
AI-003: Add transceiver protection diode on CAN lines (F-004). Due: 2024-06-01.
AI-004: Static analysis of watchdog code path (F-005). Due: 2024-04-30.

5. Document History
Rev 1.0 | 2024-02-10 | Initial FMEA baseline
Rev 1.1 | 2024-03-20 | F-002 severity updated, AI-002 added
Rev 1.2 | 2024-04-05 | All action items assigned, RPN table finalized
`;

// ── 6. NOVA-QA-005 — Supplier Audit Report ──────────────────────────────────
const QA_005 = `
Supplier Quality Audit Report
Document ID: NOVA-QA-005  Date: 2024-05-14
Audit type: Initial qualification audit (process audit VDA 6.3)
Supplier: Vertex Systems GmbH, Plant: Regensburg
Customer representative: Quality team, Helios Automotive AG
Lead auditor: C. Fischer   Co-auditor: B. Nguyen
Audit scope: NOVA BMS module, manufacturing and test processes.

1. Executive Summary
Overall audit result: 87 points out of 100 (threshold for conditional approval: 85).
Status: CONDITIONALLY APPROVED. Three major findings require corrective action.
Re-audit scheduled: 2024-08-15. Supplier must close all major findings before re-audit.

2. Process Audit Findings
Finding QA-F001: MAJOR. Traceability gap in incoming goods inspection.
  Observation: 12% of sampled incoming components lacked certificate of conformance.
  Required action: Implement 100% CoC check at goods receipt. Due: 2024-06-15.
  Reference: VDA 6.3 chapter P4.1.

Finding QA-F002: MAJOR. Test equipment calibration records incomplete.
  Observation: 2 out of 14 measurement devices lacked current calibration certificate.
  Required action: Complete calibration, update calibration management system.
  Due: 2024-05-31. Reference: IATF 16949 clause 7.1.5.

Finding QA-F003: MAJOR. FMEA not updated after design change in Rev 1.1.
  Observation: NOVA-FMEA-004 Rev 1.1 changes not reflected in control plan.
  Required action: Update control plan to reflect FMEA Rev 1.2. Due: 2024-06-01.
  Reference: AIAG-VDA FMEA Handbook, linkage requirement.

Finding QA-F004: MINOR. Operator training records for SMT line not current.
  Observation: 3 operators without documented soldering qualification re-certification.
  Required action: Schedule re-certification training. Due: 2024-07-01.

Finding QA-F005: MINOR. Kanban signal cards not consistently used on line 2.
  Observation: Visual management partially implemented.
  Required action: Refresh lean training. Due: 2024-07-15.

3. Positive Observations
Strong ESD protection measures throughout the production line.
Well-documented change management process (ECR system).
Test coverage greater than 98% functional coverage for BMS firmware tested on HIL bench.
5S implementation excellent in test area.

4. Corrective Action Plan
Supplier (Vertex Systems GmbH) must submit 8D report for all major findings
within 10 business days of this report (by 2024-05-28).

5. Re-audit Plan
Re-audit date: 2024-08-15. Focus areas: QA-F001, QA-F002, QA-F003 closure.
If findings not closed: escalation to sourcing decision review.

6. Conclusion
Vertex Systems GmbH demonstrates solid technical capability and quality awareness.
Conditional approval granted for prototype and pre-production phases of Project NOVA.
Serial production approval requires successful re-audit closure.
`;

// ── 7. NOVA-QA-006 — Deviation List ─────────────────────────────────────────
const QA_006 = `
Requirements Deviation List
Document ID: NOVA-QA-006  Revision: 1.0  Date: 2024-07-10
Project: NOVA - Battery Management System
Supplier: Vertex Systems GmbH   Customer: Helios Automotive AG
Reference document: NOVA-SRS-001 Rev 2.0
Classification: Confidential

1. Purpose
This document records all approved and pending deviations from NOVA-SRS-001 Rev 2.0.
Deviations require written approval from Helios Automotive AG quality engineering.

2. Deviation Table
DEV-ID  | REQ-ID       | Requirement                 | Deviation         | Status
DEV-001 | HAG-REQ-P005 | IP67 protection class       | IP54 acceptable   | APPROVED
         Justification: Integration area is protected from direct water ingress.
         Risk assessment: LOW. Valid until: SOP (2025-06-01).
         Approved by: R. Schmidt, Helios QE, 2024-06-30.

DEV-002 | HAG-REQ-F008 | SOC accuracy +/-2%          | +/-2.5% accepted  | PENDING
         Justification: Algorithm limitation in SW v2.1.x, fix in v2.2.
         Risk assessment: MEDIUM. Customer impact: range estimate slightly off.
         Requested by: Vertex Systems, 2024-07-08. Decision pending Helios review.

DEV-003 | HAG-REQ-P004 | MTBF >= 50,000 h            | 48,000 h predicted| APPROVED
         Justification: NTC sensor MTBF lower than predicted in early BOM.
         Risk assessment: LOW. Corrective: sensor upgraded in Rev D hardware.
         Approved by: R. Schmidt, Helios QE, 2024-07-05.

DEV-004 | HAG-REQ-F011 | Cybersecurity ISO 21434      | Partial compliance| OPEN
         Justification: Full ISO 21434 audit not complete (scheduled Q4 2024).
         Risk assessment: MEDIUM. Not safety-critical but regulatory risk.
         Requested: 2024-07-10. Escalation if not resolved by 2024-10-01.

3. Summary
Total deviations: 4. Approved: 2. Pending: 1. Open: 1.
No safety-critical deviations approved.
DEV-002 and DEV-004 require resolution before SOP release.
`;

// ── 8. TITAN — Chassis Spec (German, different project / supplier) ───────────
const TITAN_SRS = `
Technische Anforderungsspezifikation
Dokument-ID: TITAN-SRS-009  Revision: 1.0  Datum: 2024-03-01
Projekt: TITAN - Strukturkomponente Vorderachstraeger
Lieferant: Apex Components GmbH   Kunde: Helios Automotive AG
Klassifikation: Vertraulich

1. Geltungsbereich
Dieses Dokument definiert die technischen Anforderungen fuer den Vorderachstraeger
der TITAN-Plattform. Lieferant: Apex Components GmbH, Werk Ingolstadt.
Anwendbare Normen: ISO 9001:2015, IATF 16949:2016, VDA 6.3, DIN EN 10083-3.

2. Werkstoff- und Festigkeitsanforderungen
AC-REQ-M001: Werkstoff: Stahl 42CrMo4 gemaess DIN EN 10083-3.
  Zugfestigkeit: >= 900 MPa. Streckgrenze: >= 650 MPa.
AC-REQ-M002: Oberflaechenschutz: kathodische Tauchlackierung (KTL), Schichtdicke 20-25 mym.
AC-REQ-M003: Schweissnaehte gemaess DIN EN ISO 5817 Gueteklasse B.
  Sicherheitsrelevant. ZfP-Pruefung 100% fuer tragende Naehte erforderlich.

3. Geometrische Anforderungen
AC-REQ-G001: Allgemeintoleranz gemaess ISO 2768-m fuer unbemasste Masse.
AC-REQ-G002: Passung fuer Lageraufnahme: H7/p6. Sicherheitsrelevant.
AC-REQ-G003: Bauteilgewicht: 12.4 kg +/- 0.3 kg.
AC-REQ-G004: Einbaulage: per Zeichnung TITAN-DWG-009-A3.

4. Pruefanforderungen
AC-REQ-T001: Statischer Lasttest: Kraft 45 kN in Z-Richtung, 10 kN in X-Richtung.
  Sicherheitsrelevant. Kein Anriss zulassig.
AC-REQ-T002: Schwingfestigkeitspruefung: 10^7 Lastwechsel bei 60% Nennlast.
AC-REQ-T003: Korrosionsschutzpruefung: 480 h Salzspruehtest gemaess ISO 9227.
AC-REQ-T004: Masshaltigkeit: 3D-Koordinatenmessung 100% Erstmuster, 10% Serie.

5. Lieferanforderungen
AC-REQ-L001: Verpackung: Sonderladungstraeger TITAN-SLT-003, max. 8 Stueck/Lage.
AC-REQ-L002: Lieferschein muss Chargennummer und Seriennummernbereich enthalten.
AC-REQ-L003: PPAP Level 3, vollstaendige Zeichnungsfreigabe erforderlich.
AC-REQ-L004: Erstmusterlieferung: 5 Muster bis 2024-06-15.

6. Normenuebersicht
ISO 9001:2015 - Qualitaetsmanagementsystem
IATF 16949:2016 - Automotive Qualitaet
DIN EN 10083-3 - Verguetungsstaehle
DIN EN ISO 5817 - Schweissnahtguete
ISO 2768-m - Allgemeintoleranzen
ISO 9227 - Salzspruehtest

7. Aenderungshistorie
Rev 1.0 | 2024-03-01 | Erstausgabe | Autor: G. Huber, Helios Automotive AG
`;

// ── 9. TITAN — Deviation List (German) ──────────────────────────────────────
const TITAN_DEV = `
Abweichliste Technische Anforderungen
Dokument-ID: TITAN-DEV-010  Revision: 1.0  Datum: 2024-08-20
Projekt: TITAN - Vorderachstraeger
Lieferant: Apex Components GmbH   Kunde: Helios Automotive AG
Referenzdokument: TITAN-SRS-009 Rev 1.0

1. Zweck
Dieses Dokument erfasst alle beantragten und genehmigten Abweichungen von TITAN-SRS-009.

2. Abweichungstabelle
ABW-ID  | REQ-ID       | Anforderung              | Abweichung         | Status
ABW-001 | AC-REQ-M001  | Zugfestigkeit >= 900 MPa | 880 MPa Charge L47 | ABGELEHNT
         Begruendung: Werkstoff-Charge L47 Pruefzeugnis zeigt 880 MPa.
         Entscheidung: Charge L47 gesperrt, Ersatz erforderlich.
         Verantwortlich: G. Huber, Helios QE, 2024-08-18.

ABW-002 | AC-REQ-G003  | Gewicht 12.4 +/- 0.3 kg | 12.8 kg gemessen   | GENEHMIGT
         Begruendung: Schweissnaht-Zusatzwerkstoff leicht erhoehtes Gewicht.
         Risikoabschaetzung: GERING. Kein Einfluss auf Funktion oder Sicherheit.
         Genehmigt: R. Schmidt, Helios QE, 2024-08-15.

ABW-003 | AC-REQ-T003  | 480 h Salzspruehtest     | 360 h bis Erstmust.| GENEHMIGT
         Begruendung: Testkapazitaet beim Pruefinstitut begrenzt.
         Vollstaendiger Test fuer Serienfreigabe erforderlich.
         Genehmigt: R. Schmidt, Helios QE, 2024-08-10. Gueltig bis: Serienanlauf.

ABW-004 | AC-REQ-T001  | Kein Anriss bei 45 kN   | Haarriss Probe 3   | OFFEN
         Begruendung: Probe 3 von 5 zeigt Haarriss bei 43 kN.
         Sicherheitsrelevant. Eskalation erforderlich.
         Naechste Massnahme: FEM-Analyse und Schweissnaht-Optimierung.
         Frist: 2024-09-15. Eigentueamer: Apex Components GmbH.

3. Zusammenfassung
Gesamt: 4 Abweichungen. Genehmigt: 2. Abgelehnt: 1. Offen: 1.
ABW-004 ist sicherheitsrelevant und erfordert sofortige Bearbeitung.
ABW-001 und ABW-004 blockieren die Erstmusterfreigabe.
`;

// ── 10. Meeting Minutes ──────────────────────────────────────────────────────
const MEETING_MINUTES = `
Design Review Meeting Minutes
Project: NOVA - Battery Management System
Meeting date: 2024-07-18  Location: Helios Automotive AG, Conference Room B2
Attendees:
  Helios Automotive AG: P. Reiter (Project Lead), R. Schmidt (Quality), K. Meier (Integration)
  Vertex Systems GmbH: T. Weber (System Architect), S. Klaas (HW Lead), M. Hartmann (Test)
Moderator: P. Reiter    Minutes by: K. Meier
Document reference: NOVA-SRS-001 Rev 2.0, NOVA-FMEA-004 Rev 1.2

1. Opening and Agenda
Meeting opened at 09:00. Purpose: review status of NOVA BMS development against
milestone M3 (Pre-production readiness). Review open deviations from NOVA-QA-006.

2. Technical Status Update
T. Weber (Vertex Systems): BMS hardware Rev C complete. All HAG-REQ-S requirements met
per NOVA-TR-003 pre-release results. SW v2.1.4-rc3 stable on test bench.
Open: EMC pre-compliance test not yet executed (scheduled 2024-10-15).
Open: Full cybersecurity audit per ISO 21434 in progress, completion Q4 2024.

R. Schmidt raised concern about DEV-002 (SOC accuracy deviation).
Decision: DEV-002 accepted for PP phase only. Must be resolved before SOP.
Action AI-005: T. Weber to provide SOC algorithm improvement roadmap by 2024-08-01.

3. FMEA Review
M. Hartmann: NOVA-FMEA-004 Rev 1.2 reviewed. All AI actions from section 4 closed
except AI-001 (self-calibration implementation, due 2024-05-01 - DELAYED).
Revised due date for AI-001: 2024-09-15. Owner confirmed: HW team, T. Weber.
S. Klaas: NTC redundancy (AI-002) implemented in HW Rev C. Verified in NOVA-TR-003.

4. Quality Audit Follow-up
C. Fischer (auditor, by email): QA-F001 and QA-F002 closed per 8D report submitted.
QA-F003 (control plan update): in progress. Due 2024-06-01 OVERDUE.
Action AI-006: S. Klaas to submit updated control plan by 2024-07-25. ESCALATION if missed.

5. Integration Planning
K. Meier: Vehicle integration tests scheduled week of 2024-09-02.
BMS sample PP-001 released (per NOVA-TR-003 conclusion).
Prerequisite: IP67 test result required before vehicle integration. Currently IP54 only.
Decision: Proceed with integration under DEV-001 (IP54 waiver). IP67 required for SOP.

6. Open Action Items Summary
AI-005: SOC algorithm roadmap. Owner: T. Weber. Due: 2024-08-01.
AI-006: Control plan update. Owner: S. Klaas. Due: 2024-07-25. ESCALATED.
AI-001: ADC self-calibration. Owner: HW team (T. Weber). Due: 2024-09-15 (revised).
Existing AI-003, AI-004 from NOVA-FMEA-004: confirmed closed.

7. Next Meeting
Date: 2024-09-05 at 09:00. Agenda: EMC status, integration test kickoff, SOP readiness.

Meeting closed at 11:45.
`;

// ─────────────────────────────────────────────────────────────────────────────
// XLSX content
// ─────────────────────────────────────────────────────────────────────────────

const milestonesSheet = {
  name: "Project Milestones",
  rows: [
    ["Milestone ID", "Description", "Planned Date", "Actual Date", "Status", "Owner", "Remarks"],
    ["M1",  "Project Kickoff",             "2024-01-10", "2024-01-10", "COMPLETE",     "P. Reiter",   "On schedule"],
    ["M2",  "SRS Baseline (Rev 1.0)",      "2024-01-20", "2024-01-15", "COMPLETE",     "T. Weber",    "5 days early"],
    ["M3",  "IRS Baseline",                "2024-02-15", "2024-02-28", "COMPLETE",     "S. Klaas",    "13 days late - LIN spec added"],
    ["M4",  "FMEA Initial Baseline",       "2024-02-28", "2024-02-10", "COMPLETE",     "M. Hartmann", "Early release"],
    ["M5",  "HW Design Review (Rev A)",    "2024-03-15", "2024-03-20", "COMPLETE",     "S. Klaas",    "Minor delay"],
    ["M6",  "Supplier Quality Audit",      "2024-05-01", "2024-05-14", "COMPLETE",     "C. Fischer",  "Conditionally approved"],
    ["M7",  "HW Prototype (Rev B)",        "2024-04-30", "2024-05-10", "COMPLETE",     "S. Klaas",    "PCB re-spin needed"],
    ["M8",  "SRS Rev 2.0 Release",         "2024-06-15", "2024-06-20", "COMPLETE",     "T. Weber",    "Cybersec added"],
    ["M9",  "HW Pre-Production (Rev C)",   "2024-07-01", "2024-07-15", "COMPLETE",     "S. Klaas",    "IP67 pending"],
    ["M10", "Pre-production Test Report",  "2024-08-31", "2024-09-10", "COMPLETE",     "M. Hartmann", "All PASS"],
    ["M11", "Vehicle Integration Start",   "2024-09-02", "2024-09-02", "IN PROGRESS",  "K. Meier",    "IP54 waiver active"],
    ["M12", "EMC Pre-compliance",          "2024-10-15", "",           "PLANNED",      "M. Hartmann", "Lab slot reserved"],
    ["M13", "ISO 21434 Cybersec Audit",    "2024-12-01", "",           "PLANNED",      "T. Weber",    "External auditor TBD"],
    ["M14", "Production Approval (PPAP)",  "2025-03-01", "",           "PLANNED",      "R. Schmidt",  "Pending all closures"],
    ["M15", "Start of Production (SOP)",   "2025-06-01", "",           "PLANNED",      "P. Reiter",   "Target date"],
  ],
};

const gateStatusSheet = {
  name: "Gate Status",
  rows: [
    ["Gate", "Criteria", "Status", "Blocking Issues"],
    ["G1 - Concept",     "SRS baseline, FMEA started",       "PASSED",      "None"],
    ["G2 - Design",      "FMEA complete, HW design reviewed", "PASSED",      "None"],
    ["G3 - Pre-prod",    "PP test pass, audit conditional",   "PASSED",      "IP67 waiver, SOC deviation open"],
    ["G4 - Integration", "Vehicle test complete, EMC pass",   "IN PROGRESS", "EMC pending, ISO 21434 pending"],
    ["G5 - SOP",         "PPAP approved, all deviations closed", "NOT STARTED", "Multiple open items"],
  ],
};

const riskSheet = {
  name: "Risk Register",
  rows: [
    ["Risk ID", "Description", "Category", "Probability", "Impact", "Score", "Mitigation", "Owner", "Status"],
    ["R-001", "SOC algorithm accuracy below spec",         "Technical",  "High",   "Medium", "12", "SW fix in v2.2 targeted Q4",  "T. Weber",   "OPEN - DEV-002"],
    ["R-002", "ISO 21434 audit failure / late completion", "Compliance", "Medium", "High",   "12", "External consultant engaged",  "T. Weber",   "OPEN - monitoring"],
    ["R-003", "NTC redundancy cost increase",              "Cost",       "Low",    "Medium", "4",  "Redesign absorbed in HW Rev C","S. Klaas",   "CLOSED"],
    ["R-004", "EMC failure requiring PCB re-spin",         "Technical",  "Medium", "High",   "12", "Early pre-compliance test",    "M. Hartmann","OPEN - test pending"],
    ["R-005", "Supplier audit major findings not closed",  "Quality",    "Low",    "High",   "8",  "Re-audit scheduled Aug 2024",  "R. Schmidt", "CLOSED - re-audit pass"],
    ["R-006", "CAN-FD integration issue with gateway ECU", "Interface",  "Medium", "Medium", "9",  "Joint integration test Sept",  "K. Meier",   "OPEN - in progress"],
    ["R-007", "IP67 housing not ready for SOP",            "Design",     "Low",    "Medium", "4",  "IP67 housing Rev D planned",   "S. Klaas",   "OPEN - DEV-001 waiver"],
    ["R-008", "TITAN chassis deviation ABW-004 unresolved","Safety",     "Medium", "High",   "12", "FEM analysis by Apex",         "G. Huber",   "OPEN - safety-critical"],
    ["R-009", "Key supplier single-source for ADC chip",   "Supply",     "Low",    "High",   "8",  "Dual-source qualification",    "P. Reiter",  "OPEN - action Q1 2025"],
    ["R-010", "Documentation delays PPAP submission",      "Process",    "Low",    "Low",    "2",  "Doc tracker established",      "R. Schmidt", "CLOSED"],
  ],
};

const issuesSheet = {
  name: "Open Issues",
  rows: [
    ["Issue ID", "Title", "Type", "Priority", "Raised By", "Date", "Due", "Assignee", "Status"],
    ["ISS-001", "Control plan not updated per FMEA Rev 1.2",  "Quality",   "HIGH",     "C. Fischer",  "2024-05-14", "2024-06-01", "S. Klaas",   "OVERDUE"],
    ["ISS-002", "DEV-002 SOC accuracy roadmap required",       "Technical", "HIGH",     "P. Reiter",   "2024-07-18", "2024-08-01", "T. Weber",   "IN PROGRESS"],
    ["ISS-003", "EMC pre-compliance test not scheduled",       "Testing",   "MEDIUM",   "M. Hartmann", "2024-07-18", "2024-10-15", "M. Hartmann","PLANNED"],
    ["ISS-004", "ADC self-calibration implementation (AI-001)","Technical", "MEDIUM",   "M. Hartmann", "2024-04-05", "2024-09-15", "T. Weber",   "DELAYED"],
    ["ISS-005", "TITAN ABW-004 safety escalation",             "Safety",    "CRITICAL", "G. Huber",    "2024-08-20", "2024-09-15", "Apex Eng.",  "OPEN"],
    ["ISS-006", "ISO 21434 full audit completion",             "Compliance","HIGH",     "T. Weber",    "2024-06-20", "2024-12-01", "T. Weber",   "IN PROGRESS"],
    ["ISS-007", "CAN-FD gateway compatibility test pending",   "Interface", "MEDIUM",   "K. Meier",    "2024-07-18", "2024-09-15", "K. Meier",   "PLANNED"],
    ["ISS-008", "IP67 housing design for SOP",                 "Design",    "LOW",      "S. Klaas",    "2024-07-15", "2025-03-01", "S. Klaas",   "PLANNED"],
    ["ISS-009", "Dual-source ADC qualification",               "Supply",    "MEDIUM",   "P. Reiter",   "2024-08-01", "2025-01-15", "P. Reiter",  "OPEN"],
    ["ISS-010", "Vertex re-audit closure confirmation",        "Quality",   "HIGH",     "R. Schmidt",  "2024-05-14", "2024-08-15", "R. Schmidt", "CLOSED - passed"],
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Write all files
// ─────────────────────────────────────────────────────────────────────────────

const NOVA_REQ  = join(BASE, "Helios-Automotive-AG/Project-NOVA/Requirements");
const NOVA_TEST = join(BASE, "Helios-Automotive-AG/Project-NOVA/Testing");
const NOVA_QA   = join(BASE, "Helios-Automotive-AG/Project-NOVA/Quality");
const NOVA_PLAN = join(BASE, "Helios-Automotive-AG/Project-NOVA/Planning");
const TITAN     = join(BASE, "Helios-Automotive-AG/Project-TITAN");
const INTERNAL  = join(BASE, "InternalDocs");

// PDFs
writeFileSync(join(NOVA_REQ,  "NOVA-SRS-001-SystemRequirements-v1.pdf"),         buildPdf(SRS_001_V1, 4));
writeFileSync(join(NOVA_REQ,  "NOVA-SRS-001-SystemRequirements-v2.pdf"),         buildPdf(SRS_001_V2, 4));
writeFileSync(join(NOVA_REQ,  "NOVA-IRS-002-InterfaceRequirements.pdf"),         buildPdf(IRS_002,    3));
writeFileSync(join(NOVA_TEST, "NOVA-TR-003-TestReport-BMS.pdf"),                 buildPdf(TR_003,     3));
writeFileSync(join(NOVA_TEST, "NOVA-FMEA-004-FailureModeAnalysis.pdf"),          buildPdf(FMEA_004,   3));
writeFileSync(join(NOVA_QA,   "NOVA-QA-005-SupplierAuditReport.pdf"),            buildPdf(QA_005,     3));
writeFileSync(join(NOVA_QA,   "NOVA-QA-006-DeviationList.pdf"),                  buildPdf(QA_006,     2));
writeFileSync(join(TITAN,     "TITAN-SRS-009-ChassisSpec-DE.pdf"),               buildPdf(TITAN_SRS,  3));
writeFileSync(join(TITAN,     "TITAN-DEV-010-Abweichliste-DE.pdf"),              buildPdf(TITAN_DEV,  2));
writeFileSync(join(INTERNAL,  "MeetingMinutes-NOVA-DesignReview-2024-07-18.pdf"),buildPdf(MEETING_MINUTES, 3));
writeFileSync(join(INTERNAL,  "Scanned-Drawing-BatteryPack-Housing.pdf"),        buildScannedPdf());

// XLSX
writeFileSync(join(NOVA_PLAN, "NOVA-PLAN-007-ProjectMilestones.xlsx"),
  buildXlsx([milestonesSheet, gateStatusSheet]));
writeFileSync(join(NOVA_PLAN, "NOVA-PLAN-008-RiskRegister.xlsx"),
  buildXlsx([riskSheet]));
writeFileSync(join(NOVA_PLAN, "NOVA-OPEN-009-IssueTracker.xlsx"),
  buildXlsx([issuesSheet]));

console.log("Test corpus created:");
console.log(`  ${NOVA_REQ}/NOVA-SRS-001-SystemRequirements-v1.pdf  (SRS v1 - version pair A)`);
console.log(`  ${NOVA_REQ}/NOVA-SRS-001-SystemRequirements-v2.pdf  (SRS v2 - version pair B)`);
console.log(`  ${NOVA_REQ}/NOVA-IRS-002-InterfaceRequirements.pdf  (cross-refs to SRS+FMEA)`);
console.log(`  ${NOVA_TEST}/NOVA-TR-003-TestReport-BMS.pdf         (table-heavy, all PASS)`);
console.log(`  ${NOVA_TEST}/NOVA-FMEA-004-FailureModeAnalysis.pdf  (safety-critical, RPN table)`);
console.log(`  ${NOVA_QA}/NOVA-QA-005-SupplierAuditReport.pdf      (narrative audit findings)`);
console.log(`  ${NOVA_QA}/NOVA-QA-006-DeviationList.pdf            (structured deviations)`);
console.log(`  ${TITAN}/TITAN-SRS-009-ChassisSpec-DE.pdf           (German language)`);
console.log(`  ${TITAN}/TITAN-DEV-010-Abweichliste-DE.pdf          (German deviation list)`);
console.log(`  ${INTERNAL}/MeetingMinutes-NOVA-DesignReview-2024-07-18.pdf  (narrative)`);
console.log(`  ${INTERNAL}/Scanned-Drawing-BatteryPack-Housing.pdf (low-text / OCR-needed)`);
console.log(`  ${NOVA_PLAN}/NOVA-PLAN-007-ProjectMilestones.xlsx   (2 sheets: milestones + gates)`);
console.log(`  ${NOVA_PLAN}/NOVA-PLAN-008-RiskRegister.xlsx        (risk matrix)`);
console.log(`  ${NOVA_PLAN}/NOVA-OPEN-009-IssueTracker.xlsx        (issue tracker)`);
