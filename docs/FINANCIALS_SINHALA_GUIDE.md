# Sinhala Financials visual guide

Created on 2026-11-05 for the user's request for a simple, detailed Sinhala guide with examples and visual explanations.

Deliverable: [DMS Financials Sinhala Visual Guide - restored](../output/pdf/DMS_Financials_Sinhala_Visual_Guide_Restored.pdf).

On 2026-11-06 the original PDF had changed to 1,560,763 bytes; its first page content stream produced a zlib decoding error and no extractable text, reproducing the reported blank page. The cause of that file modification was not established. A separate restored copy was generated from the intact HTML source, preserving the damaged file. All 23 restored pages were rendered and visually reviewed; Sinhala text, A4 sizes, layout and navigation bookmarks passed checks. No PMS application code or financial records were changed for this repair.

The guide has 23 A4 pages and navigation bookmarks. It covers the existing Financials modules, their Financials 2 equivalents, amounts and status colors, partial payments, credit notes, refunds, original payment selection, current withdrawal approvals, supplier bills, expenses, payables, receivables, cash summaries, Profit & Loss, integrations, permissions, and a complete worked booking example.

The document describes the implementation checked at the creation date, including existing limitations. It does not mean the Night Audit ledger/revenue/tax issues have been fixed. Financials and Financials 2 use the same records; training examples should use test records. Illustrations and the isolated UI screenshot use example/QA data. No live financial records were changed to produce this guide.

Validation: all 23 pages rendered and visually reviewed; Sinhala fonts embedded; A4 page sizes, text extraction, navigation bookmarks and page overflow checked.

Authoring source: `tmp/pdfs/build_financials_sinhala.py`. HTML source: `output/pdf/DMS_Financials_Sinhala_Visual_Guide.html`. Browser export: `tmp/pdfs/print_financials_pdf.cjs`. PDF verification: `tmp/pdfs/verify_financials_pdf.py`. Bookmark/metadata finalization: `tmp/pdfs/finalize_financials_pdf.py`. Regenerate in that order with a Python interpreter that can load the packages in `tmp/pdfs/deps`, then repeat visual QA.
