import { App } from 'electron';
import { withPrintWindow } from './printWindow';

export async function saveHtmlAsPdf(
  html: string,
  app: App,
  width: number, // centimeters
  height: number // centimeters
): Promise<Buffer> {
  const printOptions = {
    margins: { top: 0, bottom: 0, left: 0, right: 0 }, // equivalent to previous 'marginType: 1'
    pageSize: {
      height: height / 2.54, // Convert from centimeters to inches
      width: width / 2.54, // Convert from centimeters to inches
    },
    printBackground: true,
  };

  return withPrintWindow(html, app, width, height, (window) =>
    window.webContents.printToPDF(printOptions)
  );
}
