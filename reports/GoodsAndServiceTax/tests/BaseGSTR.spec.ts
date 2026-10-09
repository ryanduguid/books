import type { Fyo } from 'fyo';
import type { Invoice } from 'models/baseModels/Invoice/Invoice';
import Module from 'module';
import { getMoneyMaker } from 'pesa';
import tape from 'tape';
import { parseCSV } from 'utils/csvParser';
import { GSTRRow } from '../types';

const fyo = {
  format: (value: unknown) => String(value),
  singles: { SystemSettings: { displayPrecision: 2 } },
} as unknown as Fyo;

// Replace app-only imports while loading the reports in Electron's Node runner.
const uiPaths = ['src/utils/ui', 'src/utils/interactive', 'src/initFyo'].map(
  (path) => require.resolve(path)
);
const cachedUI = uiPaths.map((path) => require.cache[path]);
function unexpectedUI() {
  throw new Error('GST report tests must not open browser dialogs');
}
for (const path of uiPaths) {
  const stub = new Module(path);
  stub.exports = {
    fyo,
    getSavePath: unexpectedUI,
    showExportInFolder: unexpectedUI,
    showDialog: unexpectedUI,
  };
  require.cache[path] = stub;
}
let GSTR1: typeof import('../GSTR1').GSTR1;
let GSTR2: typeof import('../GSTR2').GSTR2;
let getCsvData: typeof import('reports/commonExporter').getCsvData;
try {
  ({ GSTR1 } = require('../GSTR1'));
  ({ GSTR2 } = require('../GSTR2'));
  ({ getCsvData } = require('reports/commonExporter'));
} finally {
  uiPaths.forEach((path, index) => {
    if (cachedUI[index]) {
      require.cache[path] = cachedUI[index];
    } else {
      delete require.cache[path];
    }
  });
}

const money = getMoneyMaker({ currency: 'INR' });

function row(): GSTRRow {
  return {
    gstin: '',
    partyName: 'Test party',
    invNo: 'Test invoice',
    invDate: new Date('2026-01-01T00:00:00Z'),
    rate: 0,
    reverseCharge: 'N',
    inState: true,
    place: '',
    invAmt: 1000,
    taxVal: 1000,
  };
}

function invoice(taxes?: { account: string; rate: number }[]): Invoice {
  return { netTotal: money(1000), taxes } as unknown as Invoice;
}

const categories = [
  { account: 'IGST', rate: 18, changes: { igstAmt: 180, inState: false } },
  { account: 'CGST', rate: 9, changes: { cgstAmt: 90 } },
  { account: 'SGST', rate: 9, changes: { sgstAmt: 90 } },
  { account: 'Nil Rated', rate: 0, changes: { nilRated: true } },
  { account: 'Exempt', rate: 0, changes: { exempt: true } },
  { account: 'Non GST', rate: 0, changes: { nonGST: true } },
];

for (const Report of [GSTR1, GSTR2]) {
  for (const { account, rate, changes } of categories) {
    tape(`${Report.title}: ${account} updates only its category`, (t) => {
      const report = new Report(fyo);
      const actual = {
        ...row(),
        igstAmt: 101,
        cgstAmt: 102,
        sgstAmt: 103,
        nilRated: false,
        exempt: false,
        nonGST: false,
      };
      const expected = { ...actual, rate, ...changes };

      // Zero-category summaries are direct method inputs, not fresh invoices.
      report.setTaxValuesOnGSTRRow(invoice([{ account, rate }]), actual);
      t.deepEqual(actual, expected);
      t.end();
    });
  }

  for (const taxes of [
    [
      { account: 'CGST', rate: 9 },
      { account: 'SGST', rate: 9 },
    ],
    [
      { account: 'SGST', rate: 7 },
      { account: 'CGST', rate: 5 },
    ],
    [
      { account: 'CGST', rate: 5 },
      { account: 'Custom Levy', rate: 2 },
      { account: 'SGST', rate: 7 },
    ],
  ]) {
    tape(
      `${Report.title}: processes ${taxes.map((tax) => tax.account)}`,
      (t) => {
        const actual = row();
        new Report(fyo).setTaxValuesOnGSTRRow(invoice(taxes), actual);
        t.deepEqual(actual, {
          ...row(),
          rate: taxes.reduce((sum, tax) => sum + tax.rate, 0),
          cgstAmt: taxes[0].rate === 9 ? 90 : 50,
          sgstAmt: taxes[0].rate === 9 ? 90 : 70,
        });
        t.end();
      }
    );
  }

  tape(`${Report.title}: absent summaries leave the row unchanged`, (t) => {
    for (const taxes of [undefined, []]) {
      const actual = row();
      new Report(fyo).setTaxValuesOnGSTRRow(invoice(taxes), actual);
      t.deepEqual(actual, row());
    }
    t.end();
  });

  tape(`${Report.title}: preserves a negative matching amount`, (t) => {
    const actual = row();
    new Report(fyo).setTaxValuesOnGSTRRow(
      invoice([{ account: 'CGST', rate: -3 }]),
      actual
    );
    t.deepEqual(actual, { ...row(), rate: -3, cgstAmt: -30 });
    t.end();
  });

  for (const { taxes, amounts, csv } of [
    {
      taxes: [{ account: 'IGST', rate: 18 }],
      amounts: [180, undefined, undefined],
      csv: ['180', '', ''],
    },
    {
      taxes: [
        { account: 'CGST', rate: 9 },
        { account: 'SGST', rate: 9 },
      ],
      amounts: [undefined, 90, 90],
      csv: ['', '90', '90'],
    },
  ]) {
    tape(
      `${Report.title}: tax heads reach report and CSV separately`,
      async (t) => {
        const report = new Report(fyo);
        const actual = row();
        report.setTaxValuesOnGSTRRow(invoice(taxes), actual);
        report.columns = (await report.getColumns()).filter((column) =>
          ['igstAmt', 'cgstAmt', 'sgstAmt'].includes(column.fieldname)
        );
        report.reportData = report.getReportDataFromGSTRRows([actual]);

        t.deepEqual(
          report.reportData[0].cells.map((cell) => cell.rawValue),
          amounts
        );
        t.deepEqual(parseCSV(getCsvData(report))[1], csv);
        t.end();
      }
    );
  }
}
