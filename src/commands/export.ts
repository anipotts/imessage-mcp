// export — specialized exports (evidence bundle)

import { buildEvidenceBundle, recordsToCsv } from "../evidence.js";

type ExportFormat = "json" | "jsonl" | "csv" | "pdf";

interface ExportOptions {
  bundle: "evidence";
  format: ExportFormat;
  contact?: string;
  from?: string;
  to?: string;
  sinceRowid?: number;
  limit?: number;
  includeText: boolean;
}

function parseFormat(raw: string | undefined): ExportFormat {
  const normalized = (raw || "json").toLowerCase();
  if (normalized === "json" || normalized === "jsonl" || normalized === "csv" || normalized === "pdf") {
    return normalized;
  }
  return "json";
}

function parseArgs(): ExportOptions {
  const args = process.argv.slice(3); // skip node, script, export
  const opts: ExportOptions = {
    bundle: "evidence",
    format: "json",
    includeText: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--bundle":
        opts.bundle = (args[++i] as "evidence") || "evidence";
        break;
      case "--format":
        opts.format = parseFormat(args[++i]);
        break;
      case "--contact":
        opts.contact = args[++i];
        break;
      case "--from":
        opts.from = args[++i];
        break;
      case "--to":
        opts.to = args[++i];
        break;
      case "--since-rowid":
        opts.sinceRowid = parseInt(args[++i], 10);
        break;
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
      case "--include-text":
        opts.includeText = true;
        break;
      case "--help":
      case "-h":
        console.log(`
imessage-mcp export — specialized bundle exports

Usage:
  imessage-mcp export --bundle evidence [options]

Options:
  --bundle evidence      Export an evidence bundle
  --format <fmt>         json|jsonl|csv|pdf (default: json)
  --contact <query>      Filter by contact
  --from <date>          Start date (YYYY-MM-DD)
  --to <date>            End date (YYYY-MM-DD)
  --since-rowid <n>      Incremental lower bound
  --limit <n>            Max records
  --include-text         Include message text in records
`);
        process.exit(0);
    }
  }

  return opts;
}

async function writePdf(bundle: ReturnType<typeof buildEvidenceBundle>): Promise<void> {
  const mod = await import("pdfkit");
  const PDFDocument = (mod as any).default ?? (mod as any);
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(process.stdout);

  doc.fontSize(16).text("iMessage Evidence Bundle", { underline: true });
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(`Generated: ${bundle.generated_at}`);
  doc.text(`Records: ${bundle.record_count}`);
  doc.text(`Manifest hash (sha256): ${bundle.checksums.manifest_hash}`);
  doc.moveDown(0.5);
  doc.text(`Filters: ${JSON.stringify(bundle.filters)}`);
  doc.moveDown(1);

  const preview = bundle.records.slice(0, 200);
  for (const row of preview) {
    doc.fontSize(9).text(`[${row.rowid}] ${row.date} ${row.contact_name || row.handle || "(unknown)"}`);
    if (row.text) {
      doc.fontSize(8).text(`  ${row.text}`);
    }
    doc.moveDown(0.3);
  }

  if (bundle.records.length > preview.length) {
    doc.moveDown(0.5);
    doc.fontSize(9).text(`... ${bundle.records.length - preview.length} additional records omitted from PDF preview.`);
  }

  doc.end();
}

async function run(): Promise<void> {
  const opts = parseArgs();
  if (opts.bundle !== "evidence") {
    throw new Error(`Unsupported bundle "${opts.bundle}". Supported: evidence`);
  }

  const bundle = buildEvidenceBundle({
    contact: opts.contact,
    date_from: opts.from,
    date_to: opts.to,
    since_rowid: opts.sinceRowid,
    include_text: opts.includeText,
    limit: opts.limit,
  });

  if (opts.format === "jsonl") {
    for (const row of bundle.records) {
      process.stdout.write(`${JSON.stringify(row)}\n`);
    }
    process.stdout.write(`${JSON.stringify({ _manifest: bundle.checksums })}\n`);
    return;
  }

  if (opts.format === "csv") {
    process.stdout.write(recordsToCsv(bundle.records));
    return;
  }

  if (opts.format === "pdf") {
    await writePdf(bundle);
    return;
  }

  process.stdout.write(JSON.stringify(bundle, null, 2));
}

await run();

